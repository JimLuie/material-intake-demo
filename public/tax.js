'use strict';
const taxPreviewState={rows:[],busy:false,correction:null};
function taxSettings(draft){return {...{transaction_type:'purchase',tax_basis:'unknown',tax_rate:5,source:'unconfirmed',evidence:''},...(draft?.tax_settings||{})};}
function taxBasisName(basis){return ({included:'已含稅',pretax:'另加稅',unknown:'待確認'})[basis]||'待確認';}
function taxTransactionName(value){return value==='customer_supplied'?'客供料':'購料';}
function taxReviewHtml(draft){
  const cfg=taxSettings(draft);
  const field=(label,key,options)=>input(label,key,cfg[key],options?{options}:{type:'number'}).replace('data-scope="meta"','data-scope="tax"');
  return `<section class="tax-review"><h2 class="meta-title">交易與營業稅</h2><div class="form-grid">${field('交易性質','transaction_type',[['purchase','購料'],['customer_supplied','客供料']])}${field('單價稅別','tax_basis',[['unknown','待確認'],['included','已含稅'],['pretax','另加稅']])}${field('稅率（%）','tax_rate')}</div><p class="k">${esc(cfg.evidence||'請對照原單確認稅別；其他供應商不依空白稅額推定。')} 最後確認整張時保存本設定；人工設定優先。</p><div id="taxCalculation" role="status" aria-live="polite"></div><button class="btn btn-sm" type="button" data-tax-correction>比對保存 OCR 的辨識修正候選</button></section>`;
}
function taxCalculation(draft){
  const cfg=taxSettings(draft),values=(draft.items||[]).map(i=>finiteNumber(i.amount)),missing=values.some(v=>v==null||v<0);
  if(cfg.transaction_type==='customer_supplied')return '客供料，無購料價格；保留數量與尺寸，價格及金額未列仍留白。';
  if(cfg.tax_basis==='unknown')return '單價稅別待確認；確認後才可計算含稅成交公斤價。';
  if(missing)return '部分明細金額未列或無效，暫不計算整單營業稅；不從頁尾或差額補寫明細。';
  const sum=values.reduce((a,b)=>a+b,0),rate=finiteNumber(cfg.tax_rate);
  if(rate==null||rate<0||rate>100)return '請填有效稅率（0–100%）。';
  const printed=finiteNumber(draft.meta.tax),total=finiteNumber(draft.meta.total);
  const estimated=Math.round((cfg.tax_basis==='included'?sum-sum/(1+rate/100):sum*rate/100)+Number.EPSILON);
  const expected=cfg.tax_basis==='included'?sum:sum+(printed??estimated);
  return `原單營業稅：${printed==null?'未列':'NT$ '+money(printed)} · ${cfg.tax_basis==='included'?'內含營業稅拆算（估算）':'營業稅試算（整元）'}：NT$ ${money(estimated)}。${cfg.tax_basis==='included'?'明細已含稅，不再次加稅。':'按明細金額比例分攤營業稅，原單稅額優先；未列時使用試算，原單欄位仍留白。'} 含稅合計試算 NT$ ${money(expected)}${total==null?'；缺少整單含稅總計，無法勾稽。':Math.abs(expected-total)>.02000001?'；與原單含稅總計不符，請核對。':'；與原單含稅總計相符。'}`;
}
function renderTaxCalculation(draft){const el=$('#taxCalculation');if(el)el.textContent=taxCalculation(draft);}
function taxDetailFields(row){
  const s=row.analysis_summary||row;
  return [['交易性質',taxTransactionName(s.transaction_type)],['單價稅別',taxBasisName(s.tax_basis)],['稅率',s.tax_rate==null?'未列':money(s.tax_rate)+'%'],['分攤營業稅',s.allocated_tax==null?'未列／已內含':money(s.allocated_tax)+(s.tax_estimated?'（試算分攤）':'')],['含稅成交金額（含加工費）',s.gross_amount==null?'未列':money(s.gross_amount)],['含稅成交公斤價',s.gross_unit_kg==null?'未列':money(s.gross_unit_kg)+'／公斤']];
}
function taxExportValues(row){const s=row.analysis_summary||{};return [s.transaction_type,s.tax_basis,s.tax_rate,s.allocated_tax,s.gross_amount,s.gross_unit_kg];}
async function openTaxPreview(){
  if(taxPreviewState.busy)return;
  taxPreviewState.busy=true;
  try{
    for(const id of [...dirty])await flushDraft(id);
    const result=await api('/api/documents/tax-preview');taxPreviewState.rows=result.documents;
    openDrawer(`<div class="dr-head"><div><h2>稅別更新預覽</h2><p>${esc(result.message)}</p></div>${X_BTN}</div><p class="k">衝突與待確認單據不預選。保存稅務設定不會修正單價或明細金額；辨識錯讀請進入原圖逐張核對。</p><div id="taxPreviewRows">${result.documents.map((r,i)=>`<article class="tax-preview-card" data-tax-index="${i}"><label class="analysis-check"><input type="checkbox" data-tax-select ${r.selected?'checked':''} ${r.selectable?'':'disabled'}><b>${esc(r.doc||'未填單號')} · ${esc(SUP[r.sup]?.short||'未確認供應商')}</b></label><p>${esc(r.name)}</p><p>原設定：${r.original.settings?.tax_basis?esc(taxBasisName(r.original.settings.tax_basis)):'未確認'} · 原單小計 ${money(r.original.subtotal)} · 營業稅 ${money(r.original.tax)} · 含稅總計 ${money(r.original.total)}</p><div class="form-grid"><label>交易性質<select class="inp" data-tax-value="transaction_type">${[['purchase','購料'],['customer_supplied','客供料']].map(([v,l])=>`<option value="${v}" ${r.suggested.transaction_type===v?'selected':''}>${l}</option>`).join('')}</select></label><label>建議單價稅別<select class="inp" data-tax-value="tax_basis">${[['unknown','待確認'],['included','已含稅'],['pretax','另加稅']].map(([v,l])=>`<option value="${v}" ${r.suggested.tax_basis===v?'selected':''}>${l}</option>`).join('')}</select></label><label>稅率 %<input class="inp" type="number" min="0" max="100" step="any" data-tax-value="tax_rate" value="${esc(r.suggested.tax_rate)}"></label></div><p class="k">依據：${esc(r.suggested.evidence||'無明確範本規則，請人工選定')}</p><p>含稅成交金額：${r.converted.map(v=>v.gross_amount==null?'未列':money(v.gross_amount)).join('／')||'未列'}</p>${r.conflicts.length?`<ul class="warning-list">${r.conflicts.map(v=>`<li>${esc(v)}</li>`).join('')}</ul>`:'<p class="analysis-ok">整單金額勾稽通過；重量及牌號仍依分析條件檢查。</p>'}<p>OCR 新舊值差異 ${r.correction_count} 項 <button class="btn btn-sm" type="button" data-tax-open="${esc(r.id)}">開啟原圖核對</button></p></article>`).join('')}</div><p role="alert" id="taxPreviewError"></p><button class="btn btn-primary" type="button" data-tax-apply>保存勾選的稅務設定</button>`);
  }finally{taxPreviewState.busy=false;}
}
async function applyTaxPreview(button){
  if(taxPreviewState.busy)return;
  const documents=$$('#taxPreviewRows [data-tax-index]').filter(el=>el.querySelector('[data-tax-select]').checked).map(el=>{
    const row=taxPreviewState.rows[Number(el.dataset.taxIndex)],cfg={...row.suggested};
    el.querySelectorAll('[data-tax-value]').forEach(field=>cfg[field.dataset.taxValue]=field.value);
    if(dirty.has(row.id))throw Error('這張單據另有尚未保存修改，請先儲存並重新預覽。');
    return {id:row.id,version:row.version,organization_version:row.organization_version,settings:cfg,localRevision:revisions.get(row.id)||0};
  });
  if(!documents.length)throw Error('請先勾選單據。');
  taxPreviewState.busy=true;button.disabled=true;let saved=false;
  try{
    const result=await api('/api/documents/tax-apply',{method:'POST',body:JSON.stringify({documents})});saved=true;
    for(const row of documents){if(dirty.has(row.id)||(revisions.get(row.id)||0)!==row.localRevision)continue;localDrafts.delete(row.id);localDraftVersions.delete(row.id);localContentVersions.delete(row.id);saveChains.delete(row.id);analysisSaves.delete(row.id);}
    await refresh(true,{strict:true});closeDrawer();toast(`已保存 ${result.count} 張稅務設定；原單單價、數量及金額未修改。`);
  }catch(error){if(saved){button.textContent='已保存，重試更新清單';button.dataset.taxApplySaved='true';}throw Error(saved?'已保存，清單更新失敗；請按重試更新，不必再次套用。':error.message);}
  finally{taxPreviewState.busy=false;button.disabled=false;}
}
async function openTaxCorrection(){
  const id=state.qSel,generation=state.reviewGeneration;if(!id)return;
  await flushDraft(id);
  const result=await api(`/api/documents/${id}/recognition-preview`);
  if(!reviewStillCurrent(id,generation))return;
  taxPreviewState.correction=result;
  const names={price:'單價',amount:'明細金額',qty:'數量',dims:'尺寸',material_amount:'材料費',processing_fee:'加工費',total:'含稅總計',tax:'原單營業稅',subtotal:'原單小計'};
  openDrawer(`<div class="dr-head"><div><h2>辨識修正候選</h2><p>${esc(result.message)}</p></div>${X_BTN}</div><ul>${result.differences.map((d,i)=>`<li class="tax-preview-card"><label class="analysis-check"><input type="checkbox" data-correction-index="${i}">${d.item==null?'整單':'明細 '+(d.item+1)} · ${esc(names[d.key]||d.key)}：<del>${esc(JSON.stringify(d.old)??'未列')}</del> → <b>${esc(JSON.stringify(d.new)??'未列')}</b></label></li>`).join('')||'<li>目前沒有新舊值差異。可直接關閉，對照原圖人工修改。</li>'}</ul><p class="k">此處未套用任何修改。勾選後僅帶入目前草稿；請核對左側原圖並逐筆確認，全部完成才更新材料總表。</p><p id="taxPreviewError" role="alert"></p><button class="btn btn-primary" type="button" data-correction-apply ${result.differences.length?'':'disabled'}>帶入勾選候選並核對原圖</button>`);
}
function applyTaxCorrection(){
  const preview=taxPreviewState.correction,id=preview?.id;
  if(!preview||state.qSel!==id||state.view!=='upload')throw Error('已切換單據，請重新開啟候選。');
  assertMaterialEditable(id);
  if(Number(documentVersionHeaders(id)['X-MaterialDemo-Content-Version'])!==preview.version||dirty.has(id))throw Error('草稿已有修改，候選未套用；請重新比對。');
  const changes=$$('[data-correction-index]:checked').map(el=>preview.differences[Number(el.dataset.correctionIndex)]);
  if(!changes.length)throw Error('請勾選要帶入的候選。');
  const draft=documentDraft(id);
  if(changes.some(c=>c.item!=null&&!draft.items[c.item]))throw Error('候選明細數量不同，請在原圖核對頁手動增刪明細。');
  for(const c of changes){const target=c.item==null?draft.meta:draft.items[c.item];target[c.key]=structuredClone(c.new);}
  invalidateReviewProgress(draft);markDirty(id);reviewView.editorKey=null;closeDrawer();renderUpload(true);toast('候選已帶入草稿；請核對原圖並確認整張，材料總表尚未更新。');
}
function initTax(){
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-tax-preview], [data-tax-apply], [data-tax-open], [data-tax-correction], [data-correction-apply]');if(!button)return;
    try{
      if(button.hasAttribute('data-tax-preview'))await openTaxPreview();
      else if(button.hasAttribute('data-tax-apply')){if(button.dataset.taxApplySaved){await refresh(true,{strict:true});closeDrawer();toast('清單已更新');}else await applyTaxPreview(button);}
      else if(button.hasAttribute('data-tax-open')){closeDrawer();selectReviewDocument(button.dataset.taxOpen);location.hash='upload';}
      else if(button.hasAttribute('data-tax-correction'))await openTaxCorrection();
      else if(button.hasAttribute('data-correction-apply'))applyTaxCorrection();
    }catch(error){if($('#taxPreviewError'))$('#taxPreviewError').textContent=error.message;toast(error.message);}
  });
}
