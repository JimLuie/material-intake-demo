'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/analysis.js'),'utf8').replace(/\naInit\(\);\s*$/,'');
const billing=fs.readFileSync(path.join(__dirname,'../public/billing.js'),'utf8');
function ui(){
  const nodes=new Map(),get=s=>{if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:'',value:'',disabled:false,hidden:false,setAttribute(){},querySelectorAll(){return [];}});return nodes.get(s);};
  const ctx=vm.createContext({console,Date,Math,Map,Set,Number,String,Array,JSON,Error,Promise,$:get,SUP:{hh:{short:'示範鋁材一廠'},sk:{short:'示範鋼材二廠'}},esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('"','&quot;')});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../public/tax.js"),"utf8"),ctx);vm.runInContext(billing,ctx);vm.runInContext(source,ctx);return {run:s=>vm.runInContext(s,ctx),get,ctx};
}
function row(overrides={}){return {id:'a',sup:'hh',kind:'invoice',grade:'S50C',date:'2025-06-05',doc:'A',dims:[8,60,128],shape:'rect',qty:36,unit:'件',pricing_basis:'quantity',price:110,processing_fee:null,weight:17.363,piece_weight:.4823,weight_source:'theoretical',price_basis:'original',tax_status:'unknown',analysis_cost:3960,original_price_cost:3960,original_unit_kg:228.07192144373676,unit_kg:228.07192144373676,eligible:true,...overrides};}
function fixture(){return {frequency:'monthly',price_basis:'original',baseline:null,market_series:'sb-china-hrb',fx_gaps:[],observations:[row(),row({id:'b',date:'2025-08-26',unit_kg:51.80612511997208,original_unit_kg:51.80612511997208,weight:66.015,price:570,qty:6})],series:[
  {kind:'invoice',sup:'hh',grade:'S50C',points:[{period:'2025-06',value:99999,count:2,ids:['a','b']}]},
  {kind:'market',metal:'steel',label:'中國熱軋鋼材出廠參考價',source:'SteelBenchmarker / SteelHome',region:'China',contract:'Ex-works',url:'https://steelbenchmarker.com/history.pdf',points:[{period:'2025-06',value:11.205349,count:2,first_observation:'2025-06-09',last_observation:'2025-06-23'},{period:'2025-07',value:13.7559975,count:2,first_observation:'2025-07-14',last_observation:'2025-07-28'}]}
]};}
function render(u,r=fixture()){u.ctx.fixture=r;u.run('analysisState.result=fixture;aRenderChart()');return u.get('#aChart').innerHTML;}
function points(u){return [...u.get('#aChart').innerHTML.matchAll(/<circle cx="([^"]+)" cy="([^"]+)"[^>]*data-a-point="(\d+)"/g)].map(m=>({x:+m[1],y:+m[2],id:+m[3]}));}
function supplierPoints(u){return points(u).filter(p=>u.run(`!!analysisState.points[${p.id}].rows`));}
function marketPoints(u){return points(u).filter(p=>u.run(`analysisState.points[${p.id}].series?.kind==='market'`));}

