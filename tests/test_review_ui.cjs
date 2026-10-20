'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'../public',name),'utf8');
function workflow(){
  const nodes=new Map(),get=s=>{if(!nodes.has(s))nodes.set(s,{textContent:'',innerHTML:'',dataset:{},disabled:false,hidden:false,checked:false,addEventListener(){},replaceChildren(){this.textContent='';},closest(){return {scrollLeft:0};},querySelector(){return null;},offsetTop:0});return nodes.get(s);};
  const calls=[],draft={meta:{sup:'hh',doc:'SAME'},items:[{label:'鋁',dims:[7,16,80],qty:7,price:12,amount:84,dim_unit:'mm',unit:'件'}]};
  const ctx=vm.createContext({console,Map,WeakMap,Set,Date,Number,Math,JSON,Promise,structuredClone,setTimeout,clearTimeout,
    localStorage:{getItem(){return null;},setItem(){}},$ :get,$$:()=>[],document:{},window:{scrollY:500,scrollTo(){}},location:{hash:''},requestAnimationFrame:fn=>fn(),
    state:{view:'upload',qSel:'a',item:0,reviewGeneration:0,queueFilter:'pending',queueSearch:'',reviewContext:null},
    SUP:{hh:{name:'示範鋁材一廠股份有限公司',short:'示範鋁材一廠'},sk:{name:'示範鋼材二廠有限公司',short:'示範鋼材二廠'}},queue:[{id:'a',status:'pending'}],records:[],localDrafts:new Map(),
    confirming:new Set(),dirty:new Set(),saveTimers:new Map(),saveChains:new Map(),revisions:new Map(),documentDraft:()=>draft,
    flushDraft:async()=>calls.push('draft'),api:async()=>{calls.push('confirm');return {count:1};},refresh:async()=>{calls.push('refresh');return true;},
    renderUpload(){calls.push('render');},setQueueOpen(){},renderSupplierFilters(){},closeDrawer(){},tableRows:()=>[],
    toast:message=>calls.push(message),focusReviewError:message=>calls.push('error:'+message),updateCalc(){},esc:String,money:value=>value==null?'—':String(value),badge:s=>s,supChip:s=>s
  });
  vm.runInContext(source('state.js').match(/function isMaterialDocument[^\n]+/)[0],ctx);
  vm.runInContext('var localDraftVersions=new Map(),localContentVersions=new Map();'+source('app.js').slice(source('app.js').indexOf('function documentVersionHeaders('),source('app.js').indexOf('const shapeDimensions')),ctx);
  ctx.renderPool=()=>{};
  vm.runInContext(source('billing.js')+'\n'+source('workflow.js'),ctx);
  vm.runInContext('renderReviewActions=()=>{};syncReviewBusy=()=>{};function markDirty(id){dirty.add(id);revisions.set(id,(revisions.get(id)||0)+1);}function refreshRecordAnalysisDetail(){}',ctx);
  return {ctx,run:s=>vm.runInContext(s,ctx),calls,draft,get};
}
function analysisWorkflow(){
  const ui=workflow();ui.run(source('analysis-review.js'));
  ui.ctx.go=view=>ui.run(`state.view=${JSON.stringify(view)}`);
  ui.ctx.aError=()=>{};
  ui.ctx.aOpenQuote=async()=>{};
  ui.run(`var context={kind:'analysis',documentId:'a',recordId:'a-0',position:0,page:1,visited:[],requestFilters:{price_basis:'original'},order:[{id:'b-0'},{id:'a-1'},{id:'c-0'}]};
    state.reviewContext=context;queue=[{id:'a',status:'done'},{id:'b',status:'done'},{id:'c',status:'done'}];
    var fresh={review:{},review_lookup:{'a-0':{id:'a-0',document_id:'a',position:0,page:1,review_status:'included'},'a-1':{id:'a-1',document_id:'a',position:1,page:1,review_status:'needs_review'},'b-0':{id:'b-0',document_id:'b',position:0,page:1,review_status:'needs_review'},'c-0':{id:'c-0',document_id:'c',position:0,page:1,review_status:'duplicate'}}};`);
  ui.draft.items.push({...ui.draft.items[0],page:1});
  ui.ctx.aRefreshReview=async()=>{ui.calls.push('analysis');return ui.run('fresh');};
  return ui;
}
test('analysis reviews every line as a draft before confirming the invoice and fetching analysis',async()=>{
  const ui=analysisWorkflow();await ui.run('confirmReview()');
  assert.equal(ui.run('state.item'),1);assert.equal(ui.calls.includes('confirm'),false);assert.equal(ui.calls.includes('analysis'),false);
  await ui.run('confirmReview()');
  assert.equal(ui.calls.filter(x=>x==='confirm').length,1);assert.equal(ui.calls.includes('analysis'),true);
  assert.equal(ui.run('state.qSel'),'b');assert.equal(ui.run('continuousReview'),true);
});
test('analysis next skips the entire reviewed invoice, resolved rows and duplicate invoices',()=>{
  const ui=analysisWorkflow();assert.equal(ui.run('aNextProblem(context,fresh,true).id'),'b-0');
  ui.run("fresh.review_lookup['b-0'].review_status='included'");assert.equal(ui.run('aNextProblem(context,fresh,true)'),null);
});
test('analysis write failure stays on final line; refresh retry never confirms twice',async()=>{
  const ui=analysisWorkflow();await ui.run('confirmReview()');
  ui.ctx.api=async()=>{throw Error('save rejected');};await ui.run('confirmReview()');
  assert.equal(ui.calls.includes('analysis'),false);assert.equal(ui.run('state.item'),1);assert.equal(ui.run("savedReviewRecovery.has('a')"),false);
  let confirmations=0;ui.ctx.api=async()=>{confirmations++;return {count:2};};ui.ctx.aRefreshReview=async()=>{throw Error('analysis offline');};
  await ui.run('confirmReview()');assert.match(ui.run("savedReviewRecovery.get('a').message"),/已保存.*最新分析/);
  ui.ctx.aRefreshReview=async()=>ui.run('fresh');await ui.run('retrySavedRefresh()');assert.equal(confirmations,1);assert.equal(ui.run('state.qSel'),'b');
});
test('manual document or page navigation while analysis is loading cancels background continuation',async()=>{
  for(const action of ["selectReviewDocument('b')","state.view='analysis';state.reviewGeneration++","state.item=0;state.reviewGeneration++"]){
    const ui=analysisWorkflow();await ui.run('confirmReview()');let release;ui.ctx.aRefreshReview=()=>new Promise(resolve=>release=resolve);
    const task=ui.run('confirmReview()');await new Promise(resolve=>setImmediate(resolve));ui.run(action);const before=ui.run('JSON.stringify([state.view,state.qSel,state.item])');
    release(ui.run('fresh'));await task;assert.equal(ui.run('JSON.stringify([state.view,state.qSel,state.item])'),before);
  }
});
test('analysis source uses document ID, exact position and page, including duplicate invoice numbers',()=>{
  const ui=analysisWorkflow();assert.equal(ui.run("aReviewTarget({document_id:'b',position:1,page:1}).doc.id"),'b');
  assert.equal(ui.run("aReviewTarget({document_id:'b',position:1,page:1}).item"),1);
  assert.throws(()=>ui.run("aReviewTarget({document_id:'missing',position:0,page:1})"),/找不到/);
  assert.throws(()=>ui.run("aReviewTarget({document_id:'b',position:8,page:1})"),/找不到/);
  assert.throws(()=>ui.run("aReviewTarget({document_id:'b',position:1,page:2})"),/頁次已變動/);
});
test('returning to analysis restores chart filters, issue category and both scroll axes without changing queue preference',()=>{
  const ui=analysisWorkflow(),fields={grade:{value:''},price_basis:{value:''}};ui.get('#aFilters').elements={namedItem:k=>fields[k]};
  ui.run("var analysisState={};context.filters={grade:'S50C',price_basis:'original'};context.fixed=null;context.view='scatter';context.listStatus='needs_review';context.category='missing_price';context.scroll=870;context.tableTop=144;context.tableLeft=260;");
  const positions=[];ui.ctx.window.scrollTo=(x,y)=>positions.push([x,y]);
  ui.run("aReturnToAnalysis(context);state.view='analysis';aRestoreReturn()");
  assert.equal(fields.grade.value,'S50C');assert.equal(fields.price_basis.value,'original');assert.equal(ui.run('analysisState.view'),'scatter');assert.equal(ui.run('analysisState.category'),'missing_price');
  assert.deepEqual(positions,[[0,870]]);assert.equal(ui.get('#aTableScroll').scrollTop,144);assert.equal(ui.get('#aTableScroll').scrollLeft,260);assert.equal(ui.run('continuousReview'),true);
});
test('analysis list filtering uses server status and category counts and never changes chart data',()=>{
  const ui=workflow();ui.run(source('analysis.js').replace(/\naInit\(\);\s*$/,''));
  ui.run(`analysisState.result={price_basis:'original',review:{all:3,needs_review:1,included:1,duplicate:1,categories:[{code:'missing_price',label:'缺少單價',count:1}]},observations:[
    {id:'a',kind:'invoice',position:0,page:2,sup:'hh',source_ids:['a'],dims:[],review_status:'needs_review',reason:'單價未列',issues:[{message:'單價未列'},{message:'其他問題'}],primary_issue:{code:'missing_price',label:'缺少單價'}},
    {id:'b',kind:'invoice',sup:'hh',source_ids:['b'],dims:[],review_status:'included',eligible:true},
    {id:'c',kind:'invoice',sup:'hh',source_ids:['c'],dims:[],review_status:'duplicate'}]};var before=JSON.stringify(analysisState.result);
    analysisState.listStatus='needs_review';analysisState.category='missing_price';aRenderRows();`);
  assert.match(ui.get('#aRows').innerHTML,/第 2 頁/);assert.match(ui.get('#aRows').innerHTML,/其他問題/);assert.doesNotMatch(ui.get('#aRows').innerHTML,/data-a-row="b"|data-a-row="c"/);
  assert.match(ui.get('#aListFilters').innerHTML,/重複已合併 1/);assert.match(ui.get('#aCategories').innerHTML,/缺少單價 1/);assert.equal(ui.run('JSON.stringify(analysisState.result)===before'),true);
});
test('supplement refresh failure retains the form and retries analysis without saving twice',async()=>{
  const ui=analysisWorkflow(),form=ui.get('#aNoteForm'),listeners={},button=ui.get('button[type=submit]');
  form.elements=[button,{disabled:false}];form.addEventListener=(name,fn)=>listeners[name]=fn;
  ui.ctx.aFormObject=()=>({note:'reviewed',weight_kg:2});let posts=0,finished=0;
  ui.ctx.api=async()=>{posts++;return {};};ui.ctx.aFinishReview=()=>finished++;
  ui.ctx.aRefreshReview=async()=>{throw Error('analysis offline');};
  ui.run("aBindNote({id:'a-0',fingerprint:'current'},context)");await listeners.submit({preventDefault(){}});
  assert.equal(posts,1);assert.equal(finished,0);assert.match(ui.get('#aNoteError').textContent,/已保存.*最新分析取得失敗/);assert.equal(button.textContent,'重試更新分析');
  ui.ctx.aRefreshReview=async()=>ui.run('fresh');await listeners.submit({preventDefault(){}});
  assert.equal(posts,1);assert.equal(finished,1);assert.equal(button.disabled,false);
});
test('leaving a supplement while refresh is pending cancels its old continuation',async()=>{
  const ui=analysisWorkflow(),form=ui.get('#aNoteForm'),listeners={},button=ui.get('button[type=submit]');
  form.elements=[button];form.addEventListener=(name,fn)=>listeners[name]=fn;ui.ctx.aFormObject=()=>({});let release,finished=0;
  ui.ctx.aRefreshReview=()=>new Promise(resolve=>release=resolve);ui.ctx.aFinishReview=()=>finished++;
  ui.run("aBindNote({id:'a-0',fingerprint:'current'},context)");const task=listeners.submit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
  ui.run("state.reviewGeneration++;state.view='table'");release(ui.run('fresh'));await task;assert.equal(finished,0);assert.equal(ui.run('state.view'),'table');
});
test('manual line selection updates the active source identity without rebuilding the frozen issue order',()=>{
  const ui=analysisWorkflow();ui.run("records=[{id:'a-1',document_id:'a',position:1,page:1}];selectReviewItem(1)");
  assert.equal(ui.run('state.reviewContext.recordId'),'a-1');assert.equal(ui.run('state.reviewGeneration'),1);
  assert.equal(ui.run('aNextProblem(state.reviewContext,fresh).id'),'b-0');assert.equal(ui.run('state.reviewContext.order.length'),3);
});
test('a second analysis source click supersedes the earlier click while its draft flush is pending',async()=>{
  const ui=analysisWorkflow();let release;ui.ctx.flushDraft=()=>new Promise(resolve=>release=resolve);
  ui.run("var analysisState={result:{observations:[{id:'first'},{id:'latest'}]}};var opened=[];aCaptureContext=id=>({id});aSelectProblem=row=>opened.push(row.id)");
  const pending=[];ui.ctx.flushDraft=()=>new Promise(resolve=>pending.push(resolve));
  const first=ui.run("aOpenReview('first')"),latest=ui.run("aOpenReview('latest')");pending.forEach(resolve=>resolve());await Promise.all([first,latest]);
  assert.equal(ui.run("opened.join(',')"),'latest');
});
test('queue filters combine status with doc number, filename and supplier; counts distinguish pending and processing',()=>{
  const ui=workflow();ui.run(`queue=[{id:'a',name:'one.jpg',status:'done',draft:{meta:{doc:'SAME',sup:'hh'}}},{id:'b',name:'two.jpg',status:'pending',draft:{meta:{doc:'SAME',sup:'sk'}}},{id:'c',status:'queued'},{id:'d',status:'extracting'},{id:'e',status:'error'}]`);
  assert.equal(ui.run('queueCounts(queue).pending'),1);assert.equal(ui.run('queueCounts(queue).processing'),2);
  assert.equal(ui.run("filteredQueue(queue,'all','same',SUP).length"),2);
  assert.equal(ui.run("filteredQueue(queue,'pending','same',SUP)[0].id"),'b');
  assert.equal(ui.run("filteredQueue(queue,'all','示範鋁材一廠',SUP)[0].id"),'a');
  assert.equal(ui.run("filteredQueue(queue,'all','two.jpg',SUP)[0].id"),'b');
  assert.equal(ui.run("filteredQueue(queue,'processing','',SUP).length"),2);
});
test('next pending wraps in original order, excludes current and never selects failed or running invoices',()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'pending'},{id:'b',status:'done'},{id:'c',status:'queued'},{id:'d',status:'error'},{id:'e',status:'pending'}]");
  assert.equal(ui.run("nextPending(queue,'a').id"),'e');assert.equal(ui.run("nextPending(queue,'e').id"),'a');
  ui.run("queue[0].status='done'");assert.equal(ui.run("nextPending(queue,'e')"),null);
  assert.equal(ui.run("nextPending([],'unknown')"),null);
});
test('record navigation uses document ID and stored position; pending drafts safely start at first line',()=>{
  const ui=workflow();
  ui.run("var record={document_id:'b',position:1,doc:'SAME'},doc={id:'b',status:'done',draft:{items:[{},{}]}};");
  assert.equal(ui.run('recordReviewTarget(record,doc).item'),1);
  ui.run("doc.status='pending'");assert.equal(ui.run('recordReviewTarget(record,doc).item'),0);assert.equal(ui.run('recordReviewTarget(record,doc).pending'),true);
  assert.equal(ui.run("recordReviewTarget(record,{id:'a',draft:doc.draft,status:'done'})"),null);
  assert.equal(ui.run('recordReviewTarget(record,null)'),null);
});
test('summary preserves optional blanks and zeros, flags required dimensions and includes whole-invoice differences',()=>{
  const ui=workflow();
  ui.run(`var d={meta:{sup:'hh',subtotal:84,tax:0,total:84},items:[{label:'鋁',grade:'',shape:'rect',dims:[7,16,80],qty:7,price:12,amount:84,processing_fee:0,unit:'件',dim_unit:'mm'},{label:'圓條',shape:'round',dims:[180,19],qty:504,price:'',amount:'',processing_fee:'',unit:'件',dim_unit:'mm'}]}`);
  assert.equal(ui.run('invoiceIssues(d,SUP).issues.length'),0);assert.equal(ui.run('invoiceIssues(d,SUP).sum'),84);assert.equal(ui.run('invoiceIssues(d,SUP).missing'),1);
  ui.run("d.items[1].dims[1]='';d.items[1].processing_fee=-1");
  assert.equal(ui.run("invoiceIssues(d,SUP).issues.some(i=>i.item===1&&i.key==='dim1')"),true);
  assert.equal(ui.run("invoiceIssues(d,SUP).issues.some(i=>i.key==='processing_fee'&&i.severity==='error')"),true);
  ui.run('d.items.pop();d.meta.subtotal=85');assert.equal(ui.run("invoiceIssues(d,SUP).issues.some(i=>i.scope==='meta'&&i.key==='subtotal')"),true);
  ui.run("d.meta.date='2026-02-30'");assert.equal(ui.run("invoiceIssues(d,SUP).issues.some(i=>i.key==='date')"),true);
});
test('weight pricing summary uses original quantity and actual billing unit without changing source amounts',()=>{
  const ui=workflow();ui.run(`var d={meta:{sup:'sk',subtotal:5500,total:5500},items:[{label:'SKD11',dims:[13,32,210],qty:7,unit:'件',weight_kg:8.4,price:125,material_amount:1050,processing_fee:490,amount:1540,pricing_basis:'weight'},{label:'S50C',dims:[8,60,128],qty:36,price:110,amount:3960}]}`);
  assert.equal(ui.run('invoiceIssues(d,SUP).sum'),5500);assert.equal(ui.run('invoiceIssues(d,SUP).issues.length'),0);
  ui.run('d.items[0].processing_fee=500');assert.equal(ui.run("invoiceIssues(d,SUP).issues.some(i=>i.key==='amount')"),true);assert.equal(ui.run('d.items[0].amount'),1540);
});
test('continuous preference defaults on, remembers off, and survives unavailable storage',()=>{
  const ui=workflow();assert.equal(ui.run('continuousReview'),true);
  assert.equal(ui.run("readContinuous({getItem(){return 'false'}})"),false);
  assert.equal(ui.run("readContinuous({getItem(){throw Error('denied')}})"),true);
});
test('confirmation waits for successful fresh state before selecting next and prevents duplicate submission',async()=>{
  const ui=workflow();let release;ui.ctx.refresh=()=>new Promise(resolve=>{release=resolve;});
  ui.run("queue=[{id:'a',status:'done'},{id:'b',status:'pending'}]");
  const task=ui.run('confirmReview()');await new Promise(resolve=>setImmediate(resolve));
  await ui.run('confirmReview()');assert.equal(ui.calls.filter(x=>x==='confirm').length,1);assert.equal(ui.run('state.qSel'),'a');
  release(true);await task;assert.equal(ui.run('state.qSel'),'b');assert.equal(ui.run('state.item'),0);
});
test('successful write followed by refresh failure stays put and retries only the refresh',async()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'done'},{id:'b',status:'pending'}]");ui.ctx.refresh=async()=>{throw Error('offline');};
  await ui.run('confirmReview()');assert.equal(ui.run('state.qSel'),'a');assert.equal(ui.run("savedReviewRecovery.has('a')"),true);
  assert.match(ui.run("savedReviewRecovery.get('a').message"),/已保存，清單更新失敗/);
  await ui.run('confirmReview()');assert.equal(ui.calls.filter(x=>x==='confirm').length,1);
  ui.ctx.refresh=async()=>true;await ui.run('retrySavedRefresh()');assert.equal(ui.run('state.qSel'),'b');assert.equal(ui.calls.filter(x=>x==='confirm').length,1);
});
test('validation failure and draft-save failure keep current form; leaving mid-request cancels navigation',async()=>{
  const ui=workflow();ui.ctx.flushDraft=async()=>{throw Error('save failed');};await ui.run('confirmReview()');assert.equal(ui.calls.includes('confirm'),false);assert.equal(ui.run('state.qSel'),'a');
  ui.ctx.flushDraft=async()=>{};ui.ctx.api=async()=>{throw Error('第 2 筆尺寸必須是正數');};await ui.run('confirmReview()');assert.equal(ui.calls.some(x=>String(x).includes('error:第 2 筆')),true);
  ui.ctx.api=async()=>{ui.run("state.reviewGeneration++;state.view='table'");return {count:1};};ui.run("queue=[{id:'a',status:'done'},{id:'b',status:'pending'}]");await ui.run('confirmReview()');assert.equal(ui.run('state.qSel'),'a');
});
test('table-origin confirmation returns through captured context without changing batch preference',async()=>{
  const ui=workflow();ui.run("state.reviewContext={documentId:'a',recordId:'a-1'};var returned=null;returnToTable=(context,message)=>{returned=context};queue=[{id:'a',status:'done'},{id:'b',status:'pending'}]");
  await ui.run('confirmReview()');assert.equal(ui.run('returned.recordId'),'a-1');assert.equal(ui.run('state.qSel'),'a');assert.equal(ui.run('continuousReview'),true);
});
test('save-next never confirms, excludes itself and handles last pending invoice',async()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'pending'},{id:'b',status:'pending'}]");await ui.run('saveAndNext()');assert.equal(ui.run('state.qSel'),'b');assert.equal(ui.calls.includes('confirm'),false);
  ui.run("queue=[{id:'b',status:'pending'},{id:'c',status:'error'}]");await ui.run('saveAndNext()');assert.equal(ui.run('state.qSel'),'b');assert.equal(ui.calls.some(x=>String(x).includes('1 張辨識失敗')),true);
});
test('forced state refresh cannot reuse a poll started before confirmation and strict failures propagate',async()=>{
  const ui=workflow();
  Object.assign(ui.ctx,{online:false,clearConnectionIssue(){},updateMaterialCatalog(){return false;},renderTable(){},renderTemplates(){},renderSearch:async()=>{},updateCounts(){}});
  ui.run('var refreshing=null');
  const app=source('app.js'),fn=app.slice(app.indexOf('async function refresh('),app.indexOf('function renderSupplierFilters'));
  ui.run(fn);let release,requests=0;
  ui.ctx.api=async()=>{requests++;if(requests===1)await new Promise(resolve=>release=resolve);return {suppliers:{},records:[],documents:[]};};
  const poll=ui.run('refresh()'),forced=ui.run('refresh(true,{strict:true})');assert.equal(requests,1);
  release();await Promise.all([poll,forced]);assert.equal(requests,2);
  ui.ctx.api=async()=>{throw Error('state offline');};await assert.rejects(ui.run('refresh(true,{strict:true})'),/state offline/);
});

