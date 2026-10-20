'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function app(){
  const nodes=new Map();
  const get=s=>{if(!nodes.has(s))nodes.set(s,{dataset:{},innerHTML:'',textContent:'',listeners:{},addEventListener(k,fn){this.listeners[k]=fn;}});return nodes.get(s);};
  const document={querySelector:get,querySelectorAll:()=>[],addEventListener(){}};
  let copied;
  const context=vm.createContext({document,navigator:{clipboard:{writeText(value){copied=value;return Promise.resolve();}}},toast(){},setTimeout,clearTimeout});
  for(const file of ['state.js','billing.js','ui.js','tax.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),context);
  return {run:s=>vm.runInContext(s,context),get,copied:()=>copied};
}
test('round formatting preserves diameter then length and uses a cylinder without invalid coordinates',()=>{
  const ui=app();assert.equal(ui.run('dimStr([180,19])'),'Ø180.0 × 19.0');
  assert.equal(ui.run('dimStr([80,7,16])'),'7.0 × 16.0 × 80.0');
  assert.ok(Math.abs(ui.run('cm3([180,19])')-Math.PI*180**2*19/4000)<1e-7);
  const svg=ui.run('iso([180,19],[175,18])');assert.match(svg,/<ellipse/);assert.doesNotMatch(svg,/NaN|undefined/);
});
test('table and Excel copy preserve blank material and money while keeping round columns aligned',async()=>{
  const ui=app();
  ui.run(`SUP={zf:{name:'示範鋁業三廠',short:'示範鋁業三廠'}};records=[{id:'r',date:'2025-12-18',sup:'zf',label:'圓條70',grade:'',part_no:'DEMO-P301',shape:'round',dims:[70,107],qty:240,unit:'件',price:null,amount:null,total:null,tax:null,document_total:null,doc:'D1',note:'',src:'real'}];renderTable();`);
  assert.match(ui.get('#strip').innerHTML,/1 筆金額未列/);
  assert.match(ui.get('#tbl').innerHTML,/Ø70.0 × 107.0/);
  ui.get('#copyBtn').listeners.click();await Promise.resolve();
  const [head,row]=ui.copied().split('\n').map(v=>v.split('\t'));
  assert.equal(head.length,row.length);
  for(const col of ['材質分類','尺寸1(mm)','尺寸2(mm)','尺寸3(mm)','單價','明細金額'])assert.equal(row[head.indexOf(col)],'',col);
  assert.equal(row[head.indexOf('數量')],'240');assert.equal(row[head.indexOf('直徑(mm)')],'70');assert.equal(row[head.indexOf('長度(mm)')],'107');
});
test('weight billing displays original count and exports price units with appended fee columns',async()=>{
  const ui=app();
  ui.run(`SUP={sk:{name:'示範鋼材二廠',short:'示範鋼材二廠'}};records=[{id:'r',date:'2025-06-05',sup:'sk',label:'SKD11',grade:'SKD11',part_no:'',shape:'rect',dims:[13,32,210],qty:7,unit:'件',weight_kg:8.4,pricing_basis:'weight',price:125,material_amount:1050,processing_fee:490,amount:1540,total:1540,doc:'D1',note:'',src:'real'}];renderTable();`);
  const table=ui.get('#tbl').innerHTML;
  assert.match(table,/7 件/);assert.match(table,/8.4 公斤/);assert.match(table,/／公斤/);assert.match(table,/>490</);
  ui.get('#copyBtn').listeners.click();await Promise.resolve();
  const [head,row]=ui.copied().split('\n').map(v=>v.split('\t'));
  assert.equal(head.length,row.length);assert.equal(head[8],'計價單位');assert.equal(row[8],'公斤');
  assert.deepEqual(head.slice(19,25),['數量單位','重量(kg)','計價依據','計價數量','材料費','加工費']);
  assert.deepEqual(row.slice(19,25),['件','8.4','按重量','8.4','1050','490']);
});

test('ledger status is per-record, pending overrides saved eligibility and source diagnostics are escaped',()=>{
  const ui=app();ui.run(`var r={id:'r',document_id:'d',analysis_summary:{status:'usable',tax_unconfirmed:true,theoretical_weight:true,issues:[]}};queue=[{id:'d',status:'done'}]`);
  assert.match(ui.run('recordAnalysisHtml(r)'),/可分析/);assert.match(ui.run('recordAnalysisHtml(r)'),/稅別未確認/);assert.match(ui.run('recordAnalysisHtml(r)'),/理論重量估算/);
  ui.run("queue[0].status='pending'");assert.match(ui.run('recordAnalysisHtml(r)'),/原單待重新確認/);assert.doesNotMatch(ui.run('recordAnalysisHtml(r)'),/>可分析</);
  ui.run("queue[0].status='done';r.analysis_summary={status:'needs_review',reason:'<script>bad</script>',issues:[{message:'<b>問題</b>'}]} ");
  assert.doesNotMatch(ui.run('recordAnalysisHtml(r,true)'),/<script>|<b>/);assert.match(ui.run('recordAnalysisHtml(r,true)'),/&lt;b&gt;/);
});
