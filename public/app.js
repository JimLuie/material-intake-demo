'use strict';
const localDrafts = new Map(), saveTimers = new Map(), saveChains = new Map(), revisions = new Map(), dirty = new Set(), confirming = new Set();
const localDraftVersions=new Map(),localContentVersions=new Map();
function documentVersionHeaders(id){return {'X-MaterialDemo-Document-Version':String(localDraftVersions.get(id)??queue.find(d=>d.id===id)?.organization_version??0),'X-MaterialDemo-Content-Version':String(localContentVersions.get(id)??queue.find(d=>d.id===id)?.content_version??0)};}
function assertMaterialEditable(id){
  const doc=queue.find(d=>d.id===id);
  if(doc&&(localContentVersions.get(id)??doc.content_version??0)!==(doc.content_version??0))throw Error('單據或稅務設定已有較新版本；請重新載入並比對目前修改，本頁內容仍保留。');
  if(!isMaterialDocument(doc)||Number(documentVersionHeaders(id)['X-MaterialDemo-Document-Version'])!==(doc.organization_version??0))throw Error('單據整理位置已變更，請重新開啟目前版本後操作；本頁修改仍保留。');
}
const shapeDimensions=new WeakMap();
let lastRes=null, searchSeq=0, refreshing=null, online=false, toastTimer, searchTimer;