test('saving a historical draft immediately marks it pending for a fast return and reopen',async()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'done'}];dirty.add('a');revisions.set('a',1);updateCounts=()=>{};");
  const app=source('app.js'),fn=app.slice(app.indexOf('async function flushDraft('),app.indexOf('async function refresh('));
  ui.run(fn);await ui.run("flushDraft('a')");
  assert.equal(ui.run('queue[0].status'),'pending');assert.equal(ui.run("dirty.has('a')"),false);
  assert.equal(ui.run("recordReviewTarget({document_id:'a',position:1},queue[0]).item"),0);
});
test('editing after a saved-write refresh failure cancels the old automatic continuation',async()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'done'},{id:'b',status:'pending'}]");
  ui.ctx.refresh=async()=>{throw Error('offline');};await ui.run('confirmReview()');
  ui.run("revisions.set('a',2)");ui.ctx.refresh=async()=>true;await ui.run('retrySavedRefresh()');
  assert.equal(ui.run('state.qSel'),'a');assert.equal(ui.run("savedReviewRecovery.has('a')"),false);
  assert.equal(ui.calls.some(x=>String(x).includes('目前另有修改')),true);
});

test('analysis status labels distinguish previews, duplicates and unsupported grades',()=>{
  const ui=workflow();
  assert.equal(ui.run("analysisLabel({status:'partial',preview:true,usable:1,total:3})"),'預檢 · 部分可分析 1／3');
  assert.equal(ui.run("analysisLabel({status:'duplicate',usable:0,total:3})"),'重複已合併');
  assert.equal(ui.run("analysisLabel({status:'unsupported'})"),'暫未支援');
  assert.equal(ui.run("analysisLabel(null)"),'尚未檢查');
});
test('analysis-only filter composes with status and search and includes dirty documents',()=>{
  const ui=workflow();ui.run(`queue=[{id:'a',status:'done',name:'a',draft:{meta:{doc:'SAME',sup:'hh'}},analysis_summary:{status:'partial'}},{id:'b',status:'pending',name:'b',draft:{meta:{doc:'SAME',sup:'sk'}},analysis_summary:{status:'usable'}},{id:'c',status:'pending',name:'c',draft:{meta:{doc:'OTHER',sup:'sk'}},analysis_summary:{status:'needs_review'}}]`);
  assert.equal(ui.run("filteredQueue(queue,'all','same',SUP,doc=>doc.draft,true).length"),1);
  assert.equal(ui.run("filteredQueue(queue,'pending','',SUP,doc=>doc.draft,true)[0].id"),'c');
  ui.run("dirty.add('b')");assert.equal(ui.run("filteredQueue(queue,'pending','same',SUP,doc=>doc.draft,true)[0].id"),'b');
});
test('dirty status hides stale issues and does not claim estimated weight or verified tax',()=>{
  const ui=workflow();ui.run("queue=[{id:'a',analysis_summary:{status:'usable',usable:1,total:1,tax_unconfirmed:1,theoretical_weight:1}}]");
  assert.match(ui.run('analysisBadge(queue[0])'),/稅別未確認/);assert.match(ui.run('analysisBadge(queue[0])'),/理論重量估算/);
  ui.run("dirty.add('a')");assert.match(ui.run('analysisBadge(queue[0])'),/修改中，儲存後檢查/);assert.doesNotMatch(ui.run('analysisBadge(queue[0])'),/可分析/);
});
test('saved snapshot survives an older poll and accepts a matching fresh state',()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'pending'}];rememberAnalysisSave('a',{meta:{doc:'new'},items:[]},{analysis_summary:{status:'usable'}});var incoming={id:'a',status:'pending',draft:{meta:{doc:'old'},items:[]},analysis_summary:{status:'needs_review'}};mergeAnalysisState(incoming,queue[0]);");
  assert.equal(ui.run('incoming.analysis_summary.status'),'usable');assert.equal(ui.run("analysisSaves.has('a')"),true);
  ui.run("incoming={id:'a',status:'pending',draft:{items:[],meta:{doc:'new'}},analysis_summary:{status:'partial'}};mergeAnalysisState(incoming,queue[0]);");
  assert.equal(ui.run('incoming.analysis_summary.status'),'partial');assert.equal(ui.run("analysisSaves.has('a')"),false);
});
test('older save response never replaces the summary for a newer edit',async()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'done',analysis_summary:{status:'usable'}}];dirty.add('a');revisions.set('a',1);updateCounts=()=>{};");
  const app=source('app.js');ui.run(app.slice(app.indexOf('async function flushDraft('),app.indexOf('async function refresh(')));
  let release;ui.ctx.api=()=>new Promise(resolve=>release=resolve);
  const task=ui.run("flushDraft('a')");await new Promise(resolve=>setImmediate(resolve));
  ui.run("revisions.set('a',2)");release({analysis_summary:{status:'needs_review'}});await task;
  assert.equal(ui.run("dirty.has('a')"),true);assert.equal(ui.run('queue[0].analysis_summary.status'),'usable');
  assert.match(ui.run('analysisBadge(queue[0])'),/修改中/);
});
test('save failure keeps dirty input and last successful summary without applying rejected results',async()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'pending',analysis_summary:{status:'partial'}}];dirty.add('a');revisions.set('a',1);");
  const app=source('app.js');ui.run(app.slice(app.indexOf('async function flushDraft('),app.indexOf('async function refresh(')));
  ui.ctx.api=async()=>{throw Error('offline');};await assert.rejects(ui.run("flushDraft('a')"),/offline/);
  assert.equal(ui.run("dirty.has('a')"),true);assert.equal(ui.run('queue[0].analysis_summary.status'),'partial');
});
test('per-line analysis issues use safe labels and current item, scope and field targets',()=>{
  const ui=workflow();ui.run(`queue=[{id:'a',analysis_summary:{status:'partial',preview:true,usable:1,total:2,lines:[{position:0,grade:'S50C',eligible:true,issues:[]},{position:1,grade:'S50C',eligible:false,issues:[{key:'amount',scope:'item',message:'核對金額',item:1,page:2}]}]}}];renderAnalysisCheck(queue[0]);`);
  const html=ui.get('#reviewAnalysisBody').innerHTML;assert.match(html,/data-analysis-item="1"/);assert.match(html,/data-analysis-key="amount"/);assert.match(html,/確認前僅預檢/);
  ui.run("dirty.add('a');renderAnalysisCheck(queue[0])");assert.doesNotMatch(ui.get('#reviewAnalysisBody').innerHTML,/data-analysis-issue/);
});
test('analysis refresh patches its own region without recreating review inputs or image',()=>{
  const ui=workflow();ui.get('#reviewScroll').innerHTML='existing input';ui.get('#sourceViewport').innerHTML='zoomed image';
  ui.run("queue=[{id:'a',analysis_summary:{status:'usable',usable:1,total:1,lines:[]}}];renderAnalysisCheck(queue[0]);queue[0].analysis_summary.status='partial';renderAnalysisCheck(queue[0]);");
  assert.equal(ui.get('#reviewScroll').innerHTML,'existing input');assert.equal(ui.get('#sourceViewport').innerHTML,'zoomed image');
});
test('analysis problem focus uses shared line switching and same-page viewer path',()=>{
  const ui=workflow();const calls=[];ui.ctx.$$=()=>[{dataset:{scope:'item',key:'amount'},focus(){calls.push('focus');},scrollIntoView(){calls.push('scroll');}}];
  ui.run("focusSummaryIssue({item:1,key:'amount',scope:'item'})");assert.equal(ui.run('state.item'),1);assert.deepEqual(calls,['focus','scroll']);assert.ok(ui.calls.includes('render'));
});
test('pre-save poll cannot turn the newly saved pending draft back into an older confirmed summary',()=>{
  const ui=workflow();ui.run("queue=[{id:'a',status:'pending'}];rememberAnalysisSave('a',{meta:{doc:'new'},items:[]},{analysis_summary:{status:'partial',preview:true}});var incoming={id:'a',status:'done',draft:{meta:{doc:'old'},items:[]},analysis_summary:{status:'usable'}};mergeAnalysisState(incoming,queue[0]);");
  assert.equal(ui.run('incoming.status'),'pending');assert.equal(ui.run('incoming.analysis_summary.status'),'partial');
  ui.run("mergeAnalysisState(incoming={id:'a',status:'done',analysis_summary:{status:'usable'}},queue[0],analysisSaves.get('a'))");
  assert.equal(ui.run('incoming.status'),'done');assert.equal(ui.run('incoming.analysis_summary.status'),'usable');
});

