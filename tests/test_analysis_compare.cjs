'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'../public',file),'utf8');
function ui(){
  const nodes=new Map(),events=new Map();
  const get=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',disabled:false,hidden:true,scrollTop:0,scrollLeft:0,isConnected:true,dataset:{},attrs:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k]??null;},hasAttribute(k){return k in this.attrs;},querySelectorAll(){return [];},querySelector(){return null;},focus(){ctx.document.activeElement=this;},addEventListener(k,fn){events.set(selector+':'+k,fn);}});return nodes.get(selector);};
  const ctx=vm.createContext({console,Date,Math,Map,Set,Number,String,Array,JSON,Error,Promise,$:get,$$:()=>[],SUP:{hh:{short:'示範鋁材一廠',name:'示範鋁材一廠'},sk:{short:'示範鋼材二廠',name:'示範鋼材二廠'}},X_BTN:'<button data-close>關閉</button>',esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),document:{activeElement:null,querySelectorAll(){return [];},addEventListener(k,fn){events.set('document:'+k,fn);}},structuredClone});
  ctx.openDrawer=(html,wide)=>{get('#drawer').hidden=false;get('#drawerPanel').innerHTML=html;get('#drawerPanel').wide=wide;};
  for(const file of ['billing.js','tax.js','analysis-compare.js','analysis.js'])vm.runInContext(read(file).replace(/\naInit\(\);\s*$/,''),ctx);
  return {ctx,get,events,run:code=>vm.runInContext(code,ctx)};
}
function row(id,extra={}){return {id,kind:'invoice',document_id:'doc-'+id,position:0,page:1,date:'2026-10-10',doc:'SAME',sup:'hh',grade:'S50C',temper:'退火',shape:'rect',dims:[10,20,100],qty:10,unit:'件',price:10,pricing_basis:'quantity',original_unit_kg:50,unit_kg:50,weight:2,piece_weight:.2,weight_source:'actual',processing_fee:null,tax_status:'unknown',eligible:true,price_basis:'original',source_ids:['doc-'+id],...extra};}
function setup(rows=[row('a'),row('b'),row('c'),row('d'),row('e')]){const u=ui();u.ctx.rows=rows;u.run('analysisState.result={observations:rows,market_series:"sb-china-hrb"};aReconcileComparison(analysisState.result,{price_basis:"original"})');return u;}
function select(u,id,kind='invoice'){u.ctx.key=JSON.stringify([kind,id]);u.run('aToggleComparison(key)');}