test('complete dimensions are required and round order is preserved',()=>{const u=ui();assert.equal(u.run("aParseDims('70 107','round').join(',')"),'70,107');assert.equal(u.run("aParseDims('7,16,80','rect').join(',')"),'7,16,80');for(const code of ["aParseDims('7,16','rect')","aParseDims('70,107,80','round')","aParseDims('0,16,80','rect')","aParseDims('NaN,16,80','rect')"])assert.throws(()=>u.run(code));assert.equal(u.run("aParseDims('','rect',true)"),null);});
test('missing market periods break lines and a single point has no line',()=>{const u=ui();assert.equal(u.run("aSegments([{period:'2026-01'},{period:'2026-03'}],aPeriods('2026-01','2026-03','monthly')).length"),2);assert.equal(u.run("aSegments([{period:'2026-01'},{period:'2026-02'}],aPeriods('2026-01','2026-02','monthly')).length"),1);assert.equal(u.run("aPeriods('2026-01-05','2026-01-19','weekly').join(',')"),'2026-01-05,2026-01-12,2026-01-19');});
test('all eligible invoice lines remain separate and aggregate supplier series is ignored',()=>{
  const u=ui(),r=fixture();r.observations[1].date='2025-06-06';const html=render(u,r),p=supplierPoints(u);
  assert.equal(p.length,2);assert.ok(p[0].x<p[1].x);assert.equal(u.run('analysisState.points.filter(p=>p.rows).flatMap(p=>p.rows).length'),2);
  assert.equal([...html.matchAll(/class="a-line"/g)].length,1);assert.doesNotMatch(html,/99999\/kg|stroke-dasharray/);
  assert.match(u.get('#aChartCaption').textContent,/不平均、不連線/);
});
test('supplier dates use a continuous calendar axis while market periods use their midpoint',()=>{
  const u=ui(),r=fixture();r.observations=[row({date:'2025-06-01'}),row({id:'b',date:'2025-06-11',unit_kg:100}),row({id:'c',date:'2025-07-01',unit_kg:110})];render(u,r);
  const p=supplierPoints(u);assert.ok(Math.abs((p[1].x-p[0].x)/(p[2].x-p[0].x)-10/30)<1e-8);
  const m=marketPoints(u);assert.ok(Math.abs((m[0].x-p[0].x)/(p[2].x-p[0].x)-.5)<1e-8);
  assert.match(u.get('#aLegend').innerHTML,/月均價/);
});
test('UTC date validation rejects rollovers and month and week centers survive timezone changes',()=>{
  const u=ui();assert.ok(Number.isNaN(u.run("aDay('2026-02-30')")));assert.ok(Number.isNaN(u.run("aDay('bad')")));
  const feb=u.run("aPeriodRange('2024-02','monthly')");assert.equal((feb.end-feb.start)/86400000,29);assert.equal((feb.mid-feb.start)/86400000,14.5);
  const week=u.run("aPeriodRange('2026-03-02','weekly')");assert.equal((week.mid-week.start)/86400000,3.5);
});
test('international axis includes ten-percent padding and readable nonzero ticks',()=>{
  const u=ui(),a=u.run('aMarketAxis([11.205349,13.7559975])');assert.ok(a.min>0);assert.ok(a.min<=11.205349-2.5506485*.1);assert.ok(a.max>=13.7559975+2.5506485*.1);assert.ok(a.ticks.length>=3&&a.ticks.length<=8);
});
test('constant, single, zero and missing international values never collapse the scale',()=>{
  const u=ui();for(const values of [[12],[12,12],[0],[0,0],[],[null,'',NaN,Infinity],[.00001],[1e9]]){u.ctx.values=values;const a=u.run('aMarketAxis(values)');assert.ok(a.max>a.min);assert.ok(a.min>=0);assert.ok(a.ticks.every(Number.isFinite));for(const v of values.filter(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0))assert.ok(v>=a.min&&v<=a.max);}
  assert.ok(u.run('aMarketAxis([12]).min')<=11.4);assert.ok(u.run('aMarketAxis([12]).max')>=12.6);
});
test('actual line prices and steel reference have independent axes and only market lines',()=>{
  const u=ui(),html=render(u),p=supplierPoints(u),m=marketPoints(u);assert.match(html,/data-axis="right"/);assert.match(html,/左軸 · 供應商 NT\$／公斤/);assert.match(html,/右軸 · 國際參考價 NT\$／公斤/);
  assert.ok(Math.abs(m[0].y-m[1].y)>120);assert.ok(Math.abs(p[0].y-(316-228.07192144373676/250*276))<.001);assert.match(html,/data-axis="left"[^>]*>0<\/text>/);assert.doesNotMatch(html,/NaN|Infinity/);
  assert.match(u.get('#aAxisNote').textContent,/兩側尺度不同/);assert.match(u.get('#aLegend').innerHTML,/逐筆成交/);
});
test('only left ticks have grid lines and right labels fit reserved margins',()=>{
  const u=ui(),html=render(u);assert.equal([...html.matchAll(/class="a-grid"/g)].length,[...html.matchAll(/data-axis="left"/g)].length);const right=[...html.matchAll(/data-axis="right"[^>]*x="([^"]+)"/g)];assert.ok(right.length);assert.ok(right.every(m=>+m[1]<960));
});
test('single supplier and market-only modes use a single appropriate left axis',()=>{
  const u=ui(),r=fixture();r.series=r.series.slice(0,1);let html=render(u,r);assert.doesNotMatch(html,/data-axis="right"|class="a-line"/);assert.equal(supplierPoints(u).length,2);assert.equal(u.get('#aAxisNote').hidden,true);
  const market=fixture();market.observations=[];html=render(u,market);assert.doesNotMatch(html,/data-axis="right"/);assert.match(html,/國際參考價 · NT\$／公斤/);assert.doesNotMatch(html,/data-axis="left"[^>]*>0<\/text>/);assert.match(u.get('#aAxisNote').textContent,/自動縮放/);
});
test('daily and weekly market points stay within the time axis including a sole observation',()=>{
  for(const frequency of ['daily','weekly']){const u=ui(),r=fixture();r.observations=[];r.frequency=frequency;r.series[1].points=[{period:'2026-03-02',value:12,count:1}];render(u,r);const p=marketPoints(u)[0];assert.ok(p.x>=80&&p.x<=932);assert.ok(p.y>=40&&p.y<=316);assert.match(u.get('#aLegend').innerHTML,frequency==='weekly'?/週均價/:/當日觀測均價/);}
});
test('single supplier point and zero prices remain visible without fictitious averages',()=>{
  const u=ui(),r=fixture();r.series=[];r.observations=[row({unit_kg:0,original_unit_kg:0,price:0})];const html=render(u,r),p=supplierPoints(u)[0];assert.ok(Number.isFinite(p.x));assert.ok(p.y===316);u.run('aShowPoint(0)');assert.match(u.get('#aPoint').innerHTML,/NT\$ 0／件/);assert.match(u.get('#aPoint').innerHTML,/NT\$ 0／公斤/);assert.doesNotMatch(html,/class="a-line"/);
});
test('fixed specifications retain each filtered line without a common baseline dependency',()=>{
  const u=ui();u.run("analysisState.view='fixed';analysisState.fixed={grade:'S50C',temper:'退火',dims:[8,60,128],qty:36}");const html=render(u);assert.match(html,/data-axis="right"/);assert.equal(supplierPoints(u).length,2);assert.match(u.get('#aChartCaption').textContent,/固定規格/);assert.equal(u.run('analysisState.fixed.qty'),36);
  u.run('analysisState.fixed=null;aRenderChart()');assert.match(u.get('#aChart').innerHTML,/請填寫並套用/);
});
test('exact overlapping dates and prices expose every source without averaging, jitter or duplicate counting',()=>{
  const u=ui(),r=fixture();r.observations=[row(),row({id:'b',sup:'sk',qty:7,weight_source:'actual'}),row({id:'c',eligible:false,reason:'重複單據，已合併來源'}),row({id:'d',date:'2025-06-06'})];const html=render(u,r),p=supplierPoints(u);
  assert.equal(p.length,2);const group=p.find(p=>u.run(`analysisState.points[${p.id}].rows.length===2`));assert.ok(group);assert.match(html,/class="a-overlap-count"/);assert.match(html,/linearGradient/);u.run(`aShowPoint(${group.id})`);const detail=u.get('#aPoint').innerHTML;
  assert.match(detail,/同日同價 2 筆/);assert.equal([...detail.matchAll(/class="a-source-detail"/g)].length,2);assert.match(detail,/數量<\/dt><dd>36 件/);assert.match(detail,/數量<\/dt><dd>7 件/);assert.doesNotMatch(detail,/data-a-review="c"/);
});
test('close but unequal prices remain independent points and marker sizes do not depend on quantity',()=>{
  const u=ui(),r=fixture();r.observations=[row(),row({id:'b',qty:3000,unit_kg:228.072})];const html=render(u,r);assert.equal(supplierPoints(u).length,2);assert.doesNotMatch(html,/a-overlap-count/);assert.ok([...html.matchAll(/<circle[^>]*r="([^"]+)"/g)].every(m=>+m[1]===5));
});
test('supplier colors are consistent across filters and theoretical vs actual points retain fill distinction',()=>{
  const u=ui(),r=fixture();r.observations[1].sup='sk';r.observations[1].weight_source='actual';let html=render(u,r);const sk=u.run("aSupplierColor('sk')");assert.ok(html.includes('fill="'+sk+'"'));assert.match(html,/fill="var\(--sheet\)"/);r.observations=[r.observations[1]];render(u,r);assert.equal(u.run("aSupplierColor('sk')"),sk);
});
test('monthly vs daily market aggregation never changes supplier prices or observation count',()=>{
  const u=ui(),r=fixture();render(u,r);const before=u.run('analysisState.points.filter(p=>p.rows).map(p=>p.rows[0].unit_kg).join()');r.frequency='daily';r.series[1].points=[{period:'2025-07-14',value:12,count:1}];render(u,r);assert.equal(u.run('analysisState.points.filter(p=>p.rows).map(p=>p.rows[0].unit_kg).join()'),before);assert.equal(supplierPoints(u).length,2);
});
test('plate and aluminium use the same independent reference scaling',()=>{
  for(const [metal,label,grade]of [['steel','中國標準鋼板','S50C'],['aluminum','世界銀行鋁月均價','7075']]){const u=ui(),r=fixture();r.observations.forEach(row=>row.grade=grade);Object.assign(r.series[1],{metal,label});r.series[1].points.forEach(p=>p.value*=3);const html=render(u,r);assert.match(html,/data-axis="right"/);assert.ok(u.get('#aLegend').innerHTML.includes(label));}
});
test('missing market periods and exchange rates leave gaps but keep eligible supplier points',()=>{
  const u=ui(),r=fixture();r.fx_gaps=['2025-07-14'];r.series[1].points[1].period='2025-08';const html=render(u,r);assert.doesNotMatch(html,/class="a-line"/);assert.equal(points(u).length,4);assert.match(u.get('#aChartCaption').textContent,/1 個期間缺匯率/);
});
test('ineligible, blank and invalid values are excluded while explicitly zero values stay',()=>{
  const u=ui(),r=fixture();r.observations=[row({eligible:false}),row({id:'b',unit_kg:null}),row({id:'c',unit_kg:0,date:'bad'}),row({id:'d',unit_kg:0})];r.series[1].points=[null,'',NaN,Infinity,-1,0].map((value,i)=>({period:'2025-'+String(i+1).padStart(2,'0'),value,count:1}));const html=render(u,r);assert.equal(supplierPoints(u).length,1);assert.equal(marketPoints(u).length,1);assert.doesNotMatch(html,/NaN|Infinity/);
});
test('source details distinguish original piece price, converted kg price, weight and blank processing fee',()=>{
  const u=ui();render(u);const p=supplierPoints(u)[0];u.run(`aShowPoint(${p.id})`);const html=u.get('#aPoint').innerHTML;assert.match(html,/原單單價<\/dt><dd>NT\$ 110／件/);assert.match(html,/換算公斤單價<\/dt><dd>NT\$ 228.072／公斤/);assert.match(html,/加工費<\/dt><dd>NT\$ 未列/);assert.match(html,/數量<\/dt><dd>36 件/);assert.match(html,/理論重量（估算）/);assert.match(html,/稅別未確認/);assert.match(html,/data-a-review="a"/);assert.doesNotMatch(html,/未稅材料公斤單價<\/dt>/);
});
test('weight billing still shows original piece quantity and kg price with explicit zero fee',()=>{
  const u=ui(),r=fixture();r.observations=[row({qty:7,pricing_basis:'weight',weight_kg:8.4,weight:8.4,weight_source:'actual',price:125,unit_kg:125,original_unit_kg:125,processing_fee:0,tax_status:'included:5'})];render(u,r);u.run(`aShowPoint(${supplierPoints(u)[0].id})`);const html=u.get('#aPoint').innerHTML;assert.match(html,/原單單價<\/dt><dd>NT\$ 125／公斤/);assert.match(html,/數量<\/dt><dd>7 件/);assert.match(html,/整筆重量<\/dt><dd>8.4 公斤 · 實重/);assert.match(html,/加工費<\/dt><dd>NT\$ 0/);assert.match(html,/含稅 5%/);
});
test('material-cost mode plots net kg price while displaying original converted kg price separately',()=>{
  const u=ui(),r=fixture();r.price_basis='material';r.observations=[row({price_basis:'material',unit_kg:90,original_unit_kg:125})];render(u,r);const p=supplierPoints(u)[0];assert.match(u.run(`analysisState.points[${p.id}].text`),/90\/kg/);u.run(`aShowPoint(${p.id})`);const html=u.get('#aPoint').innerHTML;assert.match(html,/換算公斤單價<\/dt><dd>NT\$ 125／公斤/);assert.match(html,/未稅材料公斤單價<\/dt><dd>NT\$ 90／公斤/);
});
test('missing original prices in valid material-cost observations remain unlisted',()=>{
  const u=ui(),r=fixture();r.observations=[row({price_basis:'material',price:null,original_unit_kg:null,unit_kg:90})];render(u,r);u.run(`aShowPoint(${supplierPoints(u)[0].id})`);assert.match(u.get('#aPoint').innerHTML,/原單單價<\/dt><dd>NT\$ 未列／件/);assert.match(u.get('#aPoint').innerHTML,/換算公斤單價<\/dt><dd>NT\$ 未列／公斤/);
});
test('market details retain actual observation cutoff, count, signed price change and source link',()=>{
  const u=ui();render(u);u.run(`aShowPoint(${marketPoints(u)[1].id})`);const html=u.get('#aPoint').innerHTML;assert.match(html,/13.756／公斤/);assert.match(html,/2 筆觀測/);assert.match(html,/觀察截至 2025-07-28/);assert.match(html,/2025-06 → 2025-07/);assert.match(html,/\+2.551／公斤/);assert.match(html,/\+22.76%/);assert.match(html,/查看公開來源/);assert.match(html,/月均價/);
});
test('previous effective observation handles gaps, decreases, unchanged prices and zero denominator',()=>{
  const u=ui();u.run("var s={points:[{period:'2026-01',value:20},{period:'2026-03',value:15},{period:'2026-04',value:15}]}");const c=u.run('aMarketChange(s,s.points[1])');assert.equal(c.previous,'2026-01');assert.equal(c.delta,-5);assert.equal(c.percent,-25);assert.equal(u.run('aMarketChange(s,s.points[2]).percent'),0);assert.equal(u.run('aSignedChange(-0)'),'0');
  const r=fixture();r.series[1].points[0].value=0;render(u,r);u.run(`aShowPoint(${marketPoints(u)[0].id})`);assert.match(u.get('#aPoint').innerHTML,/沒有前次有效資料/);u.run(`aShowPoint(${marketPoints(u)[1].id})`);assert.match(u.get('#aPoint').innerHTML,/前值為 0/);assert.doesNotMatch(u.get('#aPoint').innerHTML,/Infinity|NaN/);
});
test('procurement-weight scatter retains original axes, marker sizing and now has complete source detail',()=>{
  const u=ui(),r=fixture();u.run("analysisState.view='scatter'");const html=render(u,r);assert.match(html,/整批重量（公斤）/);assert.doesNotMatch(html,/data-axis="right"|class="a-line"/);assert.match(u.get('#aChartCaption').textContent,/圓點面積代表單件重量/);assert.equal(u.run('analysisState.points.length'),2);u.run('aShowPoint(0)');assert.match(u.get('#aPoint').innerHTML,/原單單價/);assert.match(u.get('#aPoint').innerHTML,/換算公斤單價/);
});
test('quote observations retain quote actions and never get relabeled as transactions',()=>{
  const u=ui(),r=fixture();u.get('#aFilters [name=kind]').value='quote';r.observations=[row({kind:'quote'})];render(u,r);assert.match(u.get('#aLegend').innerHTML,/逐筆報價/);u.run(`aShowPoint(${supplierPoints(u)[0].id})`);assert.match(u.get('#aPoint').innerHTML,/data-a-quote="a"/);assert.doesNotMatch(u.get('#aPoint').innerHTML,/data-a-review/);
});
test('supplier date and price details preserve escaped source content',()=>{
  const u=ui(),r=fixture();r.observations=[row({doc:'<script>',unit:'<件>'})];render(u,r);u.run(`aShowPoint(${supplierPoints(u)[0].id})`);assert.doesNotMatch(u.get('#aPoint').innerHTML,/<script>|<件>/);assert.match(u.get('#aPoint').innerHTML,/&lt;script>/);
});
test('chart, source detail and filters remain pure with no mutation of API data or input nodes',()=>{
  const u=ui(),r=fixture(),before=JSON.stringify(r);u.get('#aFilters').value='keep';u.get('#aFilters [name=market]').value='sb-china-plate';u.get('#reviewScroll').innerHTML='focused input';render(u,r);u.run(`aShowPoint(${supplierPoints(u)[0].id})`);assert.equal(JSON.stringify(r),before);assert.equal(u.get('#aFilters').value,'keep');assert.equal(u.get('#aFilters [name=market]').value,'sb-china-plate');assert.equal(u.get('#reviewScroll').innerHTML,'focused input');
});
test('common-baseline UI is removed and the frequency control explicitly applies to international reference',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');assert.doesNotMatch(html,/id="aScale"|共同基期＝100/);assert.match(html,/行情彙整頻率/);assert.doesNotMatch(source,/analysisState.scale|\$\('#aScale'\)/);
});
test('every source point remains focusable and supports Enter and Space activation',()=>{
  const u=ui(),html=render(u);assert.equal([...html.matchAll(/tabindex="0"/g)].length,points(u).length);assert.equal([...html.matchAll(/role="button"/g)].length,points(u).length);assert.match(source,/\['Enter',' '\].includes\(e.key\)/);assert.match(source,/addEventListener\('focusin'/);
});
test('readable zero-based supplier scale covers small and large prices',()=>{
  const u=ui();for(const max of [0,.03,57.38,229.87,126.85,1e7]){const a=u.run(`aNiceAxis(${max})`);assert.ok(a.max>=max);assert.ok(a.ticks.length<=7);assert.equal(a.ticks[0],0);}assert.equal(u.run('aNiceAxis(229.87).ticks.join(",")'),'0,50,100,150,200,250');assert.equal(u.run('aNumber(null)'),'未列');assert.equal(u.run('aNumber(0)'),'0');
});
test('market updater retains independent source success and cache failure reports',()=>{
  const u=ui();u.ctx.result={reports:[{name:'中國熱軋鋼材',ok:true,count:40,cached_count:492,latest:'2026-10-12'},{name:'鋁價',ok:false,count:0,cached_count:801,latest:'2026-09',error:'offline'}]};const t=u.run('aMarketReport(result)');assert.match(t,/更新成功 40 筆/);assert.match(t,/快取 492 筆，最新觀察 2026-10-12/);assert.match(t,/更新失敗，保留快取/);assert.match(t,/offline/);
});

test('procurement filters omit blank ranges and inactive quantity unit while retaining one-sided decimals',()=>{
  const u=ui();assert.equal(u.run("JSON.stringify(aPurchaseFilters({qty_min:'',qty_max:' ',qty_unit:'支',piece_weight_min:'',temper_filter:''}))"),'{}');
  assert.equal(u.run("JSON.stringify(aPurchaseFilters({qty_min:'5.5',qty_max:'10',qty_unit:'件',piece_weight_max:'.2',temper_filter:'value:退火'}))"),JSON.stringify({qty_min:5.5,qty_max:10,qty_unit:'件',piece_weight_max:.2,temper:'退火'}));
  assert.equal(u.run("aPurchaseFilters({qty_max:'10'}).qty_unit"),'件');
  assert.equal(u.run("aPurchaseFilters({temper_filter:'missing'}).temper_missing"),true);
  assert.equal(u.run("aPurchaseFilters({temper_filter:'value:missing'}).temper"),'missing');
});
test('invalid procurement inputs and reversed ranges cannot silently become unrestricted',()=>{
  const u=ui();for(const key of ['qty_min','qty_max','piece_weight_min','piece_weight_max'])for(const value of ['0','-1','NaN','Infinity','-Infinity','abc'])assert.throws(()=>u.run(`aPurchaseFilters({${key}:${JSON.stringify(value)}})`),/有限正數/);
  for(const prefix of ['qty','piece_weight'])assert.throws(()=>u.run(`aPurchaseFilters({${prefix}_min:2,${prefix}_max:1})`),/最小值不得大於最大值/);
  u.get('#aFilters').querySelectorAll=()=>[{validity:{badInput:true}}];assert.throws(()=>u.run('aFilters()'),/有限正數/);
});
test('procurement conditions intersect fixed exact specifications and leave international settings intact',()=>{
  const u=ui();u.ctx.raw={qty_min:'5',qty_max:'10',qty_unit:'件',piece_weight_min:'.1',temper_filter:'value:退火',dims_text:'8,17,81',shape:'rect',grade:'S50C',frequency:'weekly',market:'sb-china-hrb',start:'2026-01-01',end:'2026-03-31'};
  u.run("aFormObject=()=>({...raw});analysisState.view='fixed';analysisState.fixed={grade:'S50C',temper:'退火',shape:'rect',dims:[8,17,81],qty:10,unit:'件'}");
  const filters=u.run('aFilters()');assert.equal(filters.qty_min,5);assert.equal(filters.piece_weight_min,.1);assert.equal(filters.fixed.qty,10);assert.equal(filters.temper,'退火');assert.equal(filters.frequency,'weekly');assert.equal(filters.market,'sb-china-hrb');assert.equal(filters.dims,undefined);assert.equal(u.ctx.raw.qty_min,'5');
});
test('missing piece-weight exclusions and quantity units use response counts with clear single-piece wording',()=>{
  const u=ui();u.run("aRenderPurchaseHint({qty_min:1,qty_unit:'支',piece_weight_max:.5,temper_missing:true},{filter_counts:{missing_piece_weight:7}})");
  const text=u.get('#aPurchaseHint').textContent;assert.match(text,/單件重量/);assert.match(text,/排除 7 筆/);assert.match(text,/「支」/);assert.match(text,/不同數量單位不混比/);assert.match(text,/國際行情沿用原日期/);assert.equal(u.get('#aPurchaseHint').hidden,false);
  u.run('aRenderPurchaseHint({},{filter_counts:{missing_piece_weight:999}})');assert.equal(u.get('#aPurchaseHint').hidden,true);
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');assert.match(html,/不是整筆採購重量/);assert.match(html,/name="qty_unit"><option value="件">件/);assert.match(html,/name="piece_weight_min"/);assert.match(html,/相近條件不等於完全相同規格/);
});
test('a background response started before a filter edit never replaces entered content, focus or applied results',async()=>{
  const u=ui();let release;u.ctx.api=()=>new Promise(resolve=>release=resolve);u.run("aFilters=()=>({grade:'S50C'});analysisState.result={marker:'previous'}");
  const field=u.get('#aFilters [name=qty_min]');field.value='5';u.ctx.document={activeElement:field};const task=u.run('loadAnalysis()');
  field.value='5.5';u.run('analysisState.filterRevision++');release({marker:'stale'});await task;
  assert.equal(field.value,'5.5');assert.equal(u.ctx.document.activeElement,field);assert.equal(u.run('analysisState.result.marker'),'previous');assert.equal(u.get('#aError').textContent,'');
});