test('three-line round writes only once after all lines, even when continuous review is off',async()=>{
  const ui=workflow();ui.draft.items.push({...ui.draft.items[0]},{...ui.draft.items[0]});ui.run("continuousReview=false;queue=[{id:'a',status:'pending'},{id:'b',status:'pending'}]");
  await ui.run('confirmReview()');assert.equal(ui.run('state.item'),1);assert.equal(ui.calls.includes('confirm'),false);
  await ui.run('confirmReview()');assert.equal(ui.run('state.item'),2);assert.equal(ui.calls.includes('confirm'),false);
  await ui.run('confirmReview()');assert.equal(ui.calls.filter(x=>x==='confirm').length,1);assert.equal(ui.run('state.qSel'),'a');assert.equal(ui.draft.review_progress.completed,true);
});
test('manual selection is unreviewed; confirming wraps to earlier outstanding lines',async()=>{
  const ui=workflow();ui.draft.items.push({...ui.draft.items[0]},{...ui.draft.items[0]});ui.run('selectReviewItem(2)');
  assert.equal(ui.draft.review_progress,undefined);await ui.run('confirmReview()');assert.equal(ui.run('state.item'),0);
  await ui.run('confirmReview()');assert.equal(ui.run('state.item'),1);assert.equal(ui.calls.includes('confirm'),false);
});
test('saved progress resumes after reload and edits invalidate only their line or the whole metadata round',async()=>{
  const ui=workflow();ui.draft.items.push({...ui.draft.items[0]});await ui.run('confirmReview()');
  const saved=JSON.parse(JSON.stringify(ui.draft));Object.assign(ui.draft,saved);ui.run("selectReviewDocument('a')");assert.equal(ui.run('state.item'),1);
  ui.draft.items[0].qty=8;assert.equal(ui.run('reviewProgress(documentDraft("a")).items[0]'),null);
  ui.draft.items[0].qty=7;ui.run('invalidateReviewProgress(documentDraft("a"),"item",0)');assert.equal(ui.draft.review_progress.items[0],null);
  ui.run('documentDraft("a").meta.doc="NEW"');assert.equal(ui.run('reviewProgress(documentDraft("a")).items.filter(Boolean).length'),0);
});
test('completed rounds start fresh; adding or removing lines cannot inherit positional approvals',async()=>{
  const ui=workflow();await ui.run('confirmReview()');assert.equal(ui.run('reviewProgress(documentDraft("a")).items.filter(Boolean).length'),0);
  ui.draft.review_progress.completed=false;ui.draft.items.push({...ui.draft.items[0]});assert.equal(ui.run('reviewProgress(documentDraft("a")).items.filter(Boolean).length'),0);
  ui.run('invalidateReviewProgress(documentDraft("a"))');ui.draft.items.pop();assert.equal(ui.run('reviewProgress(documentDraft("a")).items.filter(Boolean).length'),0);
});
test('only current line errors block a step, shared errors block all, warnings and blanks do not',async()=>{
  const ui=workflow();ui.draft.items.push({...ui.draft.items[0],dims:[0,1,2]});await ui.run('confirmReview()');assert.equal(ui.run('state.item'),1);
  await ui.run('confirmReview()');assert.equal(ui.calls.includes('confirm'),false);
  ui.draft.items[1].dims=[1,2,3];ui.draft.meta.sup='missing';await ui.run('confirmReview()');assert.equal(ui.calls.includes('confirm'),false);
  ui.draft.meta.sup='hh';ui.draft.items[0].grade='';ui.draft.items[1].price='';ui.draft.items[1].amount='';
  // Changing shared metadata invalidates earlier checks, so the first line must be reviewed again.
  await ui.run('confirmReview()');if(!ui.calls.includes('confirm'))await ui.run('confirmReview()');assert.equal(ui.calls.filter(x=>x==='confirm').length,1);
});
test('line save failure rolls back approval, keeps data and never switches or writes',async()=>{
  const ui=workflow();ui.draft.items.push({...ui.draft.items[0]});ui.ctx.flushDraft=async()=>{throw Error('offline');};
  await ui.run('confirmReview()');assert.equal(ui.run('state.item'),0);assert.equal(ui.draft.review_progress,undefined);assert.equal(ui.draft.items[0].qty,7);assert.equal(ui.calls.includes('confirm'),false);
});
test('double-click and manual navigation during a delayed line save cannot advance twice',async()=>{
  const ui=workflow();ui.draft.items.push({...ui.draft.items[0]});let release;
  ui.ctx.flushDraft=()=>new Promise(resolve=>release=resolve);const pending=ui.run('confirmReview()');await Promise.resolve();
  await ui.run('confirmReview()');ui.run("state.view='table';state.reviewGeneration++");release();await pending;
  assert.equal(ui.run('state.item'),0);assert.equal(ui.calls.includes('confirm'),false);
});

test('analysis supplements still continue through other issues within the same document',()=>{
  const ui=analysisWorkflow();assert.equal(ui.run('aNextProblem(context,fresh).id'),'a-1');
});