function toast(message) {
  const el=$('#toast');el.textContent=message;el.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,5000);
}
function requestRetryConfirmation(){
  const dialog=$('#retryDialog');dialog.returnValue='';dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='retry'),{once:true}));
}
function documentDraft(id) {
  if (!localDrafts.has(id)) {
    const doc=queue.find(d=>d.id===id);
    if (doc?.draft){localDrafts.set(id,structuredClone(doc.draft));localDraftVersions.set(id,doc.organization_version??0);localContentVersions.set(id,doc.content_version??0);}
  }
  return localDrafts.get(id);
}
function blankItem(page=1) {return {label:'',grade:'',part_no:'',shape:'rect',dims:['','',''],dim_unit:'mm',qty:'',unit:'件',price:'',amount:'',processing_fee:'',material_amount:'',weight_kg:'',pricing_basis:'quantity',note:'',page,raw:''};}
function markDirty(id) {
  assertMaterialEditable(id);
  dirty.add(id);revisions.set(id,(revisions.get(id)||0)+1);
  renderQueue();renderAnalysisCheck();
  clearTimeout(saveTimers.get(id));
  saveTimers.set(id,setTimeout(()=>flushDraft(id).catch(e=>{
    if(state.qSel===id && $('#saveStatus')) $('#saveStatus').textContent='草稿尚未儲存，請恢復連線後儲存';
    toast('草稿尚未儲存：'+e.message);
  }),650));
  if ($('#saveStatus')) $('#saveStatus').textContent='正在儲存草稿…';
}
async function flushDraft(id) {
  clearTimeout(saveTimers.get(id));saveTimers.delete(id);
  if (!dirty.has(id)) return saveChains.get(id);
  assertMaterialEditable(id);
  const revision=revisions.get(id), snapshot=structuredClone(documentDraft(id));
  let headers;
  const task=(saveChains.get(id)||Promise.resolve()).catch(()=>{}).then(()=>{assertMaterialEditable(id);headers=documentVersionHeaders(id);return api(`/api/documents/${id}/draft`,{method:'POST',headers,body:JSON.stringify(snapshot)});});
  saveChains.set(id,task);
  const result=await task;
  // Draft saves turn a confirmed invoice pending immediately, including fast return/reopen actions.
  const doc=queue.find(doc=>doc.id===id);
  const sameVersion=isMaterialDocument(doc)&&Number(headers['X-MaterialDemo-Document-Version'])===(doc.organization_version??0);
  if(sameVersion){if(result.content_version!=null){localContentVersions.set(id,result.content_version);doc.content_version=result.content_version;}doc.status='pending';if(revisions.get(id)===revision){rememberAnalysisSave(id,snapshot,result);dirty.delete(id);}}
  updateCounts();
  if(state.qSel===id&&state.view==='upload')renderUpload();
  if (state.qSel===id && $('#saveStatus')) $('#saveStatus').textContent=dirty.has(id)?'仍有修改待儲存':'草稿已存到此瀏覽器';
}
async function refresh(force=false,{strict=false}={}) {
  // A forced refresh must start after an older poll, so navigation uses a post-save snapshot.
  if(refreshing){await refreshing;if(force)return refresh(true,{strict});return true;}
  let failure;
  const task=(async()=>{
    try {
      const analysisAtRequestStart=new Map(analysisSaves);
      const data=await api('/api/state');
      online=true;clearConnectionIssue();
      SUP={...data.suppliers,xx:{name:'未指定供應商',short:'未指定'}};
      const recordsChanged=JSON.stringify(records)!==JSON.stringify(data.records);
      records=data.records;
      const catalogChanged=updateMaterialCatalog(data.materials);
      const previous=queue.find(d=>d.id===state.qSel);
      const previousDocs=new Map(queue.map(d=>[d.id,d]));
      queue=data.documents.map(d=>mergeDocumentSnapshot(d,previousDocs.get(d.id)));
      for(const doc of queue)mergeAnalysisState(doc,previousDocs.get(doc.id),analysisAtRequestStart.get(doc.id));
      for (const d of queue) {
        if (!dirty.has(d.id) && !saveChains.has(d.id) && !confirming.has(d.id) && d.draft){localDrafts.set(d.id,structuredClone(d.draft));localDraftVersions.set(d.id,d.organization_version??0);localContentVersions.set(d.id,d.content_version??0);}
        if(!isMaterialDocument(d))retainDepartedDraft(d);
      }
      const selected=reconcileUploadSelection();
      if (selected && previous?.status!==selected.status && !dirty.has(selected.id) && !confirming.has(selected.id)) {
        if (selected.draft){localDrafts.set(selected.id,structuredClone(selected.draft));localDraftVersions.set(selected.id,selected.organization_version??0);localContentVersions.set(selected.id,selected.content_version??0);}
      }
      renderSupplierFilters();updateCounts();renderTable();refreshRecordAnalysisDetail();
      renderUpload(force || previous?.status!==selected?.status);
      renderPool();
      if (force) renderTemplates();
      if (force || (state.view==='search' && (recordsChanged||catalogChanged))) await renderSearch();

      if(state.view==='analysis' && recordsChanged && typeof loadAnalysis==='function')loadAnalysis();
      return true;
    } catch(e) {
      failure=e;
      $('#connection').textContent='瀏覽器資料引擎暫時無法使用，請保留本頁';
      if((online||force)&&!strict)toast(e.message);
      online=false;return false;
    }
  })();
  refreshing=task;
  const ok=await task;
  if(refreshing===task)refreshing=null;
  if(!ok&&strict)throw failure;
  return ok;
}

function renderSupplierFilters() {
  const entries=Object.entries(SUP).filter(([k])=>k!=='xx');
  const html=[['all','全部供應商'],...entries.map(([k,v])=>[k,v.short])].map(([k,v])=>`<button type="button" data-sup="${esc(k)}" aria-pressed="${state.fSup===k}">${esc(v)}</button>`).join('');
  if ($('#supSeg').innerHTML!==html) $('#supSeg').innerHTML=html;
}
function updateCounts() {
  $('#cnt-table').textContent=records.length;
  const pending=queueCounts(queue).pending;
  $('#cnt-upload').textContent=pending||'';$('#cnt-real').textContent=queue.length;
  $('#cnt-demo').textContent=pending;$('#cnt-manual').textContent=Object.keys(SUP).length-1;
  $('#cnt-pool').textContent=queue.filter(d=>d.bucket==='review').length||'';
}

