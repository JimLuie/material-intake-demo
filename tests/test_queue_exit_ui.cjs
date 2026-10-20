'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'../public',name),'utf8');
function ui(){
  const nodes=new Map(),calls=[],get=s=>{
    if(!nodes.has(s))nodes.set(s,{value:'',textContent:'',innerHTML:'',dataset:{},hidden:false,disabled:false,scrollTop:0,parentElement:{scrollTop:0},
      showModal(){this.open=true;},close(){this.open=false;},addEventListener(){},replaceChildren(){},focus(){}});
    return nodes.get(s);
  };
  const ctx=vm.createContext({console,structuredClone,Map,WeakMap,Set,Promise,Math,Number,JSON,Date,setTimeout,clearTimeout,
    document:{querySelector:get,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},localStorage:{getItem(){return null;}},location:{hash:'upload'},
    toast:m=>calls.push(m),badge:s=>s,renderReviewWorkspace:d=>calls.push({editor:d?.id||null}),setQueueOpen:open=>calls.push({drawer:open}),
    renderPool(){},updateCounts(){},clearConnectionIssue(){},updateMaterialCatalog:()=>false,renderSupplierFilters(){},renderTable(){},refreshRecordAnalysisDetail(){},renderTemplates(){},renderSearch:async()=>{},
    flushDraft:async()=>calls.push('draft'),refresh:async()=>true,
    api:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {document:{id:'a',bucket:'review',organization_version:1,content_version:0,organization:{},pages:[]}};},
  });
  const app=source('app.js');
  vm.runInContext(source('state.js')+'\n'+source('billing.js')+'\n'+source('ui.js')+'\n'+app.slice(app.indexOf('const localDrafts'),app.indexOf('function toast(')),ctx);
  vm.runInContext(source('workflow.js')+'\n'+source('organization.js'),ctx);
  vm.runInContext(app.slice(app.indexOf('function documentDraft('),app.indexOf('function blankItem('))+app.slice(app.indexOf('function renderUpload('),app.indexOf('function updateCalc(')),ctx);
  const run=s=>vm.runInContext(s,ctx);
  run(`function fixture(id,status='pending',bucket='materials'){return {id,status,bucket,name:id+'.jpg',record_count:0,organization_version:0,content_version:0,organization:{},pages:[],draft:{meta:{doc:id,sup:'hh'},items:[{label:'S50C',dims:[8,88,178],qty:19,price:130,amount:2470}]}}};queue=[fixture('a'),fixture('b'),fixture('c','done')];state.view='upload';state.qSel='a';renderPool=()=>{};`);
  return {ctx,get,calls,run,app};
}
function loadRefresh(u){u.run(u.app.slice(u.app.indexOf('async function refresh('),u.app.indexOf('function renderSupplierFilters')));}
function loadFlush(u){u.run(u.app.slice(u.app.indexOf('async function flushDraft('),u.app.indexOf('async function refresh(')));}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('all queue filters, search, counts and next-pending exclude pool and trash',()=>{
  const u=ui();u.run(`queue=[fixture('a'),fixture('pool','pending','review'),fixture('trash','error','trash'),fixture('c','done'),fixture('run','queued')];`);
  assert.equal(u.run('queueCounts(queue).all'),3);assert.equal(u.run('queueCounts(queue).pending'),1);assert.equal(u.run('queueCounts(queue).processing'),1);assert.equal(u.run('queueCounts(queue).error'),0);
  for(const filter of ['all','pending','processing','error'])for(const term of ['pool','trash'])assert.equal(u.run(`filteredQueue(queue,'${filter}','${term}',SUP).length`),0);
  assert.equal(u.run("nextPending(queue,'a')"),null);
});
test('selection reconciles a departed invoice, wraps, ignores filters and resumes first outstanding line',()=>{
  const u=ui();u.run(`queue=[fixture('b'),fixture('done','done'),fixture('a','pending','review')];state.queueSearch='no-match';state.queueFilter='error';
    queue[0].draft.items.push({...queue[0].draft.items[0]});var p=reviewProgress(queue[0].draft);p.items[0]=reviewItemSignature(queue[0].draft.items[0]);queue[0].draft.review_progress=p;renderUpload();`);
  assert.equal(u.run('state.qSel'),'b');assert.equal(u.run('state.item'),1);assert.equal(u.calls.at(-1).editor,'b');assert.equal(u.get('#queueMatches').textContent,'顯示 0 份搜尋結果');
  assert.ok(u.calls.some(c=>c.drawer===false));
});
test('last pending disappears without opening a confirmed invoice; confirmed invoices stay manually selectable',()=>{
  const u=ui();u.run("queue=[fixture('a','pending','review'),fixture('done','done')];renderUpload()");
  assert.equal(u.run('state.qSel'),null);assert.equal(u.calls.at(-1).editor,null);
  u.run("renderUpload();selectReviewDocument('done')");assert.equal(u.run('state.qSel'),'done');assert.equal(u.calls.filter(c=>c.editor!==undefined).at(-1).editor,'done');
  assert.equal(u.run("selectReviewDocument('a')"),false);assert.equal(u.run('state.qSel'),'done');
});
test('reload and returning to upload never select a pooled invoice; restored materials become pending candidates',()=>{
  const u=ui();u.run("queue=[fixture('a','pending','review'),fixture('done','done')];state.qSel=null;renderUpload()");assert.equal(u.run('state.qSel'),null);
  u.run("state.qSel='a';renderUpload()");assert.equal(u.run('state.qSel'),null);
  u.run("queue[0].bucket='materials';queue[0].organization_version=2;renderUpload()");assert.equal(u.run('state.qSel'),'a');
});
test('successful park waits for fresh state then stays on upload and opens next pending despite continuous-off',async()=>{
  const u=ui();await u.run("requestOrganize('a','park')");let release;
  u.ctx.refresh=()=>new Promise(resolve=>release=resolve);u.run('continuousReview=false');
  const task=u.run('submitOrganization()');await tick();
  assert.equal(u.run('state.qSel'),null);assert.equal(u.calls.at(-1).editor,null);assert.equal(u.run('location.hash'),'upload');
  release(true);await task;
  assert.equal(u.run('state.qSel'),'b');assert.equal(u.run('state.view'),'upload');assert.equal(u.run('location.hash'),'upload');assert.equal(u.run('reviewMovePending'),null);
});
test('move failure retains current selection, local inputs and dialog; no forced continuation',async()=>{
  const u=ui();u.run("documentDraft('a').items[0].note='keep'");await u.run("requestOrganize('a','park')");u.ctx.api=async()=>{throw Error('搬移失敗');};await u.run('submitOrganization()');
  assert.equal(u.run('state.qSel'),'a');assert.equal(u.run("documentDraft('a').items[0].note"),'keep');assert.equal(u.get('#organizeDialog').open,true);assert.match(u.get('#organizeError').textContent,/搬移失敗/);
});
test('committed move plus failed list hides old editor and retries only read, including after cancelling dialog',async()=>{
  const u=ui();await u.run("requestOrganize('a','park')");u.ctx.refresh=async()=>{throw Error('offline');};await u.run('submitOrganization()');
  assert.equal(u.run('state.qSel'),null);assert.equal(u.calls.filter(c=>c.editor!==undefined).at(-1).editor,null);assert.match(u.get('#organizeError').textContent,/已保存，清單更新失敗/);
  u.run("organizationRequest=null;renderOrganizationNotice(null)");assert.match(u.get('#reviewOrganization').innerHTML,/重試更新清單/);
  u.ctx.refresh=async()=>true;await u.run("refreshOrganizationRecovery('a')");assert.equal(u.calls.filter(c=>c.url).length,1);assert.equal(u.run('state.qSel'),'b');assert.equal(u.run('organizationRecovery.size'),0);
});
test('manual selection or leaving during delayed move cancels continuation without resurrecting old form',async()=>{
  for(const action of ["selectReviewDocument('c')","state.view='search';state.reviewGeneration++;location.hash='search'"]){
    const u=ui();await u.run("requestOrganize('a','park')");let release;
    u.ctx.api=()=>new Promise(resolve=>release=resolve);const task=u.run('submitOrganization()');await tick();u.run(action);
    release({document:{id:'a',bucket:'review',organization_version:1,organization:{},pages:[]}});await task;
    if(u.run('state.view')==='upload')assert.equal(u.run('state.qSel'),'c');else assert.equal(u.run('location.hash'),'search');
  }
});
test('background move cancels autosave, retains complete unsaved input and clears old editor on the same state refresh',async()=>{
  const u=ui();loadRefresh(u);u.run("documentDraft('a').items[0].note='unsaved <draft>';dirty.add('a');saveTimers.set('a',setTimeout(()=>{},10000));");
  u.ctx.api=async()=>({suppliers:{},records:[],documents:u.run("[Object.assign(fixture('a'),{bucket:'review',organization_version:1}),fixture('b'),fixture('c','done')]")});
  await u.run('refresh(true,{strict:true})');assert.equal(u.run('state.qSel'),'b');assert.equal(u.run("saveTimers.has('a')"),false);assert.equal(u.run("dirty.has('a')"),true);
  assert.equal(u.run("detachedReviewDrafts.get('a').draft.items[0].note"),'unsaved <draft>');assert.throws(()=>u.run("assertMaterialEditable('a')"),/位置已變更/);
  u.run('renderOrganizationNotice(queue[1])');assert.match(u.get('#reviewOrganization').innerHTML,/查看保留的修改/);
});
test('location version wins over content; delayed older polls cannot undo move-out or restore',()=>{
  const u=ui();u.run("localContentVersions.set('a',10);var old=Object.assign(fixture('a'),{content_version:10});var moved={...old,bucket:'review',organization_version:1,content_version:2};");
  assert.equal(u.run("mergeDocumentSnapshot(moved,old).bucket"),'review');assert.equal(u.run("mergeDocumentSnapshot(old,moved).bucket"),'review');
  assert.equal(u.run("mergeDocumentSnapshot({...moved,bucket:'materials',organization_version:2},moved).bucket"),'materials');
});
test('late save response does not change moved document version, dirty input, summary or new selection',async()=>{
  const u=ui();loadFlush(u);u.run("documentDraft('a');dirty.add('a');revisions.set('a',1)");let release;
  u.ctx.api=()=>new Promise(resolve=>release=resolve);const task=u.run("flushDraft('a')");await tick();
  u.run("queue[0].bucket='review';queue[0].organization_version=1;renderUpload()");release({content_version:9,analysis_summary:{status:'usable'}});await task;
  assert.equal(u.run('state.qSel'),'b');assert.equal(u.run('queue[0].content_version'),0);assert.equal(u.run("localContentVersions.get('a')"),0);assert.equal(u.run("dirty.has('a')"),true);
});
test('input entered after the pre-move save is retained even when move succeeds',async()=>{
  const u=ui();u.run("documentDraft('a')");await u.run("requestOrganize('a','park')");let release;
  u.ctx.api=()=>new Promise(resolve=>release=resolve);const task=u.run('submitOrganization()');await tick();
  u.run("documentDraft('a').items[0].note='typed during move';dirty.add('a')");release({document:{id:'a',bucket:'review',organization_version:1,organization:{},pages:[]}});await task;
  assert.equal(u.run("detachedReviewDrafts.get('a').draft.items[0].note"),'typed during move');assert.equal(u.run('state.qSel'),'b');
});

test('empty or departed workspaces keep refresh and retained-input recovery controls enabled',()=>{
  const u=ui();u.run("state.qSel=null;queue=[fixture('a','pending','review')]");
  const controls=['refresh-organization','retained-draft','save'].map(action=>({dataset:{action},disabled:false}));
  u.ctx.document.querySelectorAll=()=>controls;u.run('syncReviewBusy()');
  assert.deepEqual(controls.map(c=>c.disabled),[false,false,true]);
});

test('restoring from the pool is not cancelled by a hidden upload render selecting another invoice',async()=>{
  const u=ui();u.run("queue[0].bucket='review';state.view='pool';state.qSel=null");
  u.ctx.api=async()=>({document:{id:'a',bucket:'materials',status:'pending',organization_version:1,organization:{},pages:[]}});
  await u.run("requestOrganize('a','material')");await u.run('submitOrganization()');
  assert.equal(u.run('state.qSel'),'a');assert.equal(u.run('location.hash'),'upload');
});
