'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'../public',name),'utf8');
function ui(){
  const nodes=new Map();
  const get=s=>{if(!nodes.has(s))nodes.set(s,{value:'',textContent:'',innerHTML:'',dataset:{},hidden:false,disabled:false,showModal(){this.open=true;},close(){this.open=false;},addEventListener(){}});return nodes.get(s);};
  const calls=[];
  const ctx=vm.createContext({console,structuredClone,Map,WeakMap,Set,Promise,Math,Number,JSON,setTimeout,clearTimeout,
    document:{querySelector:get,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},localStorage:{getItem(){return null;}},location:{hash:'upload'},
    toast:m=>calls.push(m),badge:s=>s,renderUpload(){},updateCounts(){},setQueueOpen(){},refresh:async()=>true,
    flushDraft:async()=>calls.push('draft'),api:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {document:{id:'a',bucket:'review',organization_version:1,organization:{},pages:[]}};},
    revisions:new Map(),confirming:new Set(),dirty:new Set(),saveTimers:new Map(),saveChains:new Map(),analysisSaves:new Map(),localDrafts:new Map(),
  });
  vm.runInContext(source('state.js')+'\n'+source('billing.js')+'\n'+source('ui.js'),ctx);
  const app=source('app.js');vm.runInContext('const localDraftVersions=new Map(),localContentVersions=new Map();'+app.slice(app.indexOf('function documentVersionHeaders('),app.indexOf('const shapeDimensions')),ctx);
  vm.runInContext(source('workflow.js')+'\n'+source('organization.js'),ctx);
  ctx.renderUpload=()=>vm.runInContext('reconcileUploadSelection()',ctx);
  vm.runInContext("queue=[{id:'a',bucket:'materials',status:'done',record_count:2,ledger_active:1,organization_version:0,organization:{},name:'fixture.jpg',pages:[],draft:{meta:{},items:[]}}];state.view='upload';state.qSel='a';",ctx);
  return {ctx,get,calls,run:s=>vm.runInContext(s,ctx)};
}
test('pool filters use actual bucket, category, number, filename and supplier without including materials',()=>{
  const app=ui();app.run(`queue.push({id:'b',bucket:'review',category:'consumables',name:'cleaner.jpg',draft:{meta:{doc:'SAME',sup:'new'}},organization:{note:'清潔'}});queue.push({id:'c',bucket:'trash',category:'tools',name:'tool.jpg',draft:{meta:{doc:'SAME'}}});SUP.new={name:'新供應商'};`);
  assert.equal(app.run("poolRows(queue,'review','all','same',SUP)[0].id"),'b');
  assert.equal(app.run("poolRows(queue,'review','consumables','供應商',SUP).length"),1);
  assert.equal(app.run("poolRows(queue,'trash','tools','same',SUP)[0].id"),'c');
  assert.equal(app.run("poolRows(queue,'review','tools','',SUP).length"),0);
});
test('classification reminder escapes OCR evidence, distinguishes mixtures and respects manual classification',()=>{
  const app=ui();app.run(`queue[0].organization={suggestion:{category:'consumables',mixed:false,evidence:[{text:'<img>鋁清洗劑'}]}};`);
  assert.match(app.run('suggestionHtml(queue[0])'),/建議分類：耗材/);assert.doesNotMatch(app.run('suggestionHtml(queue[0])'),/<img>/);
  app.run('queue[0].organization.suggestion.mixed=true');assert.match(app.run('suggestionHtml(queue[0])'),/疑似混有不同類別/);
  app.run('queue[0].organization.manual=true');assert.equal(app.run('suggestionHtml(queue[0])'),'');
});
test('original line and price blanks and zero remain distinct in the pool',()=>{
  const app=ui();const html=app.run("retainedRowsHtml([{label:'清洗劑',dims:[],qty:2,unit:'桶',price:0,amount:null,processing_fee:0}])");
  assert.match(html,/清洗劑/);assert.match(html,/2 桶/);assert.match(html,/>0／/);assert.match(html,/>0<\/td>/);assert.match(html,/未列|—/);
});
test('frozen material version rejects outside documents and old drafts after move-out and return',()=>{
  const app=ui();app.run("localDraftVersions.set('a',0)");assert.doesNotThrow(()=>app.run("assertMaterialEditable('a')"));
  app.run("queue[0].bucket='review';queue[0].organization_version=1");assert.throws(()=>app.run("assertMaterialEditable('a')"),/位置已變更/);
  app.run("queue[0].bucket='materials';queue[0].organization_version=2");assert.throws(()=>app.run("assertMaterialEditable('a')"),/位置已變更/);
  assert.equal(app.run("documentVersionHeaders('a')['X-MaterialDemo-Document-Version']"),'0');
});
test('failed draft save prevents any move and keeps the dialog and inputs',async()=>{
  const app=ui();await app.run("requestOrganize('a','park')");app.get('#organizeNote').value='keep';
  app.ctx.flushDraft=async()=>{throw Error('保存失敗');};await app.run('submitOrganization()');
  assert.equal(app.calls.filter(c=>typeof c==='object').length,0);assert.equal(app.get('#organizeDialog').open,true);
  assert.equal(app.get('#organizeNote').value,'keep');assert.match(app.get('#organizeError').textContent,/保存失敗/);
});
test('confirmed move sends impact count and version, while double click cannot submit twice',async()=>{
  const app=ui();await app.run("requestOrganize('a','park')");
  assert.match(app.get('#organizeImpact').textContent,/2 筆有效材料/);
  let release;app.ctx.flushDraft=()=>new Promise(resolve=>release=resolve);
  const task=app.run('submitOrganization()');await app.run('submitOrganization()');release();await task;
  const writes=app.calls.filter(c=>typeof c==='object');assert.equal(writes.length,1);assert.equal(writes[0].body.expected_record_count,2);assert.equal(writes[0].body.expected_version,0);assert.equal(writes[0].body.acknowledge_records,true);
});
test('write succeeded then refresh failed retries only refresh, never writes twice',async()=>{
  const app=ui();await app.run("requestOrganize('a','trash')");app.ctx.refresh=async()=>{throw Error('offline');};
  await app.run('submitOrganization()');assert.match(app.get('#organizeError').textContent,/已保存，清單更新失敗/);
  app.ctx.refresh=async()=>true;await app.run('submitOrganization()');assert.equal(app.calls.filter(c=>typeof c==='object').length,1);assert.equal(app.run("organizationRecovery.has('a')"),false);
});
test('manual navigation during move completion suppresses old auto-navigation',async()=>{
  const app=ui();await app.run("requestOrganize('a','park')");let release;
  app.ctx.api=()=>new Promise(resolve=>release=resolve);
  const task=app.run('submitOrganization()');await new Promise(resolve=>setImmediate(resolve));
  app.run("state.view='search';state.reviewGeneration++;location.hash='search'");release({document:{id:'a',bucket:'review',organization_version:1,organization:{},pages:[]}});await task;
  assert.equal(app.run('location.hash'),'search');assert.equal(app.run('state.view'),'search');
});
test('pool metadata response cannot overwrite newer note input and retains the existing viewer key',async()=>{
  const app=ui();app.run("queue[0].bucket='review';var edit=poolEdit(queue[0]);edit.note='first';edit.dirty=true;edit.revision=1;poolState.id='a'");let release;
  app.ctx.api=()=>new Promise(resolve=>release=resolve);
  const task=app.run("savePoolMetadata('a')");app.run("edit.note='newer';edit.revision=2");release({document:{id:'a',bucket:'review',organization_version:1,organization:{note:'first'}}});await task;
  assert.equal(app.run('edit.note'),'newer');assert.equal(app.run('edit.dirty'),true);assert.equal(app.run('poolState.key'),'a:review:1');
});
test('centered cuboid applies 3D offsets before projection; standalone and round stay separate',()=>{
  const app=ui();const svg=app.run('iso([10,10,24],[5,5,5])');
  assert.match(svg,/class="iso-part" data-offset="9.5,2.5,2.5"/);
  const projected=svg.match(/class="iso-part"[^>]*><polygon class="f-l" points="([^"]+)"/)[1].split(' ').map(p=>p.split(',').map(Number));
  const c=Math.cos(Math.PI/6),k=Math.min((460-132)/(34*c),(270-64)/27),ox=(460-34*c*k)/2+10*c*k,oy=(270-27*k)/2+10*k;
  const expected=[ox+(9.5-7.5)*c*k,oy+(9.5+7.5)*.5*k-2.5*k];
  assert.ok(Math.abs(projected[0][0]-expected[0])<=.05);assert.ok(Math.abs(projected[0][1]-expected[1])<=.05);
  assert.match(app.run('iso([10,10,24],[10,10,24])'),/class="iso-part" data-offset="0,0,0"/);
  assert.match(app.run('iso([1.5,3,100],[1,2,80])'),/data-offset="10,0.5,0.25"/);
  assert.match(app.run('iso(null,[5,5,5])'),/iso-part is-alone/);assert.match(app.run('iso([70,107],[60,100])'),/round-figure/);assert.doesNotMatch(app.run('iso([70,107],[60,100])'),/data-offset/);
  assert.equal(app.run('fmtMargin(2.5)'), '2.5');assert.equal(app.run('fmtMargin(.125)'),'.125'.replace(/^\./,'0.'));
});