async function renderSearch() {
  const seq=++searchSeq;
  try {
    const request=lookupRequest();
    $('#lookupError').hidden=!request.error;$('#lookupError').textContent=request.error;
    const res=request.error?{query:{...request.query,error:request.error},groups:[],total:0}:await api('/api/search?'+request.params);
    if (seq!==searchSeq) return;
    lastRes=res;
    const q=res.query, dims=q.dims, groups=res.groups;
    $('#dro').innerHTML=[...(dims||(q.shape==='round'?[null,null]:[null,null,null])).map((d,i)=>`<div class="dro-c"><div class="dro-k"><b>${i+1}</b>${q.shape==='round'?['直徑','長度'][i]:'尺寸'}</div><div class="dro-v">${d==null?'—':fmtDim(d)}</div><div class="dro-s">${d==null?'mm':state.allow?'需 '+fmtDim(d+2*state.allow)+' mm':'mm'}</div></div>`),`<div class="dro-c mat"><div class="dro-k"><b>M</b>材質</div><div class="dro-v">${esc(q.missing_grade?'材質未列':q.grade||q.family||metalLabel(q.metal))}</div><div class="dro-s">歷史採購，非即時庫存</div></div>`].join('');
    const shown=groups.flatMap(g=>g.items);
    const selected=shown[state.sel]||shown[0];
    if (q.error) {
      $('#results').innerHTML=`<div class="empty"><b>${esc(q.error)}</b></div>`;
    } else if (!shown.length) {
      $('#results').innerHTML=`<div class="empty"><b>沒有符合條件的歷史材料</b>${records.length?'請調整尺寸或材質；任何一邊不足的資料都不會列入。':'請先到「上傳單據」完成辨識與確認，建立材料總表。'}</div>`;
    } else {
      $('#results').innerHTML=`<div class="sec-head"><h2>${groups.length} 家供應商 · 顯示 ${shown.length} 筆</h2><span class="sub">${dims?'每家依體積由小到大，最多 3 筆':'未指定尺寸，每家顯示最近 3 筆'} · 共 ${res.total} 筆符合</span></div>`+groups.map(g=>`<section class="supplier-group"><div class="supplier-head"><h2>${supChip(g.sup,SUP[g.sup]?.name)}</h2><span class="k">符合 ${g.count} 筆 · 顯示 ${g.items.length} 筆</span></div><div class="hits">${g.items.map((m,i)=>hitHtml(m,{rank:i+1,idx:shown.indexOf(m),best:i===0,sel:m===selected})).join('')}</div></section>`).join('');
    }
    if (selected) {
      const r=selected.r, need=res.need;
      $('#vp').innerHTML=`<div class="vp-head"><div><div class="vp-tag">${esc(SUP[r.sup]?.short)} · 規格比對</div><div class="vp-title">${esc(r.label)}<span class="mono">${dimStr(r.dims)}</span></div><div class="k">${esc(r.date||'日期未填')} · ${esc(r.doc||'單號未填')}${!r.grade?' · 材質未列':''}</div></div>${r.shape==='round'?'':TRIAD}</div>${iso(orderedDims(r.dims),need,{aria:'材料與需求尺寸比較'})}<div class="vp-legend"><span><i class="sw sw-stock"></i>歷史材料 mm</span>${need?'<span><i class="sw sw-part"></i>需求（含設定餘量）</span>':''}</div><div class="vp-stats"><div><div class="k">${need?'體積利用率':'材料體積'}</div><div class="stat-v">${need?(selected.util*100).toFixed(1)+'<small>%</small>':cm3(r.dims).toFixed(2)+'<small>cm³</small>'}</div></div><div><div class="k">${need?(r.shape==='round'?'直徑／長度餘量（mm）':'三邊總餘量（mm）'):'計價單位'}</div><div class="stat-v">${need?selected.deltas.map(fmtDim).join(' / '):esc(billingUnit(r))}</div></div>${need&&r.shape!=='round'?`<div><div class="k">置中後每側餘量（mm）</div><div class="stat-v">${selected.deltas.map(d=>fmtMargin(d/2)).join(' / ')}</div></div>`:''}</div>`;
    } else {
      $('#vp').innerHTML=`<div class="vp-head"><div><div class="vp-tag">尺寸比對</div><div class="vp-title">${dims?'需求 '+dimStr(dims)+' mm':'輸入尺寸與材質開始查詢'}</div><div class="k">尺寸足夠的供應商才會出現在結果中</div></div>${q.shape==='round'?'':TRIAD}</div>${dims?iso(null,orderedDims(dims),{aria:'需求尺寸'}):'<div class="empty">尚未選擇材料</div>'}`;
    }
  } catch(e) {if(seq===searchSeq) $('#results').innerHTML=`<div class="net-error">查詢失敗：${esc(e.message)}</div>`;}
}
function hitHtml(m,o) {
  const r=m.r;
  return `<div class="hit ${o.sel?'is-sel':''}" role="button" tabindex="0" data-idx="${o.idx}" data-id="${esc(r.id)}"><div class="hit-rank">${o.rank}</div><div class="hit-mat"><div class="mat-name">${esc(r.label)}${!r.grade?'<span class="material-missing">材質未列</span>':''}${o.best?'<span class="best-badge">本家最接近</span>':''}</div><div class="hit-meta"><span class="mono k">${esc(r.date||'日期未填')}</span><span class="k">${esc(r.part_no||'原單未列料號')}</span></div></div><div class="hit-dims"><div class="dg">${orderedDims(r.dims).map((d,i)=>`<span class="d"><b>${r.shape==='round'&&i===0?'Ø':''}${fmtDim(d)}</b>${m.deltas.length?`<em>+${fmtDim(m.deltas[i])}</em>`:''}</span>`).join('<i>×</i>')}</div><div class="k">${r.shape==='round'?'直徑 × 長度 · ':''}mm</div></div><div class="hit-util">${m.util!=null?`<div class="util-v">${(m.util*100).toFixed(1)}<small>%</small></div><div class="k">體積利用率</div>`:''}</div><div class="hit-price"><div class="mono pv">NT$ ${money(r.price)}</div><div class="k">每${esc(billingUnit(r))} · 曾購 ${money(r.qty)} ${esc(r.unit)}</div><div class="k">${r.weight_kg!=null?'重量 '+money(r.weight_kg)+' 公斤 · ':''}加工費 ${money(r.processing_fee)}</div></div><div class="hit-act"><button class="btn btn-sm" type="button" data-detail="${esc(r.id)}">明細</button></div></div>`;
}
$('#allowSeg').addEventListener('click',e=>{const b=e.target.closest('[data-allow]');if(!b)return;state.allow=+b.dataset.allow;state.sel=0;$$('#allowSeg button').forEach(x=>x.setAttribute('aria-pressed',x===b));renderSearch();});
$('#results').addEventListener('click',e=>{const b=e.target.closest('[data-detail]');if(b)return openDetail(b.dataset.detail);const hit=e.target.closest('[data-idx]');if(hit){state.sel=+hit.dataset.idx;renderSearch();}});
$('#results').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)&&e.target.classList.contains('hit')){e.preventDefault();e.target.click();}});

