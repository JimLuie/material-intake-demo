'use strict';

const POOL_CATEGORIES={'':'尚未分類',tools:'刀具',consumables:'耗材',other:'其他'};
const poolState={tab:'review',category:'all',search:'',id:null,page:1,scale:1,key:null,busy:false};
const poolEdits=new Map(),organizationRecovery=new Map();
let organizationRequest=null;
function bucketName(bucket){return {materials:'材料區',review:'待分類池',trash:'垃圾桶'}[bucket]||'材料區';}
function poolRows(documents,tab,category,text,suppliers){
  const term=String(text||'').trim().toLocaleUpperCase();
  return documents.filter(doc=>doc.bucket===tab&&(category==='all'||(doc.category||'')===category)&&
    (!term||[doc.name,doc.draft?.meta?.doc,suppliers[doc.draft?.meta?.sup]?.name,POOL_CATEGORIES[doc.category||''],doc.organization?.note].join(' ').toLocaleUpperCase().includes(term)));
}
function openPoolDocument(id){
  const doc=queue.find(d=>d.id===id);if(!doc)return;
  poolState.id=id;poolState.tab=doc.bucket==='trash'?'trash':'review';poolState.category='all';poolState.search='';poolState.key=null;
  $('#poolSearch').value='';$('#poolCategory').value='all';
  state.reviewGeneration++;location.hash='pool';renderPool();
}
function suggestionHtml(doc){
  const hint=doc.organization?.suggestion;
  if(!hint?.evidence?.length||doc.organization?.manual)return '';
  return `<div class="classification-hint"><b>${hint.mixed?'疑似混有不同類別，請人工決定整張去向':'建議分類：'+esc(POOL_CATEGORIES[hint.category]||'尚未分類')}</b><p>依據：${hint.evidence.map(e=>`「${esc(e.text)}」`).join('、')}。僅提醒，尚未搬移。</p><button class="btn btn-sm" type="button" data-action="park">移到待分類池</button></div>`;
}
function renderOrganizationNotice(doc){
  const el=$('#reviewOrganization');if(!el)return;
  const stale=doc&&Number(documentVersionHeaders(doc.id)['X-MaterialDemo-Document-Version'])!==(doc.organization_version??0);
  const html=doc&&!isMaterialDocument(doc)?`<div class="classification-hint"><b>單據目前位於${bucketName(doc.bucket)}</b><p>本頁不能保存或確認；尚未儲存的輸入仍保留於此頁。</p><button class="btn" type="button" data-action="open-pool">查看目前單據</button></div>`:
    stale?'<div class="classification-hint"><b>單據整理版本已變更</b><p>目前輸入仍保留。請重新選取此單據後操作，以免覆蓋最新草稿。</p></div>':doc?suggestionHtml(doc):'';
  const recoveries=[...organizationRecovery.keys()].map(id=>`<div class="net-error">已保存，清單更新失敗。原核對表單已關閉，請重試更新，不必再次搬移。 <button class="btn btn-sm" type="button" data-action="refresh-organization" data-organization-id="${esc(id)}">重試更新清單</button></div>`).join('');
  const retained=[...detachedReviewDrafts.values()].map(d=>`<div class="classification-hint"><b>${esc(d.name)} 已移出材料區</b><p>已停止自動保存，尚未儲存的修改仍保留於此頁。</p><button class="btn btn-sm" type="button" data-action="retained-draft" data-organization-id="${esc(d.id)}">查看保留的修改</button></div>`).join('');
  const notice=recoveries+retained+html;
  if(el.innerHTML!==notice)el.innerHTML=notice;
}
function poolEdit(doc){
  if(!poolEdits.has(doc.id))poolEdits.set(doc.id,{category:doc.category||'',note:doc.organization?.note||'',version:doc.organization_version??0,dirty:false,revision:0});
  const edit=poolEdits.get(doc.id);
  if(!edit.dirty&&edit.version!==(doc.organization_version??0))Object.assign(edit,{category:doc.category||'',note:doc.organization?.note||'',version:doc.organization_version??0});
  return edit;
}
function retainedRowsHtml(items,records=false){
  if(!items?.length)return '<p class="k">沒有保存的明細。</p>';
  const shown=value=>value==null||String(value).trim()===''?'未列':esc(value);
  return `<div class="pool-table"><table class="tbl"><thead><tr><th>品名／牌號</th><th>尺寸</th><th>數量</th><th>單價</th><th>加工費</th><th>明細金額</th></tr></thead><tbody>${items.map(i=>`<tr><td>${esc(i.label||'未列')}<small>${esc(i.grade||'材質未列')}</small></td><td>${(i.dims||[]).some(v=>v!=null&&String(v).trim()!=='')?(i.dims||[]).map(shown).join(' × ')+' '+esc(records?'mm':i.dim_unit||''):'未列'}</td><td>${shown(i.qty)} ${esc(i.unit||'')}</td><td>${money(i.price)}／${esc(billingUnit(i))}</td><td>${money(i.processing_fee)}</td><td>${money(i.amount)}</td></tr>`).join('')}</tbody></table></div>`;
}
function poolMetaHtml(meta={}){
  return '<dl class="kv">'+[['供應商',SUP[meta.sup]?.name],['單據日期',meta.date],['單據號碼',meta.doc],['整單小計',meta.subtotal],['整單稅額',meta.tax],['整單總計',meta.total]].map(([label,value])=>`<dt>${label}</dt><dd>${value==null||String(value).trim()===''?'未列':esc(value)}</dd>`).join('')+'</dl>';
}
function renderPool(){
  const list=$('#poolList');if(!list)return;
  const docs=poolRows(queue,poolState.tab,poolState.category,poolState.search,SUP);
  const counts={review:queue.filter(d=>d.bucket==='review').length,trash:queue.filter(d=>d.bucket==='trash').length};
  $$('#poolTabs button').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.poolTab===poolState.tab));b.textContent=`${bucketName(b.dataset.poolTab)} ${counts[b.dataset.poolTab]}`;});
  $('#poolMatches').textContent=`顯示 ${docs.length} 張 · 移出單據與停用紀錄均保留於此瀏覽器`;
  // Keep an edited document visible even if it no longer matches a background refresh.
  if(!docs.some(d=>d.id===poolState.id)&&!poolEdits.get(poolState.id)?.dirty)poolState.id=docs[0]?.id||null;
  const html=docs.map(d=>`<li><button class="qi ${d.id===poolState.id?'is-sel':''}" type="button" data-pool-id="${esc(d.id)}">${d.pages[0]?`<img class="qi-th" src="${esc(d.pages[0].url)}" alt="" loading="lazy">`:'<span class="qi-th">▤</span>'}<span class="qi-body"><b>${esc(d.draft?.meta?.doc||'未填單號')}</b><span class="qi-name">${esc(d.name)}</span><span>${esc(POOL_CATEGORIES[d.category||''])} · ${esc(SUP[d.draft?.meta?.sup]?.short||'供應商未填')}</span><span class="k">${badge(d.status)} · 材料資料已停用</span></span></button></li>`).join('')||'<li class="queue-empty">此區沒有符合條件的單據</li>';
  if(list.dataset.signature!==html){const scroll=list.scrollTop,focused=document.activeElement?.closest?.('[data-pool-id]')?.dataset.poolId;list.dataset.signature=html;list.innerHTML=html;list.scrollTop=scroll;if(focused)$$('[data-pool-id]',list).find(b=>b.dataset.poolId===focused)?.focus({preventScroll:true});}
  const doc=queue.find(d=>d.id===poolState.id),detail=$('#poolDetail');
  if(!doc||isMaterialDocument(doc)){detail.innerHTML='<div class="empty">選擇左側單據以查看原圖及內容。</div>';poolState.key=null;return;}
  const edit=poolEdit(doc),key=`${doc.id}:${doc.bucket}:${edit.version}`;
  if(key!==poolState.key){
    poolState.key=key;poolState.page=doc.pages[0]?.number||1;poolState.scale=1;
    detail.innerHTML=`<div class="pool-detail-head"><h2>${esc(doc.name)}</h2><p>${bucketName(doc.bucket)} · ${esc(POOL_CATEGORIES[doc.category||''])} · 原有 ${doc.record_count||0} 筆材料紀錄保留停用</p></div><div id="poolRecovery" role="alert"></div><div class="pool-source-toolbar"><a class="btn btn-sm" href="${esc(doc.original_url)}" target="_blank" rel="noopener">開啟原始檔 ↗</a><label>頁次 <select class="inp" id="poolPage">${doc.pages.map(p=>`<option value="${p.number}">${p.number}</option>`).join('')}</select></label><button class="btn btn-sm" data-pool-zoom="out" type="button" aria-label="縮小原圖">−</button><button class="btn btn-sm" data-pool-zoom="in" type="button" aria-label="放大原圖">＋</button><button class="btn btn-sm" data-pool-zoom="width" type="button">符合寬度</button></div><div class="pool-image" tabindex="0" aria-label="單據原圖，可捲動"><img id="poolImage" alt="單據原圖" ${doc.pages.length?'':'hidden'}>${doc.pages.length?'':'<p>尚無預覽，請開啟原始檔。</p>'}</div><div class="pool-metadata"><label>人工分類<select class="inp" id="poolEditCategory" ${doc.bucket==='trash'?'disabled':''}>${Object.entries(POOL_CATEGORIES).map(([v,n])=>`<option value="${v}" ${v===edit.category?'selected':''}>${n}</option>`).join('')}</select></label><label>整理備註<textarea class="inp" id="poolNote" rows="3" maxlength="2000" ${doc.bucket==='trash'?'readonly':''}>${esc(edit.note)}</textarea></label></div><p class="k" id="poolSaveStatus" role="status">${doc.bucket==='trash'?'垃圾桶僅保留與還原，不提供永久刪除。':'類別及備註可獨立保存，不需填寫材料欄位。'}</p><div class="pool-actions">${doc.bucket==='trash'?'<button class="btn btn-primary" data-pool-action="restore" type="button">還原至原區域</button>':'<button class="btn" data-pool-action="metadata" type="button">保存分類與備註</button><button class="btn btn-primary" data-pool-action="material" type="button">移回材料區待確認</button><button class="btn" data-pool-action="trash" type="button">移到垃圾桶</button>'}</div><details><summary>分類建議及判斷依據</summary>${doc.organization?.suggestion?.evidence?.length?`<p>${doc.organization.suggestion.mixed?'疑似混有不同類別 · ':''}${doc.organization.suggestion.evidence.map(e=>esc(e.text)).join('<br>')}</p>`:'<p class="k">沒有足夠的其他類別證據；不以供應商或辨識缺漏判斷。</p>'}</details><details><summary>保存的 OCR 原文</summary><pre class="pool-ocr">${esc(doc.ocr_text||doc.draft?.text||'沒有保存的 OCR 原文')}</pre></details><details open><summary>目前草稿明細</summary>${retainedRowsHtml(doc.draft?.items)}${poolMetaHtml(doc.draft?.meta)}</details><details><summary>原材料紀錄（已停用）</summary>${retainedRowsHtml(doc.retained_records,true)}</details>`;
    updatePoolImage(doc);
  }
  const recovery=organizationRecovery.get(doc.id),recoveryEl=$('#poolRecovery');
  const message=recovery?'<div class="net-error">已保存，清單更新失敗。請重試更新，不必再次搬移。 <button class="btn btn-sm" data-pool-action="refresh" type="button">重試更新清單</button></div>':'';
  if(recoveryEl&&recoveryEl.innerHTML!==message)recoveryEl.innerHTML=message;
  $$('#poolDetail [data-pool-action]').forEach(b=>b.disabled=poolState.busy||(!!recovery&&b.dataset.poolAction!=='refresh'));
}
function updatePoolImage(doc=queue.find(d=>d.id===poolState.id)){
  const image=$('#poolImage'),page=doc?.pages.find(p=>p.number===poolState.page);if(!image||!page)return;
  if(image.getAttribute('src')!==page.url)image.src=page.url;
  image.style.width=(poolState.scale*100)+'%';image.style.maxWidth='none';
}
async function savePoolMetadata(id){
  const edit=poolEdits.get(id);if(!edit?.dirty)return;
  const revision=edit.revision;
  const result=await api(`/api/documents/${id}/organize`,{method:'POST',body:JSON.stringify({action:'metadata',category:edit.category,note:edit.note,expected_version:edit.version})});
  edit.version=result.document.organization_version;
  if(revision===edit.revision)edit.dirty=false;
  const index=queue.findIndex(d=>d.id===id);if(index>=0)queue[index]={...queue[index],...result.document};
  // Metadata-only saves must not replace the focused fields or image viewport.
  if(poolState.id===id)poolState.key=`${id}:${result.document.bucket}:${edit.version}`;
}
async function requestOrganize(id,action){
  if(organizationRequest||poolState.busy||confirming.has(id))return;
  const doc=queue.find(d=>d.id===id);if(!doc)return;
  if(['queued','extracting'].includes(doc.status)){toast('辨識完成後才能整理單據');return;}
  const count=isMaterialDocument(doc)&&doc.ledger_active!==0?(doc.record_count||0):0;
  organizationRequest={id,action,sourceBucket:doc.bucket||'materials',version:doc.organization_version??0,count,generation:state.reviewGeneration,view:state.view};
  const labels={park:'移到待分類池',trash:'移到垃圾桶',material:'移回材料區',restore:'還原單據'};
  $('#organizeTitle').textContent=labels[action];$('#organizeName').textContent=doc.name;
  $('#organizeImpact').textContent=count?`此單據的 ${count} 筆有效材料將退出材料總表、查詢、分析與匯出。原圖、OCR、草稿及金額完整保留。`:
    action==='material'||(action==='restore'&&doc.organization?.restore?.bucket==='materials')?'單據將回到材料區待確認；完成整張確認後才重新啟用材料資料。':'保留原圖、OCR、草稿及金額；可從待分類池或垃圾桶還原。';
  $('#organizeCategoryWrap').hidden=action!=='park';
  $('#organizeCategory').value=doc.organization?.manual?(doc.category||''):(doc.organization?.suggestion?.category||doc.category||'');
  $('#organizeNote').value=doc.organization?.note||'';$('#organizeError').textContent='';
  $('#organizeSubmit').textContent=labels[action];$('#organizeDialog').showModal();
}
async function submitOrganization(){
  const request=organizationRequest;if(!request||poolState.busy)return;
  const {id,action}=request;poolState.busy=true;$('#organizeSubmit').disabled=true;$('#organizeCancel').disabled=true;
  if(organizationRecovery.has(id)){poolState.busy=false;return refreshOrganizationRecovery();}
  let written=false;
  try{
    const doc=queue.find(d=>d.id===id);
    if(isMaterialDocument(doc))await flushDraft(id);else await savePoolMetadata(id);
    const expected_version=action==='park'?request.version:poolEdits.get(id)?.version??request.version;
    const result=await api(`/api/documents/${id}/organize`,{method:'POST',body:JSON.stringify({action,expected_version,category:$('#organizeCategory').value,note:$('#organizeNote').value,acknowledge_records:true,expected_record_count:request.count})});
    written=true;
    if(request.sourceBucket==='materials'&&result.document.bucket!=='materials')reviewMovePending=request;
    clearTimeout(saveTimers.get(id));saveTimers.delete(id);saveChains.delete(id);
    // New input entered while the move was in flight remains recoverable, never re-saved.
    if(!dirty.has(id)){localDrafts.delete(id);localDraftVersions.delete(id);localContentVersions.delete(id);}
    analysisSaves.delete(id);poolEdits.delete(id);
    const index=queue.findIndex(d=>d.id===id);if(index>=0)queue[index]=mergeDocumentSnapshot({...queue[index],...result.document},queue[index]);
    // Hide the old form as soon as the move commits, even if the following read fails.
    renderUpload();updateCounts();
    await refresh(true,{strict:true});
    $('#organizeDialog').close();organizationRequest=null;
    finishOrganizationNavigation(request);
    toast('單據已'+(action==='restore'?'還原':action==='material'?'移回材料區待確認':action==='trash'?'移到垃圾桶':'移到待分類池'));
  }catch(error){
    if(written){organizationRecovery.set(id,request);$('#organizeError').textContent='已保存，清單更新失敗。請重試更新清單，不必再次搬移。';$('#organizeSubmit').textContent='重試更新清單';}
    else $('#organizeError').textContent=error.message;
  }finally{poolState.busy=false;$('#organizeSubmit').disabled=false;$('#organizeCancel').disabled=false;renderPool();renderUpload();}
}
function finishOrganizationNavigation(request){
  if(reviewMovePending===request)reviewMovePending=null;
  if(!organizationNavigationCurrent(request))return;
  const doc=queue.find(d=>d.id===request.id);
  if(request.view==='upload'&&request.sourceBucket==='materials'&&!isMaterialDocument(doc)){
    const next=nextPending(queue,request.id);
    if(next)selectReviewDocument(next.id);
    else{state.qSel=null;state.item=0;state.reviewContext=null;state.reviewGeneration++;renderUpload(true);setQueueOpen(false);toast('目前沒有待確認單據');}
  }else if(isMaterialDocument(doc)){selectReviewDocument(doc.id);location.hash='upload';}
  else openPoolDocument(request.id);
}
async function refreshOrganizationRecovery(id=organizationRequest?.id){
  if(poolState.busy)return;
  const request=organizationRecovery.get(id);if(!request)return;
  poolState.busy=true;$('#organizeSubmit').disabled=true;$('#organizeCancel').disabled=true;
  try{
    await refresh(true,{strict:true});organizationRecovery.delete(id);
    if(organizationRequest===request){$('#organizeDialog').close();organizationRequest=null;}
    finishOrganizationNavigation(request);renderPool();renderUpload();toast('清單已更新');
  }catch(error){toast('已保存，清單更新仍失敗：'+error.message);}
  finally{poolState.busy=false;$('#organizeSubmit').disabled=false;$('#organizeCancel').disabled=false;}
}
function initOrganization(){
  $('#poolCategory').innerHTML='<option value="all">全部類別</option>'+Object.entries(POOL_CATEGORIES).map(([k,v])=>`<option value="${k}">${v}</option>`).join('');
  $('#organizeCategory').innerHTML=Object.entries(POOL_CATEGORIES).map(([k,v])=>`<option value="${k}">${v}</option>`).join('');
  $('#poolTabs').addEventListener('click',e=>{const b=e.target.closest('[data-pool-tab]');if(!b)return;poolState.tab=b.dataset.poolTab;poolState.id=null;renderPool();});
  $('#poolSearch').addEventListener('input',e=>{poolState.search=e.target.value;renderPool();});
  $('#poolCategory').addEventListener('change',e=>{poolState.category=e.target.value;renderPool();});
  $('#poolList').addEventListener('click',e=>{const b=e.target.closest('[data-pool-id]');if(b){poolState.id=b.dataset.poolId;renderPool();}});
  $('#poolDetail').addEventListener('input',e=>{
    if(!['poolNote','poolEditCategory'].includes(e.target.id))return;
    const doc=queue.find(d=>d.id===poolState.id);if(!doc||doc.bucket!=='review')return;
    const edit=poolEdit(doc);edit[e.target.id==='poolNote'?'note':'category']=e.target.value;edit.dirty=true;edit.revision++;
    $('#poolSaveStatus').textContent='有修改尚未保存';
  });
  $('#poolDetail').addEventListener('change',e=>{if(e.target.id==='poolPage'){poolState.page=Number(e.target.value);poolState.scale=1;updatePoolImage();const viewport=$('.pool-image');if(viewport)viewport.scrollTo(0,0);}});
  $('#poolDetail').addEventListener('click',async e=>{
    const zoom=e.target.closest('[data-pool-zoom]');if(zoom){poolState.scale=zoom.dataset.poolZoom==='width'?1:Math.min(6,Math.max(.5,poolState.scale*(zoom.dataset.poolZoom==='in'?1.25:.8)));updatePoolImage();return;}
    const button=e.target.closest('[data-pool-action]');if(!button||poolState.busy)return;
    const action=button.dataset.poolAction,id=poolState.id;
    if(action==='refresh')return refreshOrganizationRecovery(id);
    if(action!=='metadata')return requestOrganize(id,action);
    poolState.busy=true;renderPool();
    try{await savePoolMetadata(id);await refresh(true,{strict:true});if(poolState.id===id)$('#poolSaveStatus').textContent='分類與備註已保存';}
    catch(error){if(poolState.id===id)$('#poolSaveStatus').textContent='保存／更新失敗：'+error.message;toast(error.message);}
    finally{poolState.busy=false;renderPool();}
  });
  $('#organizeSubmit').addEventListener('click',()=>organizationRecovery.has(organizationRequest?.id)?refreshOrganizationRecovery():submitOrganization());
  $('#organizeCancel').addEventListener('click',()=>{if(!poolState.busy){$('#organizeDialog').close();organizationRequest=null;}});
  $('#organizeDialog').addEventListener('cancel',e=>{if(poolState.busy)e.preventDefault();else organizationRequest=null;});
  window.addEventListener('beforeunload',event=>{if([...poolEdits.values()].some(e=>e.dirty)){event.preventDefault();event.returnValue='';}});
}
