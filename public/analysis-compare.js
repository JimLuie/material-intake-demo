'use strict';

// Separate from the material table's picked set; analysis is read-only.
const aComparison={picked:new Map(),signature:null,dirty:false};
function aCompareKey(row){return JSON.stringify([row.kind,row.id]);}
function aCompareEligible(row){return !!row&&row.eligible===true&&['invoice','quote'].includes(row.kind)&&typeof row.id==='string'&&!!row.id;}
function aCompareRow(key){return analysisState.result?.observations.find(row=>aCompareKey(row)===key);}
function aCompareMessage(message){$('#aCompareMessage').textContent=message;}
function aCompareButton(row){
  if(!aCompareEligible(row))return '';
  const selected=aComparison.picked.has(aCompareKey(row));
  return `<button class="btn btn-sm" type="button" data-ac-add="${esc(aCompareKey(row))}" aria-pressed="${selected}"${aComparison.dirty?' disabled':''}>${selected?'移出比較':'加入比較'}</button>`;
}
function aCompareSignature(filters,result){
  const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
  return JSON.stringify(sort({...filters,market:filters.market||result.market_series||''}));
}
function aCompareIsOpen(){return !$('#drawer').hidden&&!!$('#aPriceComparison');}
function aCompareChanged(){
  aComparison.dirty=true;
  if(aComparison.picked.size){aComparison.picked.clear();aCompareMessage('分析條件或價格口徑已變更，已清除比較選擇；請更新分析後重新選取。');}
  aRenderComparison();
}
function aReconcileComparison(result,filters){
  const signature=aCompareSignature(filters,result);
  if(aComparison.signature!==null&&signature!==aComparison.signature&&aComparison.picked.size){
    aComparison.picked.clear();aCompareMessage('分析條件或價格口徑已變更，已清除比較選擇。');
  }
  const available=new Map(result.observations.filter(aCompareEligible).map(row=>[aCompareKey(row),row]));
  const removed=[];
  for(const [key,row]of aComparison.picked){
    if(available.has(key))aComparison.picked.set(key,available.get(key));
    else{removed.push(aCompareTitle(row));aComparison.picked.delete(key);}
  }
  if(removed.length)aCompareMessage('已移除 '+removed.length+' 筆已不存在或不再可分析的比較資料：'+removed.join('、')+'。');
  aComparison.signature=signature;aComparison.dirty=false;
  aRenderComparison();
}
function aCompareTitle(row){return (row.kind==='quote'?'報價':'成交')+' · '+(row.date||'未列')+' · '+(row.doc||'未列')+(row.kind==='invoice'?' · 明細 '+(Number(row.position??0)+1):'');}
function aToggleComparison(key){
  if(aComparison.dirty){aCompareMessage('分析條件已修改，請先更新分析再加入比較。');return;}
  const row=aCompareRow(key);
  if(!aCompareEligible(row)){aCompareMessage('此筆已不存在或目前不可分析，無法加入比較。');return;}
  if(aComparison.picked.has(key)){aComparison.picked.delete(key);aCompareMessage('已移出比較。');}
  else{
    if(aComparison.picked.size>=4){aCompareMessage('最多同時比較 4 筆，請先移除一筆再加入。');return;}
    aComparison.picked.set(key,row);aCompareMessage('已加入比較，已選 '+aComparison.picked.size+'／4 筆。');
  }
  aRenderComparison();
}
function aCompareFocus(){
  const node=document.activeElement;
  if(!node)return null;
  for(const attr of ['data-ac-remove','data-ac-source','data-ac-open','data-ac-clear','data-close'])if(node.hasAttribute(attr))return {node,attr,value:node.getAttribute(attr),action:node.dataset.acAction};
  return null;
}
function aCompareRestoreFocus(focus,root){
  if(!focus||focus.node.isConnected&&!focus.node.disabled)return;
  const replacement=[...root.querySelectorAll('['+focus.attr+']')].find(node=>!node.disabled&&node.getAttribute(focus.attr)===focus.value&&node.dataset.acAction===focus.action);
  (replacement||root.querySelector('[data-close]')||($('#aCompareOpen').disabled?$('#aCompareCount'):$('#aCompareOpen'))).focus({preventScroll:true});
}
function aRenderComparison(){
  const focus=aCompareFocus(),rows=[...aComparison.picked.values()];
  $('#aCompareCount').textContent='已選 '+rows.length+'／4 筆';
  $('#aCompareOpen').disabled=rows.length<2||aComparison.dirty;$('#aCompareClear').disabled=!rows.length;
  const chips=rows.map((row,index)=>`<li><span>#${index+1} ${esc(aCompareTitle(row))}</span><button class="linkbtn" type="button" data-ac-remove="${esc(aCompareKey(row))}" aria-label="移除第 ${index+1} 筆比較">移除</button></li>`).join('');
  if($('#aComparePicked').innerHTML!==chips)$('#aComparePicked').innerHTML=chips;
  for(const button of document.querySelectorAll('[data-ac-add]')){
    const selected=aComparison.picked.has(button.dataset.acAdd);
    button.textContent=selected?'移出比較':'加入比較';button.setAttribute('aria-pressed',String(selected));button.disabled=aComparison.dirty;
  }
  if(aCompareIsOpen())aRenderComparisonDialog();
  else aCompareRestoreFocus(focus,$('#view-analysis'));
}
function aCompareFields(rows){
  const text=value=>value==null||String(value).trim()===''?'未列':String(value);
  const weightSource=row=>row.weight_source==='actual'?'實重':row.weight_source==='theoretical'?'理論重量（估算）':'未列';
  const fields=[
    ['來源類型',r=>r.kind==='quote'?'報價／詢價':'成交單據',r=>r.kind],
    ['日期',r=>text(r.date),r=>r.date],['單號',r=>text(r.doc),r=>r.doc],
    ['供應商',r=>text(SUP[r.sup]?.name||SUP[r.sup]?.short||r.sup),r=>r.sup],
    ['牌號',r=>text(r.grade),r=>r.grade],['供料／熱處理狀態',r=>text(r.temper),r=>r.temper],
    ['形狀',r=>r.shape==='round'?'圓條':r.shape==='rect'?'長方體':'未列',r=>r.shape],
    ['尺寸（mm，原單順序）',r=>r.dims?.length?aDims(r):'未列',r=>r.dims?.length?r.dims:null],
    ['原單數量與單位',r=>aNumber(r.qty)+' '+text(r.unit),r=>[r.qty,r.unit]],
    ['原單單價與計價單位',r=>'NT$ '+aNumber(r.price)+'／'+billingUnit(r),r=>[r.price,r.pricing_basis,billingUnit(r)]],
    ['換算公斤單價',r=>'NT$ '+aNumber(r.original_unit_kg)+'／公斤',r=>r.original_unit_kg],
    ['整筆重量',r=>aNumber(r.weight)+' 公斤',r=>r.weight],['單件重量',r=>aNumber(r.piece_weight)+' 公斤',r=>r.piece_weight],
    ['重量來源',weightSource,r=>r.weight_source],['加工費',r=>'NT$ '+aNumber(r.processing_fee),r=>r.processing_fee],
    ['稅別',r=>!r.tax_status||r.tax_status==='unknown'?'未列（稅別未確認）':aTax(r.tax_status),r=>r.tax_status==='unknown'?null:r.tax_status]
  ];
  fields.push(['原單明細金額',r=>'NT$ '+aNumber(r.amount),r=>r.amount],['分攤營業稅',r=>'NT$ '+aNumber(r.allocated_tax)+(r.tax_estimated?'（試算）':''),r=>r.allocated_tax],['含稅成交金額（含加工費）',r=>'NT$ '+aNumber(r.gross_amount),r=>r.gross_amount],['含稅成交公斤價',r=>'NT$ '+aNumber(r.gross_unit_kg)+'／公斤',r=>r.gross_unit_kg]);
  if(rows.some(row=>row.price_basis==='material'))fields.splice(11,0,['未稅材料公斤單價',r=>'NT$ '+aNumber(r.unit_kg)+'／公斤',r=>r.unit_kg]);
  const missing=value=>value==null||typeof value==='string'&&(!value.trim()||value==='unknown')||Array.isArray(value)&&value.some(missing);
  return fields.map(([label,display,value])=>{
    const raw=rows.map(value),incomplete=raw.some(missing),different=new Set(raw.map(v=>JSON.stringify(v))).size>1;
    return {label,values:rows.map(display),different,incomplete};
  });
}
function aComparisonHTML(){
  const rows=[...aComparison.picked.values()],fields=aCompareFields(rows);
  const differences=fields.filter(field=>field.different).map(field=>field.label),unlisted=fields.filter(field=>field.incomplete).map(field=>field.label);
  const head=`<thead><tr><th scope="col">欄位</th>${rows.map((row,index)=>`<th scope="col"><b>#${index+1} ${esc(SUP[row.sup]?.short||row.sup||'未列')}</b><small>${esc(aCompareTitle(row))}</small><button class="linkbtn" type="button" data-ac-remove="${esc(aCompareKey(row))}" aria-label="移除第 ${index+1} 筆比較">移除</button></th>`).join('')}</tr></thead>`;
  const body=fields.map(field=>`<tr class="${field.different?'is-diff':''}"><th scope="row">${esc(field.label)}${field.incomplete?'<small>資料未列，無法確認相同</small>':''}</th>${field.values.map(value=>`<td class="mono">${esc(value)}</td>`).join('')}</tr>`).join('');
  const sources=`<tr><th scope="row">來源與核對</th>${rows.map(row=>`<td>${row.kind==='invoice'?`<small>明細 ${Number(row.position??0)+1} · 第 ${Number(row.page||1)} 頁</small>`:''}<button class="btn btn-sm" type="button" data-ac-source="${esc(aCompareKey(row))}" data-ac-action="origin">${row.kind==='quote'?'查看報價來源':'查看原單明細'}</button>${row.kind==='invoice'?`<button class="btn btn-sm" type="button" data-ac-source="${esc(aCompareKey(row))}" data-ac-action="review">核對原單</button>`:''}</td>`).join('')}</tr>`;
  return `<div id="aPriceComparison"><div class="dr-head"><div><div class="eyebrow">Compare · 逐筆價格</div><h2>並排比較 ${rows.length} 筆價格</h2></div>${X_BTN}</div>
    <p class="k" role="status">${esc($('#aCompareMessage').textContent)}</p>
    <div class="cmp-legend"><span><i></i>資料不同的欄位</span><span>橫向捲動可查看全部來源，左側保留欄位名稱。</span><button class="btn btn-sm" type="button" data-ac-scroll="-1" aria-label="向左捲動比較表">← 向左</button><button class="btn btn-sm" type="button" data-ac-scroll="1" aria-label="向右捲動比較表">向右 →</button></div>
    <p class="k">${differences.length?'不同條件／資料：'+esc(differences.join('、'))+'。':'已列資料目前未見差異。'}${unlisted.length?' 未列而無法確認相同：'+esc(unlisted.join('、'))+'。':''}</p>
    <p class="notice">相近條件不等於完全相同規格；請一併核對尺寸、數量、供料狀態、稅別及重量來源。不計平均、不調整原單價格，最低公斤價不代表最佳採購選擇。</p>
    ${rows.length<2?'<p role="status">目前可比較資料少於 2 筆，請關閉後重新選取。</p>':''}
    ${rows.length?`<div class="cmp-wrap a-price-compare-wrap" tabindex="0" role="region" aria-label="逐筆價格比較表，可左右捲動"><table class="cmp a-price-compare" aria-label="逐筆價格與採購條件比較" style="min-width:${170+rows.length*180}px">${head}<tbody>${body}${sources}</tbody></table></div>`:''}
    <p class="k">換算公斤單價＝原單單價 × 計價數量 ÷ 整筆公斤數，不另加加工費。未稅材料公斤單價依既有分析結果另列；實重與理論估算分別標示。</p></div>`;
}
function aOpenComparison(){
  if(aComparison.picked.size<2||aComparison.dirty)return;
  openDrawer(aComparisonHTML(),true);$('#drawerPanel').setAttribute('aria-label','逐筆價格並排比較');
}
function aRenderComparisonDialog(){
  const focus=aCompareFocus(),panel=$('#drawerPanel'),region=$('.a-price-compare-wrap');
  const scroll={top:panel.scrollTop,left:region?.scrollLeft||0},regionFocused=document.activeElement===region;
  panel.innerHTML=aComparisonHTML();panel.scrollTop=scroll.top;
  const next=$('.a-price-compare-wrap');if(next){next.scrollLeft=scroll.left;if(regionFocused)next.focus({preventScroll:true});}
  aCompareRestoreFocus(focus,panel);
}
function aCompareInit(){
  for(const form of [$('#aFilters'),$('#aFixed')])for(const event of ['input','change','reset'])form.addEventListener(event,aCompareChanged);
  const handle=async event=>{
    const button=event.target.closest('[data-ac-add],[data-ac-remove],[data-ac-clear],[data-ac-open],[data-ac-source],[data-ac-scroll]');if(!button)return;
    if(button.hasAttribute('data-ac-add'))aToggleComparison(button.dataset.acAdd);
    else if(button.hasAttribute('data-ac-remove')){aComparison.picked.delete(button.dataset.acRemove);aCompareMessage('已移出比較。');aRenderComparison();}
    else if(button.hasAttribute('data-ac-clear')){aComparison.picked.clear();aCompareMessage('已清空比較選擇。');aRenderComparison();}
    else if(button.hasAttribute('data-ac-open'))aOpenComparison();
    else if(button.hasAttribute('data-ac-scroll')){const region=$('.a-price-compare-wrap');if(region)region.scrollLeft+=Number(button.dataset.acScroll)*Math.max(180,region.clientWidth-170);}
    else{
      const row=aCompareRow(button.dataset.acSource);
      if(!aCompareEligible(row)){aCompareMessage('此筆已不存在或不再可分析，請重新載入分析。');aRenderComparison();return;}
      try{if(row.kind==='quote')await aOpenQuote(row.id);else if(button.dataset.acAction==='review')await aOpenReview(row.id);else openDetail(row.id);}
      catch(error){aCompareMessage(error.message);aRenderComparison();}
    }
  };
  $('#view-analysis').addEventListener('click',handle);$('#drawer').addEventListener('click',handle);
  document.addEventListener('keydown',event=>{
    if(event.key!=='Tab'||!aCompareIsOpen())return;
    const panel=$('#drawerPanel'),focusable=[...panel.querySelectorAll('button:not(:disabled),a[href],[tabindex="0"]')];
    if(!focusable.length)return;
    // Safari may otherwise skip buttons when full keyboard access is disabled.
    event.preventDefault();const index=focusable.indexOf(document.activeElement);
    const next=index<0?(event.shiftKey?focusable.length-1:0):(index+(event.shiftKey?-1:1)+focusable.length)%focusable.length;
    focusable[next].focus();
  });
  aRenderComparison();
}