function openDetail(id) {
  const r=records.find(r=>r.id===id);if(!r)return;
  const doc=queue.find(d=>d.id===r.document_id), page=doc?.pages.find(p=>p.number===r.page)||doc?.pages[0];
  const same=records.filter(x=>x.id!==r.id&&x.grade===r.grade&&(x.shape||'rect')===(r.shape||'rect')&&orderedDims(x.dims).join()===orderedDims(r.dims).join());
  const fields=[['供應商',SUP[r.sup]?.name],['單號',r.doc],['原單料號',r.part_no||'未列'],['日期',r.date],['材料種類',r.label],['牌號',r.grade],['尺寸（mm）',dimStr(r.dims)],['數量',money(r.qty)+' '+r.unit],['重量（公斤）',money(r.weight_kg)],['計價依據',billingBasisName(r)],['計價數量',money(billingQuantity(r))+' '+billingUnit(r)],['單價',`NT$ ${money(r.price)} / ${billingUnit(r)}`],['原單材料費',money(r.material_amount)],['加工費',money(r.processing_fee)],['明細金額',`NT$ ${money(r.amount)}`],['整單小計',money(r.subtotal)],['整單稅額',money(r.tax)],['整單總計',money(r.document_total)],...taxDetailFields(r),['備註',r.note]];
  openDrawer(`<div class="dr-head"><div>${supChip(r.sup)}<h2>${esc(r.label)}</h2><div class="mono">${dimStr(r.dims)} mm</div></div>${X_BTN}</div><section class="dr-sec" id="recordAnalysisDetail" data-record-id="${esc(r.id)}">${recordAnalysisHtml(r,true)}</section><div class="dr-fig">${iso(orderedDims(r.dims),null,{w:440,h:220})}</div><dl class="kv">${fields.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v||'—')}</dd>`).join('')}</dl><div class="dr-sec"><h3>同材質同尺寸的歷史資料</h3>${same.length?`<ul class="hist">${same.sort(byDateDesc).map(x=>`<li><span class="mono">${esc(x.date)}</span>${supChip(x.sup)}<span>NT$ ${money(x.price)} / ${esc(billingUnit(x))}</span><button type="button" class="linkbtn" data-open="${esc(x.id)}">查看</button></li>`).join('')}</ul>`:'<div class="k">目前只有這一筆。</div>'}</div>${page?`<div class="dr-sec"><h3>原始單據</h3><a href="${page.url}" target="_blank" rel="noopener"><img src="${page.url}" alt="原始單據，點擊放大"></a></div>`:''}<div class="doc-edit">${doc?`<button class="btn" data-edit-record="${esc(r.id)}">核對／修改此單據</button>`:'<span class="k">無來源單據</span>'}${doc?`<a class="btn" href="${doc.original_url}" target="_blank" rel="noopener">開啟原始檔</a>`:''}</div>`);
}
$('#drawer').addEventListener('click',e=>{const b=e.target.closest('[data-edit-record]');if(b)openRecordReview(b.dataset.editRecord).catch(err=>toast(err.message));});

const statuses={queued:['等候辨識','run'],extracting:['瀏覽器辨識中','run'],pending:['待確認','pending'],done:['已確認','done'],error:['辨識失敗','error']};
function badge(status){const [label,cls]=statuses[status]||['未知狀態','pending'];return `<span class="pill pill-${cls}">${label}</span>`;}
function input(label,key,value,{type='text',item=false,placeholder='',options=null}={}) {
  const attrs=`data-scope="${item?'item':'meta'}" data-key="${key}"`;
  return `<div class="fld"><label>${esc(label)}${options?`<select class="inp" ${attrs}>${options.map(([k,v])=>`<option value="${esc(k)}" ${String(value??'')===k?'selected':''}>${esc(v)}</option>`).join('')}</select>`:`<input class="inp" ${attrs} type="${type}" value="${esc(value??'')}" placeholder="${esc(placeholder)}" ${type==='number'?'step="any" min="0"':''}>`}</label></div>`;
}
function renderUpload(force=false) {
  const doc=reconcileUploadSelection();
  renderQueue();
  const step=doc?({queued:0,extracting:2,pending:3,done:5,error:2}[doc.status]):0;
  const pipeline=`<ol>${['上傳保存','判斷供應商','瀏覽器辨識','人工確認','寫入總表'].map((name,i)=>`<li class="${i<step?'is-done':i===step?'is-now':''}"><span class="n">${i<step?'✓':i+1}</span>${name}</li>`).join('')}</ol>`;
  if($('#pipeline').dataset.step!==String(step)){$('#pipeline').innerHTML=pipeline;$('#pipeline').dataset.step=String(step);}
  renderReviewWorkspace(doc);
}

function updateCalc() {
  const d=documentDraft(state.qSel);if(!d||!$('#calcHint'))return;
  renderTaxCalculation(d);
  const row=d.items[state.item];
  const number=finiteNumber;
  const amount=number(row.amount),trial=estimateAmount(row),fee=number(row.processing_fee);
  const warnings=[];
  const difference=trial!=null&&amount!=null?Math.round((trial-amount)*100)/100:null;
  if(difference!=null&&Math.abs(difference)>.02000001)warnings.push(`試算與目前明細金額相差 NT$ ${money(difference)}，請核對原單。`);
  if(row.pricing_basis==='weight'&&!(number(row.weight_kg)>0))warnings.push('按重量計價時，請填寫大於 0 的公斤數。');
  const material=number(row.material_amount);
  if(trial!=null&&material!=null&&Math.abs(trial-(fee??0)-material)>.02000001)warnings.push('原單材料費與單價 × 計價數量不同，請核對計價依據。');
  const amounts=d.items.map(i=>number(i.amount));
  const missing=amounts.filter(v=>v==null).length;
  const sum=missing===amounts.length?null:amounts.reduce((a,b)=>a+(b??0),0);
  if(sum!=null&&!missing){const sub=number(d.meta.subtotal),tax=number(d.meta.tax),total=number(d.meta.total);if(sub!=null&&Math.abs(sub-sum)>.02)warnings.push('整單小計與明細加總不符。');if(total!=null&&tax!=null&&Math.abs(total-(sub??sum)-(d.tax_settings?.tax_basis==='included'?0:tax))>.02)warnings.push('整單總計與小計＋稅額不符，請對照原圖修正。');}
  const formula=trial==null?'請填妥單價、計價數量與有效加工費後試算。':`${esc(String(row.price))} × ${esc(String(billingQuantity(row)))} ${esc(billingUnit(row))} ＋ ${money(fee??0)}${fee==null?'（加工費未列，試算視為 0）':''} ＝ NT$ ${money(trial)}`;
  $('#calcHint').innerHTML=`<div class="calc-formula">${formula}</div><div>目前明細金額：NT$ ${money(amount)}${difference!=null?' · 差異（試算－明細）：NT$ '+money(difference):''}</div><div>原單數量 ${money(row.qty)} ${esc(row.unit||'件')} · ${billingBasisName(row)}${number(row.weight_kg)!=null?' · 重量 '+money(row.weight_kg)+' 公斤':''}</div><div>明細 ${state.item+1} / ${d.items.length} 筆${sum!=null?' · 已列金額加總 NT$ '+money(sum):''}${missing?' · '+missing+' 筆金額未列，未納入加總':''}</div>${warnings.length?'<div class="rv-err">'+warnings.map(esc).join('<br>')+'</div>':''}`;
  if($('#priceLabel'))$('#priceLabel').textContent=`單價（NT$／${billingUnit(row)}，可留白）`;
  if($('#applyEstimate'))$('#applyEstimate').disabled=trial==null||confirming.has(state.qSel);
  renderInvoiceSummary(d);renderAnalysisCheck();renderReviewProgress(d);renderReviewActions(queue.find(doc=>doc.id===state.qSel),false);
}
$('#queue').addEventListener('click',async e=>{const b=e.target.closest('[data-qid]');if(!b)return;try{if(state.qSel)await flushDraft(state.qSel);selectReviewDocument(b.dataset.qid);$('#reviewScroll')?.focus({preventScroll:true});}catch(err){toast(err.message);}});
$('#review').addEventListener('input',e=>{
  const field=e.target.closest('[data-key]');if(!field)return;
  if(confirming.has(state.qSel))return;
  try{assertMaterialEditable(state.qSel);}catch(error){toast(error.message);return;}
  const d=documentDraft(state.qSel);if(!d)return;
  const target=field.dataset.scope==='tax'?(d.tax_settings ||= taxSettings(d)):field.dataset.scope==='item'?d.items[state.item]:d.meta;
  if(field.dataset.scope==='tax'){target.source='manual_review';target.evidence='使用者在原圖核對頁調整';}
  const key=field.dataset.key;
  if(key==='shape'){
    const cache=shapeDimensions.get(target)||{};cache[target.shape||'rect']=[...target.dims];shapeDimensions.set(target,cache);
    target.shape=field.value;target.dims=cache[field.value]||Array(field.value==='round'?2:3).fill('');
    invalidateReviewProgress(d,'item');markDirty(state.qSel);renderUpload(true);return;
  }
  if(key.startsWith('dim')&&/^dim\d$/.test(key))target.dims[+key.slice(3)]=field.value;
  else target[key]=field.dataset.scope==='tax'&&key==='tax_rate'&&field.value!==''?Number(field.value):field.value;
  invalidateReviewProgress(d,field.dataset.scope);markDirty(state.qSel);updateCalc();
});
$('#review').addEventListener('change',e=>{if(e.target.dataset.key==='page')renderUpload(true);});
$('#review').addEventListener('click',async e=>{
  const tab=e.target.closest('[data-item]');if(tab){if(confirming.has(state.qSel))return;selectReviewItem(+tab.dataset.item);return;}
  const button=e.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action;
  if(action==='refresh-organization')return refreshOrganizationRecovery(button.dataset.organizationId);
  if(action==='retained-draft'){
    const retained=detachedReviewDrafts.get(button.dataset.organizationId);if(!retained)return;
    openDrawer(`<div class="dr-head"><h2>尚未儲存的修改 · ${esc(retained.name)}</h2>${X_BTN}</div><p class="k">單據已移出材料區；以下內容僅供取回，不會寫回或移動單據。</p><pre class="pool-ocr">${esc(JSON.stringify(retained.draft,null,2))}</pre>`);return;
  }
  const id=state.qSel,draft=documentDraft(id);
  if(confirming.has(id))return;
  if(action==='park'||action==='trash')return requestOrganize(id,action);
  if(action==='open-pool')return openPoolDocument(id);
  try{assertMaterialEditable(id);}catch(error){toast(error.message);return;}
  if(action==='confirm')return confirmReview();
  if(action==='save-next')return saveAndNext();
  if(action==='return-table'||action==='return-analysis')return returnFromReview();
  if(action==='refresh-saved')return retrySavedRefresh();
  button.disabled=true;
  try {
    if(action==='apply-estimate'){
      const item=draft.items[state.item],estimate=estimateAmount(item);
      if(estimate==null)throw Error('計價資料不完整，尚無可套用的試算金額');
      item.amount=estimate;
      const field=$('#review [data-key="amount"]');if(field)field.value=String(estimate);
      invalidateReviewProgress(draft,'item');markDirty(id);updateCalc();toast('已套用試算金額，正在儲存草稿');
    }
    if(action==='add-line'){draft.items.push(blankItem(draft.items[state.item]?.page||1));state.item=draft.items.length-1;invalidateReviewProgress(draft);markDirty(id);renderUpload(true);}
    if(action==='remove-line'&&draft.items.length>1){draft.items.splice(state.item,1);state.item=Math.max(0,state.item-1);invalidateReviewProgress(draft);markDirty(id);renderUpload(true);}
    if(action==='save'){await flushDraft(id);toast('草稿已存到此瀏覽器');}
    if(action==='supplier'){
      const result=await api('/api/suppliers',{method:'POST',body:JSON.stringify({name:$('#newSupplier').value})});
      SUP={...result.suppliers,xx:{name:'未指定',short:'未指定'}};draft.meta.sup=result.id;invalidateReviewProgress(draft);markDirty(id);renderSupplierFilters();renderUpload(true);
    }
    if(action==='retry'){
      if(!await requestRetryConfirmation())return;
      await flushDraft(id);
      await api(`/api/documents/${id}/retry`,{method:'POST',headers:documentVersionHeaders(id),body:JSON.stringify({replace:true})});
      clearTimeout(saveTimers.get(id));saveTimers.delete(id);saveChains.delete(id);dirty.delete(id);localDrafts.delete(id);analysisSaves.delete(id);
      state.item=0;reviewView.editorKey=null;await refresh(true);
    }
  }catch(err){if(state.qSel===id){if($('#rvErr'))$('#rvErr').textContent=err.message;toast(err.message);}}finally{button.disabled=false;updateCalc();}
});
async function addFiles(fileList) {
  const files=[...fileList];if(!files.length)return;
  location.hash='upload';
  for(const file of files){
    if(file.size>50*1024*1024){toast(file.name+' 超過 50 MB');continue;}
    try{const result=await api('/api/upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});state.reviewContext=null;state.reviewGeneration++;state.qSel=result.id;state.item=0;await refresh(true);if(result.bucket&&result.bucket!=='materials')openPoolDocument(result.id);toast(result.duplicate?'這份檔案已存在於'+bucketName(result.bucket||'materials')+'，已開啟原紀錄，未新增或還原。':file.name+' 已保存，正在瀏覽器辨識');}catch(err){toast(file.name+'：'+err.message);}
  }
}
$('#file').addEventListener('change',e=>{addFiles(e.target.files);e.target.value='';});
const drop=$('#drop');
['dragenter','dragover'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.add('is-over');}));
['dragleave','drop'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.remove('is-over');}));
drop.addEventListener('drop',e=>addFiles(e.dataTransfer.files));

function renderTemplates() {
  $('#tpls').innerHTML=Object.values(TPL).map(t=>`<article class="panel tpl linked"><div class="tpl-head"><h2>${supChip(t.key)}${esc(t.name)}</h2><div class="meta">歷史材料 <b>${records.filter(r=>r.sup===t.key).length}</b></div></div><div class="tpl-body"><div>${slipView(t.img,t.boxes,t.name)}</div><div class="tpl-side"><div><a class="btn btn-sm" href="${t.img}" download>下載此虛構範例</a><h3>版型特徵</h3><ul class="marks">${t.marks.map(m=>`<li>${esc(m)}</li>`).join('')}</ul></div><div><h3>欄位對應</h3><ol class="fmap">${t.map.map(([i,label,raw,rule])=>`<li data-i="${i}"><i class="tag">${i}</i><span class="lbl">${esc(label)}</span><span class="raw">${esc(raw)}</span><span class="rule">${esc(rule)}</span></li>`).join('')}</ol></div><p class="k">框線為範本說明位置。實際上傳以文字與表格欄位辨識，不以紙張顏色作為唯一依據。</p></div></div></article>`).join('');
}
document.addEventListener('mouseover',e=>{const scope=e.target.closest('.linked');$$('.linked [data-i]').forEach(el=>el.classList.toggle('is-hot',scope?.contains(el)&&el.dataset.i===e.target.closest('[data-i]')?.dataset.i));});
const VIEWS=['search','table','upload','templates','analysis','pool'];
function go(view) {
  if(!VIEWS.includes(view))view='search';
  if(state.view!==view)state.reviewGeneration++;
  state.view=view;document.body.classList.toggle('review-mode',view==='upload');if(view!=='upload')setQueueOpen(false);VIEWS.forEach(v=>$('#view-'+v).hidden=v!==view);
  $$('.nav-i').forEach(a=>{const active=a.dataset.view===view;a.classList.toggle('is-on',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  if(view==='upload')renderUpload(true);if(view==='table')renderTable();if(view==='search')renderSearch();if(view==='analysis')loadAnalysis();
  if(view==='pool')renderPool();
}
window.addEventListener('hashchange',()=>{go(location.hash.slice(1));if(state.view==='table'&&tableReturnPending)restoreTableReturn();else if(!(state.view==='analysis'&&analysisReturnPending))window.scrollTo(0,0);});
window.addEventListener('beforeunload',event=>{if(dirty.size){event.preventDefault();event.returnValue='';}});
initTax();initOrganization();initLookup();renderTable();renderUpload(true);renderTemplates();go(location.hash.slice(1));refresh(true);
setInterval(()=>refresh(),1600);
