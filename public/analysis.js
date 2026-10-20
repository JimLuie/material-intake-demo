'use strict';
// Analysis has its own state and forms. Polling the ledger never reconstructs these inputs.
const analysisState={tab:'compare',view:'trend',result:null,seq:0,filterRevision:0,fixed:null,points:[],preview:null,pendingQuote:null,quoteRequestId:null,quotes:[],loaded:false,listStatus:'all',category:'',categoryName:'',appliedFilters:null};
const ANALYSIS_COLORS=['#5475ef','#dd7a25','#209580','#b05abd','#d5506d','#608b34','#917546'];
function aMarketReport(result){
  if(result.reports)return result.reports.map(r=>`${r.name}：${r.ok?'更新成功 '+r.count+' 筆':'更新失敗，保留快取'}；快取 ${r.cached_count} 筆，最新觀察 ${r.latest||'尚無'}${r.error?'（'+r.error+'）':''}`).join('\n');
  return Object.entries(result.results).map(([key,r])=>`${key}：${r.count} 筆，至 ${r.latest}`).join('；')+(result.errors.length?'。保留既有快取：'+result.errors.join('；'):'');
}
function aNumber(value){return value==null||value===''?'未列':Number(value).toLocaleString('zh-TW',{maximumFractionDigits:3});}
function aDims(r){return (r.shape==='round'?'Ø':'')+(r.dims||[]).map(aNumber).join(' × ')+' mm';}
function aBasis(b){return b==='gross'?'含稅成交公斤價（含加工費）':b==='original'?'原單單價換算':'未稅純材料公斤價';}
function aTax(status='unknown'){const [basis,rate]=status.split(':');return basis==='pretax'?'未稅':basis==='included'?'含稅 '+aNumber(rate)+'%':'稅別未確認';}
function aName(s){return s.kind==='market'?s.label:`${SUP[s.sup]?.short||s.sup} · ${s.grade} · ${s.weight_source==='actual'?'實重':'理論重量'} · ${aBasis(s.price_basis)}${s.price_basis==='original'?' · '+aTax(s.tax_status):''}`;}
function aNiceAxis(value){
  const target=Math.max(value||0,1)/5,power=10**Math.floor(Math.log10(target)),fraction=target/power;
  const step=([1,2,2.5,5,10].find(v=>v>=fraction)||10)*power,max=Math.ceil(Math.max(value||0,1)/step)*step;
  return {max,ticks:Array.from({length:Math.round(max/step)+1},(_,i)=>Number((i*step).toPrecision(12)))};
}
function aValidPrice(value){return value!=null&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0;}
function aMarketAxis(values){
  const valid=values.filter(aValidPrice).map(Number);
  if(!valid.length)return {min:0,max:1,step:.2,ticks:[0,.2,.4,.6,.8,1]};
  const low=Math.min(...valid),high=Math.max(...valid),span=high-low;
  const padding=span>0?span*.1:Math.max(high*.05,.1);
  const lower=Math.max(0,low-padding),upper=high+padding,target=(upper-lower)/5;
  const power=10**Math.floor(Math.log10(target)),fraction=target/power;
  const step=([1,2,2.5,5,10].find(v=>v>=fraction)||10)*power;
  const min=Math.floor(lower/step)*step,max=Math.ceil(upper/step)*step;
  return {min,max,step,ticks:Array.from({length:Math.round((max-min)/step)+1},(_,i)=>Number((min+i*step).toPrecision(15)))};
}
function aAxisNumber(value,step){
  if(Math.abs(value)>=1e7||(value!==0&&Math.abs(value)<1e-8))return value.toExponential(2);
  const digits=step?Math.max(3,Math.min(12,1-Math.floor(Math.log10(step)))):3;
  return value.toLocaleString('zh-TW',{maximumFractionDigits:digits});
}
function aMarketChange(series,point){
  const points=(series.points||[]).filter(p=>aValidPrice(p.value)).slice().sort((a,b)=>a.period.localeCompare(b.period));
  const i=points.findIndex(p=>p.period===point.period);
  if(i<=0||!aValidPrice(point.value))return null;
  const previous=points[i-1],delta=Number(point.value)-Number(previous.value);
  return {previous:previous.period,delta,percent:Number(previous.value)===0?null:delta/Number(previous.value)*100};
}
function aSignedChange(value,digits=3){
  const n=Number(value.toFixed(digits));
  return n===0?'0':(n>0?'+':'')+aNumber(n);
}
function aFilterNotice(message=''){$('#aFilterNotice').textContent=message;$('#aFilterNotice').hidden=!message;}
function aError(message=''){$('#aError').textContent=message;$('#aError').hidden=!message;}
function aFormObject(form){const result=Object.fromEntries(new FormData(form));for(const field of form.querySelectorAll('input[type=checkbox]'))result[field.name]=field.checked;return result;}
function aParseDims(text,shape,optional=false){
  const raw=String(text||'').trim();if(!raw&&optional)return null;
  const values=raw.split(/[,，xX×*\s]+/).filter(Boolean).map(Number);
  if(values.length!==(shape==='round'?2:3)||values.some(v=>!Number.isFinite(v)||v<=0))throw Error(shape==='round'?'請填直徑、長度兩個正數。':'請填三個完整尺寸，以逗號或空格分開。');
  return values;
}
function aPurchaseFilters(values){
  const result={...values};
  for(const [prefix,label]of [['qty','採購數量'],['piece_weight','單件重量（公斤）']]){
    for(const suffix of ['min','max']){
      const key=prefix+'_'+suffix,raw=result[key];
      if(raw==null||String(raw).trim()===''){delete result[key];continue;}
      const value=Number(raw);
      if(!Number.isFinite(value)||value<=0)throw Error(label+(suffix==='min'?'最小值':'最大值')+'須為有限正數');
      result[key]=value;
    }
    if(result[prefix+'_min']!=null&&result[prefix+'_max']!=null&&result[prefix+'_min']>result[prefix+'_max'])throw Error(label+'最小值不得大於最大值');
  }
  if(result.qty_min==null&&result.qty_max==null)delete result.qty_unit;
  else result.qty_unit=String(result.qty_unit||'件');
  const temper=result.temper_filter||'';delete result.temper_filter;
  if(temper==='missing')result.temper_missing=true;
  else if(temper.startsWith('value:'))result.temper=temper.slice(6);
  return result;
}
function aFilters(){
  const form=$('#aFilters');
  if([...form.querySelectorAll('[data-a-range]')].some(field=>field.validity?.badInput))throw Error('採購數量與單件重量須為有限正數，或留白不限。');
  const values=aPurchaseFilters(aFormObject(form));const dims=values.dims_text.trim();delete values.dims_text;
  if(dims){if(!values.shape)throw Error('使用精確尺寸篩選時，請先選擇形狀。');values.dims=aParseDims(dims,values.shape);}
  if(analysisState.view==='fixed'&&analysisState.fixed){Object.assign(values,{fixed:analysisState.fixed,grade:analysisState.fixed.grade,shape:analysisState.fixed.shape});delete values.dims;}
  return values;
}
function aOptions(select,options,first,currentLabel=value=>value){
  const current=select.value,html=(first?`<option value="">${esc(first)}</option>`:'')+options.map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('');
  if(select.dataset.options===html)return;
  select.innerHTML=html;select.dataset.options=html;
  if(current&&![...select.options].some(o=>o.value===current)){const option=document.createElement('option');option.value=current;option.textContent=currentLabel(current)+'（目前無資料）';select.append(option);}
  if([...select.options].some(o=>o.value===current))select.value=current;
}
async function loadAnalysis(){
  const seq=++analysisState.seq,revision=analysisState.filterRevision;let filters;
  $('#aLoadStatus').textContent='正在更新分析…';$('#aCompare').setAttribute('aria-busy','true');
  try{
    filters=aFilters();aError();
    const result=await api('/api/analysis?filter='+encodeURIComponent(JSON.stringify(filters)));
    if(seq!==analysisState.seq||revision!==analysisState.filterRevision)return;
    analysisState.result=result;
    analysisState.appliedFilters=structuredClone(filters);
    if(typeof aReconcileComparison==='function')aReconcileComparison(result,filters);
    const grades=result.grades.filter(g=>!filters.metal||result.grade_metals[g]===filters.metal);
    aOptions($('#aFilters [name=grade]'),grades.map(g=>[g,g]),'全部牌號（分開繪圖）');
    aOptions($('#aFixed [name=grade]'),grades.map(g=>[g,g]),'請選擇');
    const suppliers=Object.entries(SUP).filter(([k])=>k!=='xx').map(([k,v])=>[k,v.name]);
    aOptions($('#aFilters [name=sup]'),suppliers,'全部供應商');aOptions($('#aQuoteForm [name=sup]'),suppliers,'請選擇');
    aOptions($('#aFilters [name=qty_unit]'),['件',...(result.filter_options?.quantity_units||[]).filter(u=>u!=='件')].map(u=>[u,u]));
    aOptions($('#aFilters [name=temper_filter]'),[['missing','未列（只表示資料未列）'],...(result.filter_options?.tempers||[]).map(t=>['value:'+t,t])],'不限',value=>value.startsWith('value:')?value.slice(6):'未列');
    const markets=result.sources.filter(s=>s.metal===filters.metal);
    aOptions($('#aFilters [name=market]'),markets.map(s=>[s.series,`${s.label} · ${s.observation_frequency==='semi-monthly'?'實際觀測日':s.frequency==='monthly'?'月':'日'} · ${s.source}`]),markets.length?'自動選擇適用行情':filters.metal==='steel'?'尚無鋼價，先顯示採購資料':'尚無鋁價，先顯示採購資料');
    if(!filters.market&&result.market_series)$('#aFilters [name=market]').value=result.market_series;
    const fx=[...new Set(['cbc',...result.fx_sources.map(s=>s.source)])];aOptions($('#aFilters [name=fx_source]'),fx.map(s=>[s,s==='cbc'?'中央銀行（cbc）':s]));
    if(!analysisState.loaded){for(const [grade,value]of Object.entries(result.settings.densities)){const input=$('#aDensity [name="'+grade+'"]');if(input)input.value=value;const source=$('#aDensity [name="source_'+grade+'"]');if(source)source.value=result.settings.density_sources[grade];}analysisState.loaded=true;}
    $('#aExport').href='/api/analysis/export.csv?filter='+encodeURIComponent(JSON.stringify(filters));
    aRenderStats();aRenderChart();aRenderRows();aRenderSources();aRenderPurchaseHint(filters,result);
    if(typeof aRestoreReturn==='function')aRestoreReturn();
    if(analysisState.tab==='quotes')await aLoadQuotes();
  }catch(error){if(seq===analysisState.seq)aError(error.message);}
  finally{if(seq===analysisState.seq){$('#aLoadStatus').textContent='';$('#aCompare').setAttribute('aria-busy','false');}}
}
function aRenderPurchaseHint(filters,result){
  const hints=[];
  if(filters.qty_min!=null||filters.qty_max!=null)hints.push('採購數量僅比較「'+filters.qty_unit+'」，不同數量單位不混比。');
  if(filters.piece_weight_min!=null||filters.piece_weight_max!=null)hints.push('單件重量範圍已套用；另排除 '+(result.filter_counts?.missing_piece_weight||0)+' 筆缺少可用單件重量的紀錄（其他採購條件篩選後）。');
  if(filters.temper_missing)hints.push('「未列」僅代表資料未列，不能視為已確認具有相同供料／熱處理狀態。');
  if(hints.length)hints.push('採購條件只篩選供應商紀錄；國際行情沿用原日期與彙整規則。');
  $('#aPurchaseHint').textContent=hints.join(' ');$('#aPurchaseHint').hidden=!hints.length;
  aSyncMoreFilters();
}
// Presentation only: the collapsed "更多條件" summary shows how many of its conditions are in effect.
function aSyncMoreFilters(){
  const more=$('#aMoreFilters'),count=$('#aMoreCount');if(!more?.querySelectorAll||!count)return;
  const set=[...more.querySelectorAll('select,input')].filter(field=>field.tagName==='SELECT'?field.name!=='qty_unit'&&field.value!==(field.options[0]?.value??''):String(field.value||'').trim()!=='').length;
  count.textContent=set?`已設定 ${set} 項`:'';count.hidden=!set;
}
function aRenderStats(){
  const r=analysisState.result;if(!r)return;
  const usable=r.observations.filter(x=>x.eligible),weight=usable.reduce((v,x)=>v+x.weight,0);
  $('#aStats').innerHTML=[['納入分析',r.counts.eligible,`共 ${r.counts.selected} 筆 · ${new Set(usable.map(x=>x.sup)).size} 家供應商`],['待核對／排除',r.review.needs_review,`筆需核對／補充 · 另 ${r.review.duplicate} 筆重複已合併${r.review.customer_supplied?' · '+r.review.customer_supplied+' 筆客供料':''}`],['對應總重量',aNumber(weight),'公斤 · 實重與理論分開'],['現有資料',r.global_counts.records,`筆已確認材料 · ${r.global_counts.quotes} 筆報價`]].map(([label,value,hint],i)=>`<${i===1?'button type="button" data-a-problems="true"':'div'} class="analysis-stat"><small>${label}</small><strong>${value}</strong><small>${hint}</small></${i===1?'button':'div'}>`).join('');
  $('#aBasisHint').textContent=(r.price_basis==='gross'?'含稅成交公斤價＝經整單勾稽的逐筆含稅成交金額 ÷ 整筆公斤數；包含已列加工費，不重複加計。另加稅按比例分攤原單稅額，已含稅不再加稅；客供料無購料價格。':r.price_basis==='original'?'原單單價換算＝單價 × 計價數量 ÷ 整筆公斤數；每筆原單各自換算，不平均、不連線、不另加加工費。稅別未確認的價格不是未稅材料成本。':'未稅材料公斤單價＝每筆已核對的未稅材料費 ÷ 該筆重量；每筆獨立顯示，加工費及稅金分開核對。')+' 不同尺寸、數量與供料狀態會影響每筆價格；理論重量為估算，以空心點標示，實重為實心點。'+(r.metal==='steel'&&!r.market_series?'尚無適用鋼價，圖表先呈現 S50C 採購資料。':'國際行情是上游參考價，其稅別與加工口徑不同於供應商含稅、含加工費成交價，不能直接視為 S50C 成品成本或預測調價時間。');
  if(r.price_basis==='gross'){const pending=r.observations.filter(row=>row.transaction_type!=='customer_supplied'&&row.tax_basis==='unknown').length;if(pending)$('#aBasisHint').textContent+=` 目前 ${pending} 筆稅別待確認，可使用上方「稅別更新預覽」；既有金額不會被批次修改。`;}
}
function aPeriods(start,end,frequency){
  const result=[];let cursor=new Date((frequency==='monthly'?start+'-01':start)+'T12:00:00');
  const last=new Date((frequency==='monthly'?end+'-01':end)+'T12:00:00');
  while(cursor<=last&&result.length<40000){const day=[cursor.getFullYear(),String(cursor.getMonth()+1).padStart(2,'0'),String(cursor.getDate()).padStart(2,'0')].join('-');result.push(frequency==='monthly'?day.slice(0,7):day);if(frequency==='monthly')cursor.setMonth(cursor.getMonth()+1);else cursor.setDate(cursor.getDate()+(frequency==='weekly'?7:1));}
  return result;
}
function aSegments(points,periods){
  const indices=new Map(periods.map((p,i)=>[p,i]));const segments=[];
  for(const point of points){const previous=segments.at(-1);if(previous&&indices.get(point.period)===indices.get(previous.at(-1).period)+1)previous.push(point);else segments.push([point]);}
  return segments;
}
const A_DAY=86400000;
function aDay(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))return NaN;
  const day=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(day)&&new Date(day).toISOString().slice(0,10)===value?day:NaN;
}
function aPeriodRange(period,frequency){
  const start=aDay(frequency==='monthly'?period+'-01':period);
  if(!Number.isFinite(start))return null;
  const next=new Date(start);
  if(frequency==='monthly')next.setUTCMonth(next.getUTCMonth()+1);
  else next.setUTCDate(next.getUTCDate()+(frequency==='weekly'?7:1));
  const end=next.getTime();return {start,end,mid:(start+end)/2};
}
function aTimeTicks(start,end){
  const days=(end-start)/A_DAY,count=Math.min(7,Math.floor(days)+1),seen=new Set(),ticks=[];
  for(let i=0;i<count;i++){
    const day=Math.min(end,start+Math.round(i*days/Math.max(1,count-1))*A_DAY);
    const label=new Date(day).toISOString().slice(0,days>=90?7:10);
    if(!seen.has(label)){ticks.push({day,label});seen.add(label);}
  }
  return ticks;
}
function aSupplierColor(sup){
  const keys=Object.keys(SUP).filter(k=>k!=='xx').sort(),i=keys.indexOf(sup);
  return ANALYSIS_COLORS[(i<0?[...String(sup)].reduce((n,c)=>n+c.charCodeAt(0),0):i)%ANALYSIS_COLORS.length];
}
function aSupplierGroups(rows){
  const groups=new Map();
  for(const row of rows.slice().sort((a,b)=>a.date.localeCompare(b.date)||String(a.id).localeCompare(String(b.id)))){
    const key=row.date+'|'+Number(row.unit_kg);
    if(!groups.has(key))groups.set(key,{date:row.date,value:Number(row.unit_kg),rows:[]});
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}
function aPeriodName(frequency){return frequency==='monthly'?'月均價':frequency==='weekly'?'週均價':'當日觀測均價';}
function aRenderChart(){
  const r=analysisState.result;if(!r)return;analysisState.points=[];
  const scatter=analysisState.view==='scatter';
  $('#aPoint').textContent='點選圖上的資料點查看來源。';$('#aLegend').innerHTML='';
  const rows=r.observations.filter(row=>row.eligible&&aValidPrice(row.unit_kg)&&Number.isFinite(aDay(row.date)));
  const markets=scatter?[]:r.series.filter(s=>s.kind==='market').map(s=>({...s,points:s.points.filter(p=>aValidPrice(p.value)&&aPeriodRange(p.period,r.frequency)).slice().sort((a,b)=>a.period.localeCompare(b.period))})).filter(s=>s.points.length);
  const hasMarket=markets.length>0,hasSupplier=rows.length>0,dual=!scatter&&hasMarket&&hasSupplier,marketOnly=!scatter&&hasMarket&&!hasSupplier;
  const axisNote=$('#aAxisNote');axisNote.hidden=!(dual||marketOnly);
  axisNote.textContent=dual?'左軸：供應商逐筆價格；右軸：國際參考價。兩側尺度不同，請依各自刻度讀值；右軸自動縮放，未必從零開始。':marketOnly?'國際參考價縱軸自動縮放，未必從零開始。':'';
  const note=r.fx_gaps.length?` · ${r.fx_gaps.length} 個期間缺匯率，國際行情留空`:'';
  const marketSource=r.sources?.find(s=>s.series===r.market_series);
  const frequencyNote=marketSource?.frequency==='monthly'&&r.frequency!=='monthly'?' · 所選國際行情只有月資料，請切回每月或匯入日行情':'';
  $('#aChartCaption').textContent=scatter?`${aBasis(r.price_basis)} · 橫軸整批公斤數、縱軸元／公斤、圓點面積代表單件重量；顏色區分供應商、稅別及重量來源，空心為理論重量。`:`${analysisState.view==='fixed'?'固定規格 · ':''}${$('#aFilters [name=kind]').value==='quote'?'逐筆報價（報價日期）':'逐筆成交（出貨日期）'} · ${aBasis(r.price_basis)} · NT$／公斤 · 每筆明細一個點，不平均、不連線；空心為理論重量、實心為實重，半實心為重疊的兩種重量來源。`;
  if(!scatter)$('#aChartCaption').textContent+=` 國際行情：${aPeriodName(r.frequency)}，置於期間中央；同日同價的重疊點標示筆數。${note}`+(marketSource?.observation_frequency==='semi-monthly'?' · 鋼價為已公布觀測換算均價，缺匯率不計入；一般鋼材參考，非 S50C 報價':'')+frequencyNote+(!hasSupplier?' · 尚無可用的供應商觀察，請核對下方資料':'');
  if(analysisState.view==='fixed'&&!analysisState.fixed){$('#aChart').innerHTML='<div class="empty">請填寫並套用一組固定規格，開始比較。不同尺寸、供料／熱處理狀態與採購數量不會混入；未列狀態不推定相同。</div>';return;}
  const width=960,height=380,left=80,right=dual?90:28,top=scatter?24:40,bottom=64,w=width-left-right,h=height-top-bottom;
  let circles='',paths='',axis='',legend=[];
  const pointMarkup=(x,y,p,color,source,size=5)=>{
    const id=analysisState.points.length;analysisState.points.push(p);
    const title=p.text,mixed=source==='mixed',count=p.rows?.length||1;
    const gradient=mixed?`<defs><linearGradient id="aWeight-${id}"><stop offset="50%" stop-color="${color}"/><stop offset="50%" stop-color="var(--sheet)"/></linearGradient></defs>`:'';
    return gradient+`<circle cx="${x}" cy="${y}" r="${size}" fill="${mixed?'url(#aWeight-'+id+')':source==='theoretical'?'var(--sheet)':color}" style="stroke:${color}" data-a-point="${id}" role="button" tabindex="0" aria-label="${esc(title)}" data-point-title="${esc(title)}"><title>${esc(title)}</title></circle>`+(count>1?`<text class="a-overlap-count" x="${x+9}" y="${y-8}" aria-hidden="true">${count}</text>`:'');
  };
  const svgStart=`<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${scatter?'採購重量與材料單價散點圖':dual?'供應商逐筆價格與國際行情雙縱軸圖':'供應商逐筆價格與國際行情圖'}">`;
  if(scatter){
    const group=x=>[x.sup,x.grade,x.weight_source,x.price_basis,x.tax_status].join('|'),suppliers=[...new Set(rows.map(group))];
    if(!rows.length){$('#aChart').innerHTML='<div class="empty">目前沒有符合且可換算重量與材料費的資料，請查看下方排除原因。</div>';return;}
    const ax=aNiceAxis(Math.max(...rows.map(x=>x.weight))*1.05),ay=aNiceAxis(Math.max(...rows.map(x=>x.unit_kg))*1.08),maxX=ax.max,maxY=ay.max,maxPiece=Math.max(...rows.map(x=>x.piece_weight||0),.001);
    for(const value of ay.ticks){const y=top+h-value/maxY*h;axis+=`<path class="a-grid" d="M${left},${y}h${w}"/><text x="${left-10}" y="${y+4}" text-anchor="end">${aNumber(value)}</text>`;}
    for(const value of ax.ticks)axis+=`<text x="${left+value/maxX*w}" y="${top+h+24}" text-anchor="middle">${aNumber(value)}</text>`;
    for(const row of rows){const color=ANALYSIS_COLORS[suppliers.indexOf(group(row))%ANALYSIS_COLORS.length];const size=row.piece_weight?Math.max(4,Math.sqrt(row.piece_weight/maxPiece)*17):4;circles+=pointMarkup(left+row.weight/maxX*w,top+h-row.unit_kg/maxY*h,{row,text:`${row.date} · ${aName(row)} · 1 筆 · ${aNumber(row.weight)} kg · NT$ ${aNumber(row.unit_kg)}/kg${row.piece_weight?'':' · 單件重量未列，固定點大小'}`},color,row.weight_source,size);}
    legend=suppliers.map((key,i)=>[ANALYSIS_COLORS[i%ANALYSIS_COLORS.length],aName(rows.find(x=>group(x)===key)),'dot']);
    axis+=`<text x="${left+w/2}" y="${height-10}" text-anchor="middle">整批重量（公斤）</text><text x="${left}" y="14">NT$／公斤</text>`;
  }else{
    if(!rows.length&&!markets.length){$('#aChart').innerHTML='<div class="empty">目前尚無可繪製的觀察資料。現有單據已列於下方；請核對金額、稅別與重量，或更新國際行情。</div>';return;}
    const ranges=markets.flatMap(s=>s.points.map(p=>aPeriodRange(p.period,r.frequency)));
    const dates=rows.map(row=>aDay(row.date));
    let start=Math.min(...dates,...ranges.map(p=>p.start)),end=Math.max(...dates,...ranges.map(p=>p.end-1));
    if(start===end){start-=A_DAY/2;end+=A_DAY/2;}
    const x=day=>left+(day-start)/(end-start)*w;
    const leftAxis=marketOnly?aMarketAxis(markets.flatMap(s=>s.points.map(p=>p.value))):{min:0,...aNiceAxis(Math.max(...rows.map(row=>Number(row.unit_kg)))*1.08)};
    const rightAxis=dual?aMarketAxis(markets.flatMap(s=>s.points.map(p=>p.value))):null;
    const pointY=(value,scale)=>top+h-(value-scale.min)/(scale.max-scale.min)*h;
    for(const value of leftAxis.ticks){const y=pointY(value,leftAxis);axis+=`<path class="a-grid" d="M${left},${y}h${w}"/><text data-axis="left" x="${left-10}" y="${y+4}" text-anchor="end">${aAxisNumber(value,leftAxis.step)}</text>`;}
    axis+=`<path class="a-axis" d="M${left},${top}v${h}"/>`;
    if(rightAxis){
      axis+=`<path class="a-axis a-market-axis" d="M${left+w},${top}v${h}"/>`;
      for(const value of rightAxis.ticks)axis+=`<text data-axis="right" class="a-market-tick" x="${left+w+10}" y="${pointY(value,rightAxis)+4}">${aAxisNumber(value,rightAxis.step)}</text>`;
    }
    for(const tick of aTimeTicks(start,end))axis+=`<text x="${x(tick.day)}" y="${top+h+28}" text-anchor="middle">${esc(tick.label)}</text>`;
    // Only the international reference is a line. Supplier records never use aggregate series.
    markets.forEach(s=>{
      const color='var(--ink)',side=dual?'右軸':'左軸',scale=rightAxis||leftAxis;
      legend.push([color,aName(s)+' · '+aPeriodName(r.frequency)+' · '+side,'line']);
      const periods=aPeriods(s.points[0].period,s.points.at(-1).period,r.frequency);
      const px=p=>x(aPeriodRange(p.period,r.frequency).mid),py=p=>pointY(p.value,scale);
      for(const segment of aSegments(s.points,periods)){if(segment.length>1)paths+=`<path class="a-line" stroke="${color}" d="${segment.map((p,j)=>(j?'L':'M')+px(p)+','+py(p)).join(' ')}"/>`;}
      for(const p of s.points)circles+=pointMarkup(px(p),py(p),{series:s,point:p,axis:side,text:`${aName(s)} · ${side} · ${p.period} ${aPeriodName(r.frequency)} · NT$ ${aNumber(p.value)}/kg · ${p.count} 筆觀測`},color,'actual');
    });
    const groups=aSupplierGroups(rows),suppliers=[...new Set(rows.map(row=>row.sup))].sort();
    for(const sup of suppliers)legend.unshift([aSupplierColor(sup),(SUP[sup]?.short||sup)+' · 逐筆'+($('#aFilters [name=kind]').value==='quote'?'報價':'成交')+' · 左軸','dot']);
    for(const g of groups){
      const sups=[...new Set(g.rows.map(row=>row.sup))],sources=[...new Set(g.rows.map(row=>row.weight_source))],source=sources.length>1?'mixed':sources[0];
      const color=sups.length===1?aSupplierColor(sups[0]):'var(--ink-2)';
      const text=g.rows.length===1?`${g.date} · ${aName(g.rows[0])} · 左軸 · NT$ ${aNumber(g.value)}/kg · 1 筆 · ${aNumber(g.rows[0].weight)} kg`:`${g.date} · 同日同價 ${g.rows.length} 筆（未合併計價） · 左軸 · NT$ ${aNumber(g.value)}/kg · ${sups.map(sup=>SUP[sup]?.short||sup).join('、')}`;
      circles+=pointMarkup(x(aDay(g.date)),pointY(g.value,leftAxis),{rows:g.rows,text,axis:'左軸'},color,source);
    }
    axis+=`<text class="a-axis-title" x="${left}" y="18">${marketOnly?'國際參考價 · NT$／公斤':'左軸 · 供應商 NT$／公斤'}</text>`;
    if(dual)axis+=`<text class="a-axis-title a-market-tick" x="${width-8}" y="18" text-anchor="end">右軸 · 國際參考價 NT$／公斤</text>`;
  }
  $('#aChart').innerHTML=svgStart+axis+paths+circles+'</svg>';
  $('#aLegend').innerHTML=legend.map(([color,label,kind])=>`<span><i class="${kind==='dot'?'a-dot-key':''}" style="background:${color}"></i>${esc(label)}</span>`).join('');
}
function aRowDetail(row){
  const fields=[['尺寸',aDims(row)],['數量',aNumber(row.qty)+' '+(row.unit||'')],['原單單價','NT$ '+aNumber(row.price)+'／'+billingUnit(row)],['換算公斤單價','NT$ '+aNumber(row.original_unit_kg)+'／公斤'],['整筆重量',aNumber(row.weight)+' 公斤 · '+(row.weight_source==='actual'?'實重':'理論重量（估算）')],['單件重量',aNumber(row.piece_weight)+' 公斤'],['加工費','NT$ '+aNumber(row.processing_fee)],['原單明細金額','NT$ '+aNumber(row.amount)],['單價稅別',taxBasisName(row.tax_basis)],['分攤營業稅','NT$ '+aNumber(row.allocated_tax)+(row.tax_estimated?'（試算）':'')],['含稅成交金額（含加工費）','NT$ '+aNumber(row.gross_amount)],['含稅成交公斤價','NT$ '+aNumber(row.gross_unit_kg)+'／公斤']];
  if(row.price_basis==='material')fields.push(['未稅材料公斤單價','NT$ '+aNumber(row.unit_kg)+'／公斤']);
  return `<article class="a-source-detail"><h3>${esc(row.date)} · ${esc(row.doc||'未填單號')}</h3><p>${esc(SUP[row.sup]?.short||row.sup)} · ${esc(row.grade||'材質未列')} · ${esc(row.price_basis==='gross'?'圖點：含稅成交公斤價（含加工費）':row.price_basis==='material'?'圖點：未稅材料公斤單價':'圖點：原單單價換算公斤價')}</p><dl>${fields.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><p class="k">換算公斤單價：原單單價 × 計價數量 ÷ 整筆公斤數，不另加加工費 · ${esc(aTax(row.tax_status))}</p>${aOriginButtons(row)}${typeof aCompareButton==='function'?aCompareButton(row):''}</article>`;
}
function aShowPoint(index){
  const p=analysisState.points[index];if(!p)return;
  let html=p.row||p.rows?.length===1?'':`<b>${esc(p.text)}</b>`;
  if(p.row||p.rows){html+=(p.rows||[p.row]).map(aRowDetail).join('');}
  else if(p.series.kind==='market'){
    const change=aMarketChange(p.series,p.point);
    html+=`<div>來源：${esc(p.series.source)} · ${esc(p.series.region||'地區未列')} · ${esc(p.series.contract||'')} · 已公布觀測換算${aPeriodName(analysisState.result?.frequency)} NT$ ${aNumber(p.point.value)}／公斤 · ${aNumber(p.point.count)} 筆觀測</div><div>觀察截至 ${esc(p.point.last_observation||p.point.period||'未列')}${p.point.first_observation&&p.point.first_observation!==p.point.last_observation?' · 觀測期間 '+esc(p.point.first_observation)+' ～ '+esc(p.point.last_observation):''}</div>`;
    html+=change?`<div class="a-price-change">較前次有效資料（${esc(change.previous)} → ${esc(p.point.period)}）：價差 NT$ ${aSignedChange(change.delta)}／公斤 · ${change.percent==null?'前值為 0，無法計算百分比':aSignedChange(change.percent,2)+'%'}</div>`:'<div class="k">目前範圍內沒有前次有效資料可比較。</div>';
    html+=`<div>此為${p.series.metal==='steel'?'鋼材':'原鋁'}參考行情，並非該牌號成品報價。</div>`;
    if(p.series.url?.startsWith('https://'))html+=`<a href="${esc(p.series.url)}" target="_blank" rel="noopener">查看公開來源</a>`;
  }
  $('#aPoint').innerHTML=html;
}
function aOriginButtons(row){return row.kind==='quote'?`<button type="button" class="btn btn-sm" data-a-quote="${esc(row.id)}">查看報價</button>`:`<button type="button" class="btn btn-sm" data-a-origin="${esc(row.id)}">查看原單明細</button><button type="button" class="btn btn-sm" data-a-review="${esc(row.id)}">核對原單</button>`;}
function aVisibleRows(){
  return (analysisState.result?.observations||[]).filter(r=>(analysisState.listStatus==='all'||r.review_status===analysisState.listStatus)&&(!analysisState.category||r.primary_issue?.code===analysisState.category));
}
function aRenderRows(){
  const result=analysisState.result,counts=result.review,rows=aVisibleRows();
  const focused=typeof document!=='undefined'?document.activeElement:null,focusKey=focused?.dataset?.aStatus!=null?['aStatus',focused.dataset.aStatus]:focused?.dataset?.aCategory!=null?['aCategory',focused.dataset.aCategory]:null;
  $('#aListFilters').innerHTML=[['all','全部'],['needs_review','需核對／補充'],['included','已納入'],['duplicate','重複已合併']].map(([key,label])=>`<button class="btn btn-sm" type="button" data-a-status="${key}" aria-pressed="${analysisState.listStatus===key}">${label} ${counts[key]}</button>`).join('');
  $('#aCategories').hidden=analysisState.listStatus!=='needs_review';
  const categories=[...counts.categories];
  if(analysisState.category&&!categories.some(c=>c.code===analysisState.category))categories.push({code:analysisState.category,label:analysisState.categoryName||'原問題分類',count:0});
  $('#aCategories').innerHTML=[{code:'',label:'全部問題',count:counts.needs_review},...categories].map(c=>`<button class="btn btn-sm" type="button" data-a-category="${esc(c.code)}" aria-pressed="${analysisState.category===c.code}">${esc(c.label)} ${c.count}</button>`).join('');
  $('#aCostHeader').textContent=result.price_basis==='gross'?'含稅成交金額／公斤價（含加工費）':result.price_basis==='original'?'原單單價換算／公斤價':'未稅材料費／公斤價';
  $('#aQualityHint').textContent=`目前顯示 ${rows.length}／${counts.all} 筆。每筆只計入一項後端主因，詳細問題完整保留。重複已合併獨立列示，無需修正。`;
  const viewport=$('#aTableScroll'),scroll={top:viewport.scrollTop,left:viewport.scrollLeft};
  $('#aRows').innerHTML=rows.map(r=>`<tr data-a-row="${esc(r.id)}"><td>${esc(r.date)}<small>${esc(r.doc||'未填單號')}</small><small>明細 ${Number(r.position??0)+1} · 第 ${Number(r.page||1)} 頁</small></td><td>${esc(SUP[r.sup]?.short||r.sup)}<small>${esc(r.grade||'材質未列')}${r.temper?' / '+esc(r.temper):''}</small></td><td>${esc(aDims(r))}<small>${aNumber(r.qty)} ${esc(r.unit)}</small></td><td>${aNumber(r.weight)} kg<small>${r.weight_source==='actual'?'實重':'理論重量（估算）'}</small><small>單件 ${aNumber(r.piece_weight)} kg</small></td><td>NT$ ${aNumber(r.analysis_cost)}<small>${r.unit_kg==null?'公斤單價未列':'NT$ '+aNumber(r.unit_kg)+' /kg'}</small><small>${aBasis(r.price_basis)} · ${r.price_basis==='gross'?'原單稅別：'+taxBasisName(r.tax_basis)+(r.gross_amount==null?' · 尚無可用含稅成交金額':' · 成交含稅'):r.price_basis==='original'?aTax(r.tax_status):'未稅'}</small></td><td class="${r.review_status==='duplicate'?'analysis-duplicate':r.eligible?'analysis-ok':'analysis-warn'}">${esc(r.review_status==='customer_supplied'?'客供料，無購料價格':r.review_status==='duplicate'?'重複已合併':r.eligible?'已納入':r.primary_issue?.label||r.reason)}${r.review_status==='needs_review'?`${r.issues?.some(i=>i.message===r.reason)?'':`<p>${esc(r.reason)}</p>`}${r.issues?.length?`<ul class="analysis-issues">${r.issues.map(i=>`<li>${esc(i.message)}</li>`).join('')}</ul>`:''}`:''}</td><td>${aOriginButtons(r)}${typeof aCompareButton==='function'?aCompareButton(r):''}${r.kind==='invoice'&&r.review_status!=='duplicate'?`<button class="btn btn-sm" type="button" data-a-note="${esc(r.id)}">分析補充</button>`:''}${r.source_ids.length>1?`<small>已合併 ${r.source_ids.length} 份原單</small>`:''}</td></tr>`).join('')||'<tr><td colspan="7">目前篩選沒有符合的材料紀錄。</td></tr>';
  viewport.scrollTop=scroll.top;viewport.scrollLeft=scroll.left;
  if(focusKey)$$('#aListFilters button,#aCategories button').find(b=>b.dataset[focusKey[0]]===focusKey[1])?.focus({preventScroll:true});
}
function aRenderSources(){
  const r=analysisState.result;
  $('#aSources').innerHTML=r.sources.map(s=>`<div class="analysis-source"><b>${esc(s.label)}</b> · ${esc(s.source)} · ${esc(s.contract)} · ${esc(s.region||'地區未列')}<br>${esc(s.first)} ～ ${esc(s.last)} · ${s.observation_frequency==='semi-monthly'?'每月約兩次觀測（不補每日）':s.frequency==='monthly'?'月資料':'日資料'} · ${esc(s.currency)}／${s.unit==='tonne'?'公噸':'公斤'}<br><span class="k">快取更新 ${esc(s.updated?new Date(s.updated).toLocaleString('zh-TW'):'未列')}</span>${['wb-aluminium','sb-china-hrb','sb-china-plate'].includes(s.series)?'<div>分類：'+(s.metal==='steel'?'鋼（一般鋼材參考）':'鋁')+'</div>':`<form class="analysis-source-class" data-market="${esc(s.series)}"><label>金屬分類<select class="inp" name="metal"><option value="">未分類（不可用於比較）</option><option value="aluminum" ${s.metal==='aluminum'?'selected':''}>鋁</option><option value="steel" ${s.metal==='steel'?'selected':''}>鋼</option></select></label><button class="btn btn-sm" type="submit">保存分類</button></form>`}</div>`).join('')+(r.sources.length?'':'<p>尚無國際行情快取，請按更新行情，或匯入 CSV。</p>')+r.fx_sources.map(s=>`<div class="analysis-source">匯率 ${esc(s.source)} · ${s.observation_frequency==='semi-monthly'?'實際觀測日':s.frequency==='monthly'?'月':'日'} · ${esc(s.first)} ～ ${esc(s.last)} · NTD/USD</div>`).join('');
}
function aOpenNote(id,context=null){
  const r=analysisState.result.observations.find(r=>r.id===id)||analysisState.result.review_lookup?.[id];if(!r||r.kind!=='invoice')return;
  const n=r.supplement||{};
  openDrawer(`<div class="dr-head"><div><h2>分析補充</h2><p>${esc(r.doc||'未填單號')} · ${esc(r.grade||'材質未列')} · ${esc(aDims(r))}</p></div>${X_BTN}</div><form class="analysis-note-form" id="aNoteForm" data-record="${esc(id)}"><p>只影響分析，不改寫原單金額。原單更新後，補充資料需重新確認。</p><label>供料／熱處理狀態（未列留白）<input name="temper" class="inp" value="${esc(n.temper||'')}"></label><label>原單金額稅別<select name="tax_basis" class="inp">${[['unknown','未確認（有明確整單稅額時可自動辨別）'],['pretax','已確認未稅'],['included','已確認含稅']].map(([v,l])=>`<option value="${v}" ${n.tax_basis===v?'selected':''}>${l}</option>`).join('')}</select></label><label>含稅稅率 %<input class="inp" name="tax_rate" type="number" min="0" max="100" step="any" value="${esc(n.tax_rate??'')}"></label><label>經核對的未稅純材料費（選填）<input class="inp" name="material_cost" type="number" min="0" step="any" value="${esc(n.material_cost??'')}"></label><p class="k">只包含材料，扣除加工、運費與稅。填寫此欄代表已核對此金額；優先於原單試算。</p><label>經核對的整筆實重（公斤，選填）<input class="inp" name="weight_kg" type="number" min="0.001" step="any" value="${esc(n.weight_kg??'')}"></label><label class="analysis-check"><input type="checkbox" name="fee_zero" ${n.fee_zero?'checked':''}>已確認未列加工費代表沒有加工費</label><label>核對註記<input class="inp" name="note" value="${esc(n.note||'')}"></label><p id="aNoteError" role="alert"></p><button class="btn btn-primary" type="submit">${context?'確認並下一筆問題':'保存分析補充'}</button>${context?'<button class="btn" type="button" data-note-return>返回分析</button>':''}</form>${(r.source_ids||[]).map(id=>{const doc=queue.find(d=>d.id===id);return doc?`<div class="analysis-source"><a href="${esc(doc.original_url)}" target="_blank" rel="noopener">原單：${esc(doc.name)}</a></div>`:'';}).join('')}`);
  aBindNote(r,context);
}
async function aLoadQuotes(){
  const data=await api('/api/quotes');analysisState.quotes=data.quotes;
  $('#aQuoteList').innerHTML=data.quotes.map(q=>`<article class="analysis-quote"><div><b>${esc(SUP[q.sup]?.short||q.sup)} · ${esc(q.grade||'材質未列')} · ${esc(q.date)}</b><p>${esc(aDims(q))} · ${aNumber(q.qty)} ${esc(q.unit)} · 單價 NT$ ${aNumber(q.price)}/${q.pricing_basis==='weight'?'公斤':esc(q.unit)}</p><p>${esc(q.doc||'未填單號')} · ${q.valid_until?'有效至 '+esc(q.valid_until):'有效期限未列'}${q.void?' · 已作廢':''}</p></div><button class="btn" type="button" data-a-quote="${esc(q.id)}">查看紀錄</button></article>`).join('')||'<p>尚無報價紀錄，可手動新增或匯入 CSV。</p>';
}
async function aOpenQuote(id){
  let q=analysisState.quotes.find(q=>q.id===id);
  if(!q){await aLoadQuotes();q=analysisState.quotes.find(q=>q.id===id);}if(!q)return;
  const entries=[['供應商',SUP[q.sup]?.name],['報價日期',q.date],['有效期限',q.valid_until||'未列'],['單號',q.doc||'未列'],['牌號／供料／熱處理狀態',[q.grade,q.temper].filter(Boolean).join(' / ')||'未列'],['尺寸',aDims(q)],['詢價數量',aNumber(q.qty)+' '+q.unit],['單價',aNumber(q.price)+' / '+(q.pricing_basis==='weight'?'公斤':q.unit)],['材料費',aNumber(q.material_amount)],['加工費',aNumber(q.processing_fee)],['明細金額',aNumber(q.amount)],['重量',aNumber(q.weight_kg)+' kg'],['稅別',({unknown:'未確認',pretax:'未稅',included:'含稅'})[q.tax_basis]],['備註',q.note||'未列']];
  openDrawer(`<div class="dr-head"><div><h2>報價紀錄</h2>${q.void?'已作廢':'每次觀察獨立保存'}</div>${X_BTN}</div><dl class="kv">${entries.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><div class="dr-sec"><h3>原始附件</h3>${q.attachments.map(f=>`<p><a href="${esc(f.url)}">${esc(f.name)}</a></p>`).join('')||'<p>沒有附件</p>'}${q.void?'':`<label>新增附件<input type="file" id="aQuoteAttach" accept=".pdf,.jpg,.jpeg,.png,.heic,.xlsx,.csv"></label>`}</div>${q.void?'':`<div class="dr-sec"><button class="btn" type="button" id="aVoidQuote">作廢此紀錄</button><p class="k">作廢後保留紀錄與附件，排除價格分析。</p><p id="aQuoteDetailError" role="alert"></p></div>`}`);
  $('#aQuoteAttach')?.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{await aAttachQuote(id,file);toast('附件已保存');await aLoadQuotes();await aOpenQuote(id);}catch(error){$('#aQuoteDetailError').textContent=error.message;}});
  $('#aVoidQuote')?.addEventListener('click',async e=>{e.target.disabled=true;try{await api('/api/quotes/'+id+'/void',{method:'POST',body:'{}'});closeDrawer();await aLoadQuotes();await loadAnalysis();toast('已作廢，保留歷史紀錄');}catch(error){$('#aQuoteDetailError').textContent=error.message;e.target.disabled=false;}});
}
async function aAttachQuote(id,file){if(file.size>50*1024*1024)throw Error('附件超過 50 MB');return api('/api/quotes/'+id+'/attachment?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});}
const ANALYSIS_IMPORT_HELP={quotes:'supplier 填供應商代碼或公司名稱；shape 為 rect／round；圓條 dim1=直徑、dim2=長度，dim3 留白。單位 mm、幣別 TWD；pricing_basis=quantity／weight；tax_basis=unknown／pretax／included。fee_zero=true 僅表示已確認沒有加工費。空白材質與價格可保存。',market:'metal 可選 steel（鋼）／aluminum（鋁），留白須匯入後明確分類；region 保留地區。鋼材請填實際鋼材行情，不使用鐵礦砂代理。series 使用自訂英數代碼；label 名稱、source 來源、contract 現貨／合約定義必填。frequency=daily／monthly；period=YYYY-MM-DD／YYYY-MM。currency=USD／TWD；unit=tonne（公噸）／kg。不同來源、合約、頻率或單位請使用不同代碼；wb-／sb- 為保留代碼。',fx:'source 使用自訂英數代碼（cbc 為保留代碼）；frequency=daily／monthly；period=YYYY-MM-DD／YYYY-MM；value 為 1 美元兌新臺幣金額。月資料與日資料分開保存。'};
function aImportReset(){analysisState.preview=null;$('#aImportPreview').textContent='';$('#aImportCommit').hidden=true;const kind=$('#aImport [name=kind]').value;$('#aTemplate').href='/api/analysis/template?kind='+kind;$('#aImportHelp').textContent=ANALYSIS_IMPORT_HELP[kind];$('#aReplaceLabel').hidden=kind==='quotes';}
function aImportTable(rows){
  const names={doc:'單號',grade:'牌號',temper:'供料／熱處理狀態',note:'備註',sup:'供應商',date:'日期',valid_until:'有效至',shape:'形狀',dims:'尺寸(mm)',qty:'數量',unit:'單位',pricing_basis:'計價依據',price:'單價',weight_kg:'實重(kg)',material_amount:'材料費',processing_fee:'加工費',amount:'明細金額',tax_basis:'稅別',tax_rate:'稅率(%)',fee_zero:'確認無加工費',material_cost:'分析未稅材料費',currency:'幣別',label:'名稱',series:'行情代碼',source:'來源',contract:'合約／現貨',frequency:'頻率',period:'期間',value:'值',url:'來源連結',metal:'金屬分類',region:'地區'};
  const columns=Object.keys(rows[0]||{}),display=(r,k)=>k==='dims'?aDims(r):r[k]==null||r[k]===''?'未列':r[k]===true?'是':r[k]===false?'否':String(r[k]);
  return `<div class="analysis-table-wrap"><table class="analysis-table"><thead><tr>${columns.map(k=>`<th>${esc(names[k]||k)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0,10).map(r=>`<tr>${columns.map(k=>`<td>${esc(display(r,k))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="k">預覽前 10 筆，可左右捲動核對所有欄位；確認後才寫入。</p>`;
}
function aInit(){
  const today=new Date(),end=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
  const start=new Date(today.getFullYear(),today.getMonth()-23,1),from=[start.getFullYear(),String(start.getMonth()+1).padStart(2,'0'),'01'].join('-');
  $('#aFilters [name=start]').value=from;$('#aFilters [name=end]').value=end;$('#aQuoteForm [name=date]').value=end;
  $('#aFilters').addEventListener('submit',e=>{e.preventDefault();loadAnalysis();});
  for(const event of ['input','change'])$('#aFilters').addEventListener(event,()=>{analysisState.filterRevision++;aSyncMoreFilters();});
  $('#aFilters').addEventListener('reset',()=>{analysisState.filterRevision++;setTimeout(()=>{analysisState.fixed=null;aFilterNotice();aSyncMoreFilters();loadAnalysis();},0);});
  $('#aFilters [name=metal]').addEventListener('change',e=>{
    const metal=e.target.value,grade=$('#aFilters [name=grade]'),market=$('#aFilters [name=market]'),r=analysisState.result;let cleared=[];
    if(grade.value&&r?.grade_metals[grade.value]!==metal){grade.value='';cleared.push('牌號');}
    if(market.value&&r?.sources.find(s=>s.series===market.value)?.metal!==metal){market.value='';cleared.push('國際行情');}
    if(analysisState.fixed&&r?.grade_metals[analysisState.fixed.grade]!==metal){analysisState.fixed=null;$('#aFixed [name=grade]').value='';cleared.push('固定規格');}
    aFilterNotice(cleared.length?'已清除不適用的'+cleared.join('、')+'，請選擇此金屬的分析條件。':'已切換金屬分類。');loadAnalysis();
  });
  $('#aReload').addEventListener('click',()=>loadAnalysis());
  $('.analysis-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-a-tab]');if(!b)return;analysisState.tab=b.dataset.aTab;$$('[data-a-tab]').forEach(x=>x.setAttribute('aria-pressed',x===b));for(const [tab,id]of [['compare','aCompare'],['quotes','aQuotes'],['settings','aSettings']])$('#'+id).hidden=tab!==analysisState.tab;if(analysisState.tab==='quotes')aLoadQuotes().catch(e=>aError(e.message));});
  $('#view-analysis').addEventListener('click',async e=>{
    const problems=e.target.closest('[data-a-problems]'),status=e.target.closest('[data-a-status]'),category=e.target.closest('[data-a-category]');
    if(problems||status||category){
      state.reviewGeneration++;
      if(category){analysisState.listStatus='needs_review';analysisState.category=category.dataset.aCategory;analysisState.categoryName=analysisState.result.review.categories.find(c=>c.code===analysisState.category)?.label||analysisState.categoryName;}
      else{analysisState.listStatus=problems?'needs_review':status.dataset.aStatus;analysisState.category='';}
      aRenderRows();$('#aTableScroll').scrollTop=0;
      if(problems){$('#aProblems').focus({preventScroll:true});$('#aProblems').scrollIntoView({block:'start'});}
      return;
    }
    const view=e.target.closest('[data-a-view]');if(view){analysisState.view=view.dataset.aView;$$('[data-a-view]').forEach(x=>x.setAttribute('aria-pressed',x===view));$('#aFixed').hidden=analysisState.view!=='fixed';loadAnalysis();return;}
    const p=e.target.closest('[data-a-point]');if(p){aShowPoint(+p.dataset.aPoint);return;}
    const b=e.target.closest('[data-a-origin],[data-a-note],[data-a-review],[data-a-quote]');if(!b)return;
    try{if(b.dataset.aOrigin)openDetail(b.dataset.aOrigin);if(b.dataset.aNote)aOpenNote(b.dataset.aNote,aCaptureContext(b.dataset.aNote));if(b.dataset.aReview)await aOpenReview(b.dataset.aReview);if(b.dataset.aQuote)await aOpenQuote(b.dataset.aQuote);}catch(error){aError(error.message);}
  });
  $('#aChart').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)&&e.target.hasAttribute('data-a-point')){e.preventDefault();aShowPoint(+e.target.dataset.aPoint);}});
  $('#aChart').addEventListener('focusin',e=>{if(e.target.hasAttribute('data-a-point'))aShowPoint(+e.target.dataset.aPoint);});
  $('#aFixed').addEventListener('submit',e=>{e.preventDefault();try{const v=aFormObject(e.currentTarget);v.dims=aParseDims(v.dims,v.shape);v.qty=Number(v.qty);if(!(v.qty>0)||!v.temper.trim()||!v.grade)throw Error('請填妥固定規格的所有欄位');analysisState.fixed=v;loadAnalysis();}catch(error){aError(error.message);}});
  $('#aQuoteForm').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.currentTarget,button=$('button[type=submit]',form),message=$('#aQuoteMessage');button.disabled=true;
    try{
      let pending=analysisState.pendingQuote;
      if(!pending){const values=aFormObject(form);values.dims=aParseDims(values.dims,values.shape);delete values.attachment;const file=form.elements.attachment.files[0];if(file&&(file.size>50*1024*1024||!/[.](pdf|jpg|jpeg|png|heic|xlsx|csv)$/i.test(file.name)))throw Error('附件需為 50 MB 內的 PDF、圖片、XLSX 或 CSV');analysisState.quoteRequestId ||= crypto.randomUUID().replaceAll('-','');values.client_id=analysisState.quoteRequestId;const quote=await api('/api/quotes',{method:'POST',body:JSON.stringify(values)});pending={id:quote.id,file};analysisState.pendingQuote=pending;}
      if(pending.file)await aAttachQuote(pending.id,pending.file);
      analysisState.pendingQuote=null;analysisState.quoteRequestId=null;form.reset();form.elements.date.value=end;message.textContent='已保存報價紀錄，可繼續新增下一次詢價。';button.textContent='保存報價紀錄';await aLoadQuotes();await loadAnalysis();
    }catch(error){message.textContent=(analysisState.pendingQuote?'報價已保存，附件尚未完成；再次點擊只重試附件，不會重複新增。':'')+error.message;if(analysisState.pendingQuote){button.textContent='重試保存附件';const skip=document.createElement('button');skip.type='button';skip.className='btn';skip.textContent='稍後補附件，繼續下一筆';skip.addEventListener('click',()=>{analysisState.pendingQuote=null;analysisState.quoteRequestId=null;form.reset();form.elements.date.value=end;message.textContent='報價已保存，附件可於紀錄中補上。';button.textContent='保存報價紀錄';aLoadQuotes().catch(e=>aError(e.message));});message.append(skip);}}finally{button.disabled=false;}
  });
  $('#aDensity').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=$('button',form);button.disabled=true;try{const grades=['S50C','6061','7075'];await api('/api/analysis/settings',{method:'POST',body:JSON.stringify({densities:Object.fromEntries(grades.map(g=>[g,form.elements.namedItem(g).value])),density_sources:Object.fromEntries(grades.map(g=>[g,form.elements.namedItem('source_'+g).value]))})});await loadAnalysis();toast('密度設定與來源已保存，已重新計算理論重量');}catch(error){aError(error.message);}finally{button.disabled=false;}});
  $('#aSources').addEventListener('submit',async e=>{const form=e.target.closest('[data-market]');if(!form)return;e.preventDefault();const button=$('button',form);button.disabled=true;try{await api('/api/analysis/market-sources/'+encodeURIComponent(form.dataset.market),{method:'POST',body:JSON.stringify({metal:form.elements.metal.value})});const market=$('#aFilters [name=market]');if(market.value===form.dataset.market&&form.elements.metal.value!==$('#aFilters [name=metal]').value){market.value='';aFilterNotice('行情分類已變更，已清除不適用的國際行情。');}await loadAnalysis();toast('行情分類已保存');}catch(error){aError(error.message);}finally{button.disabled=false;}});
  $('#aUpdateMarket').addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;$('#aMarketStatus').textContent='正在更新鋼價、鋁價與匯率；首次鋼價會補入歷史…';try{const r=await api('/api/market/update',{method:'POST',body:'{}'});$('#aMarketStatus').textContent=aMarketReport(r);await loadAnalysis();}catch(error){$('#aMarketStatus').textContent=error.message+'；既有行情快取仍可使用。';}finally{button.disabled=false;}});
  $('#aImport [name=kind]').addEventListener('change',aImportReset);$('#aImport [name=file]').addEventListener('change',aImportReset);
  $('#aImport').addEventListener('submit',async e=>{e.preventDefault();aImportReset();const form=e.currentTarget,button=$('button[type=submit]',form);button.disabled=true;try{const file=form.elements.file.files[0];if(!file||file.size>4*1024*1024)throw Error('請選擇 4 MB 內 UTF-8 CSV');const content=await file.text(),kind=form.elements.kind.value,result=await api('/api/analysis/preview',{method:'POST',body:JSON.stringify({kind,content})});analysisState.preview={content,kind};$('#aImportPreview').innerHTML=`<p>${result.rows.length} 筆有效列 · ${result.duplicates} 筆重複 · ${result.errors.length} 筆錯誤${kind==='quotes'?'（重複報價略過）':''}</p>`+result.errors.slice(0,30).map(x=>`<p class="analysis-warn">第 ${x.line} 列：${esc(x.error)}</p>`).join('')+aImportTable(result.rows);$('#aImportCommit').hidden=result.errors.length>0||!result.rows.length;}catch(error){$('#aImportPreview').textContent=error.message;}finally{button.disabled=false;}});
  $('#aImportCommit').addEventListener('click',async e=>{if(!analysisState.preview)return;const button=e.currentTarget;button.disabled=true;try{const r=await api('/api/analysis/import',{method:'POST',body:JSON.stringify({...analysisState.preview,replace:$('#aImport [name=replace]').checked})});aImportReset();$('#aImportPreview').textContent=`已匯入 ${r.count} 筆。`;$('#aImport [name=file]').value='';await loadAnalysis();toast('CSV 已匯入');}catch(error){$('#aImportPreview').textContent=error.message;}finally{button.disabled=false;}});
  aImportReset();
  if(typeof aCompareInit==='function')aCompareInit();
}
aInit();