test('comparison supports 2 through 4 distinct records, enforces maximum, removes and clears independently of table selection',()=>{
  const u=setup();select(u,'a');assert.equal(u.get('#aCompareOpen').disabled,true);select(u,'b');assert.equal(u.get('#aCompareOpen').disabled,false);
  select(u,'c');select(u,'d');select(u,'e');assert.equal(u.run('aComparison.picked.size'),4);assert.match(u.get('#aCompareMessage').textContent,/最多同時比較 4 筆/);
  select(u,'b');assert.equal(u.run('aComparison.picked.size'),3);select(u,'e');assert.equal(u.run('aComparison.picked.size'),4);
  u.run('aComparison.picked.clear();aRenderComparison()');assert.equal(u.get('#aCompareCount').textContent,'已選 0／4 筆');assert.equal(u.get('#aCompareOpen').disabled,true);
});
test('identity includes source kind and detail ID and never merges repeated document numbers',()=>{
  const u=setup([row('a'),row('b'),row('a',{kind:'quote',document_id:null})]);select(u,'a');select(u,'b');select(u,'a','quote');
  assert.equal(u.run('aComparison.picked.size'),3);const html=u.run('aComparisonHTML()');assert.match(html,/報價／詢價/);assert.equal((html.match(/查看原單明細/g)||[]).length,2);assert.equal((html.match(/查看報價來源/g)||[]).length,1);
});
test('ineligible, duplicate and international records cannot be selected even through direct keys',()=>{
  const u=setup([row('bad',{eligible:false}),row('dup',{eligible:false,review_status:'duplicate'}),row('market',{kind:'market'})]);
  for(const id of ['bad','dup','missing'])select(u,id);select(u,'market','market');assert.equal(u.run('aComparison.picked.size'),0);
  for(const r of u.ctx.rows){u.ctx.r=r;assert.equal(u.run('aCompareButton(r)'),'');}
});
test('overlapping price points expose a separate selection for every source and never for market points',()=>{
  const u=setup([row('a'),row('b')]);u.run('analysisState.points=[{rows, text:"同日同價"}];aShowPoint(0)');
  const html=u.get('#aPoint').innerHTML;assert.equal((html.match(/data-ac-add=/g)||[]).length,2);assert.match(html,/invoice/);select(u,'a');assert.equal(u.run('aComparison.picked.size'),1);
  u.run('analysisState.points=[{series:{kind:"market",points:[],metal:"steel"},point:{value:12,count:1,period:"2026-10"}}];aShowPoint(0)');assert.doesNotMatch(u.get('#aPoint').innerHTML,/data-ac-add/);
});
test('comparison displays original quantities, weight billing units, actual and theoretical weights, blanks and real zero',()=>{
  const u=setup([row('a',{price:0,processing_fee:0,original_unit_kg:0}),row('b',{pricing_basis:'weight',price:25,processing_fee:null,temper:'',piece_weight:null,weight_source:'theoretical'})]);select(u,'a');select(u,'b');
  const fields=u.run('aCompareFields([...aComparison.picked.values()])'),find=label=>fields.find(f=>f.label===label);
  assert.equal(find('原單單價與計價單位').values[0],'NT$ 0／件');assert.equal(find('原單單價與計價單位').values[1],'NT$ 25／公斤');
  assert.equal(find('原單數量與單位').values[1],'10 件');assert.equal(find('加工費').values[0],'NT$ 0');assert.equal(find('加工費').values[1],'NT$ 未列');
  assert.equal(find('單件重量').values[1],'未列 公斤');assert.equal(find('重量來源').values[1],'理論重量（估算）');assert.equal(find('供料／熱處理狀態').incomplete,true);assert.equal(find('稅別').incomplete,true);
});
test('material basis keeps original converted price separate from material kilogram price and never highlights a cheapest winner',()=>{
  const u=setup([row('a',{price_basis:'material',original_unit_kg:60,unit_kg:50}),row('b',{price_basis:'material',original_unit_kg:80,unit_kg:70})]);select(u,'a');select(u,'b');const fields=u.run('aCompareFields([...aComparison.picked.values()])');
  assert.deepEqual([...fields.find(f=>f.label==='換算公斤單價').values],['NT$ 60／公斤','NT$ 80／公斤']);assert.deepEqual([...fields.find(f=>f.label==='未稅材料公斤單價').values],['NT$ 50／公斤','NT$ 70／公斤']);
  const html=u.run('aComparisonHTML()');assert.doesNotMatch(html,/class="low|平均價|最佳價格/);assert.match(html,/最低公斤價不代表最佳採購選擇/);
});
test('differences use original values including ordered dimensions and unlisted is never asserted identical',()=>{
  const u=setup([row('a',{dims:[10,20,100],temper:''}),row('b',{dims:[20,10,100],temper:'',qty:20,weight_source:'theoretical',tax_status:'pretax'})]);select(u,'a');select(u,'b');
  const fields=u.run('aCompareFields([...aComparison.picked.values()])');for(const label of ['尺寸（mm，原單順序）','原單數量與單位','重量來源','稅別'])assert.equal(fields.find(f=>f.label===label).different,true);
  assert.equal(fields.find(f=>f.label==='供料／熱處理狀態').incomplete,true);assert.match(u.run('aComparisonHTML()'),/未列而無法確認相同/);
});
test('background refresh preserves IDs, updates content, removes unavailable or ineligible picks and explains removals',()=>{
  const u=setup();select(u,'a');select(u,'b');select(u,'c');const field=u.get('input');u.ctx.document.activeElement=field;
  u.ctx.next=[row('a',{price:99,original_unit_kg:495}),row('b',{eligible:false})];u.run('analysisState.result={observations:next,market_series:"sb-china-hrb"};aReconcileComparison(analysisState.result,{price_basis:"original"})');
  assert.equal(u.run('aComparison.picked.size'),1);assert.equal(u.run('[...aComparison.picked.values()][0].price'),99);assert.match(u.get('#aCompareMessage').textContent,/已移除 2 筆/);assert.equal(u.ctx.document.activeElement,field);
});
test('filter edits immediately clear selections and prevent additions until new analysis succeeds',()=>{
  const u=setup();select(u,'a');select(u,'b');u.run('aCompareChanged()');assert.equal(u.run('aComparison.picked.size'),0);assert.match(u.get('#aCompareMessage').textContent,/條件或價格口徑已變更/);select(u,'c');assert.equal(u.run('aComparison.picked.size'),0);
  u.run('aReconcileComparison(analysisState.result,{price_basis:"material"})');select(u,'c');assert.equal(u.run('aComparison.picked.size'),1);
});
test('programmatic filter and basis changes clear selections while automatic market resolution and key order do not',()=>{
  const u=setup();select(u,'a');select(u,'b');u.run('aReconcileComparison(analysisState.result,{market:"sb-china-hrb",price_basis:"original"})');assert.equal(u.run('aComparison.picked.size'),2);
  u.run('aReconcileComparison(analysisState.result,{price_basis:"material",market:"sb-china-hrb"})');assert.equal(u.run('aComparison.picked.size'),0);assert.match(u.get('#aCompareMessage').textContent,/已清除比較選擇/);
});
test('opening comparison reuses wide drawer and never changes chart observations, dates, point positions or original data',()=>{
  const u=setup();select(u,'a');select(u,'b');const before=JSON.stringify(u.ctx.rows);u.run('analysisState.points=[{row:rows[0],x:100,y:200}];aOpenComparison()');
  assert.equal(u.get('#drawerPanel').wide,true);assert.equal(u.get('#drawerPanel').attrs['aria-label'],'逐筆價格並排比較');assert.equal(JSON.stringify(u.ctx.rows),before);assert.equal(u.run('analysisState.points[0].x'),100);assert.match(u.get('#drawerPanel').innerHTML,/cmp a-price-compare/);
});
test('keyboard Tab stays in comparison and wraps to first or last control',()=>{
  const u=setup();u.run('aCompareInit()');select(u,'a');select(u,'b');u.run('aOpenComparison()');const first=u.get('first'),middle=u.get('middle'),last=u.get('last'),panel=u.get('#drawerPanel');panel.querySelectorAll=()=>[first,middle,last];
  let prevented=0;u.ctx.document.activeElement=last;u.events.get('document:keydown')({key:'Tab',shiftKey:false,preventDefault(){prevented++;}});assert.equal(u.ctx.document.activeElement,first);
  u.events.get('document:keydown')({key:'Tab',shiftKey:false,preventDefault(){prevented++;}});assert.equal(u.ctx.document.activeElement,middle);
  u.ctx.document.activeElement=first;u.events.get('document:keydown')({key:'Tab',shiftKey:true,preventDefault(){prevented++;}});assert.equal(u.ctx.document.activeElement,last);assert.equal(prevented,3);
});
test('horizontal scroll controls preserve focus and source actions resolve type plus detail ID',async()=>{
  const u=setup([row('same'),row('same',{kind:'quote',document_id:null})]);u.run('aCompareInit()');
  const invoke=attrs=>u.events.get('#drawer:click')({target:{closest:()=>({hasAttribute:key=>key in attrs,dataset:attrs})}});
  const region=u.get('.a-price-compare-wrap'),focus=u.get('scroll-button');region.clientWidth=600;u.ctx.document.activeElement=focus;
  await invoke({'data-ac-scroll':'1',acScroll:'1'});assert.equal(region.scrollLeft,430);assert.equal(u.ctx.document.activeElement,focus);
  await invoke({'data-ac-scroll':'-1',acScroll:'-1'});assert.equal(region.scrollLeft,0);
  const calls=[];u.ctx.aOpenQuote=async id=>calls.push(['quote',id]);u.ctx.aOpenReview=async id=>calls.push(['review',id]);u.ctx.openDetail=id=>calls.push(['origin',id]);
  await invoke({'data-ac-source':'',acSource:JSON.stringify(['quote','same']),acAction:'origin'});
  await invoke({'data-ac-source':'',acSource:JSON.stringify(['invoice','same']),acAction:'review'});
  await invoke({'data-ac-source':'',acSource:JSON.stringify(['invoice','same']),acAction:'origin'});
  assert.deepEqual(calls,[['quote','same'],['review','same'],['origin','same']]);
});
