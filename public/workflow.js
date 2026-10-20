'use strict';

// Saved summaries are paired with the exact local snapshot; older polls cannot replace them.
const analysisSaves=new Map();
function stableDraft(value){
  if(Array.isArray(value))return value.map(stableDraft);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stableDraft(value[k])]));
  return value;
}
function reviewItemSignature(item){
  const keys=['label','grade','part_no','shape','dims','dim_unit','qty','unit','price','amount','processing_fee','material_amount','weight_kg','pricing_basis','note','page'];
  return JSON.stringify(stableDraft(Object.fromEntries(keys.filter(k=>k in item).map(k=>[k,item[k]]))));
}
function reviewProgress(draft){
  const t=draft.tax_settings||{},tax={transaction_type:t.transaction_type||'purchase',tax_basis:t.tax_basis||'unknown',tax_rate:t.tax_rate==null?5:t.tax_rate===''?'':Number(t.tax_rate)};
  const meta=JSON.stringify(stableDraft({meta:draft.meta,tax})),p=draft.review_progress;
  const valid=p?.version===1&&!p.completed&&(p.meta===meta||tax.tax_basis==='unknown'&&tax.transaction_type==='purchase'&&p.meta===JSON.stringify(stableDraft(draft.meta)))&&Array.isArray(p.items)&&p.items.length===draft.items.length;
  return {version:1,completed:false,meta,items:draft.items.map((item,i)=>valid&&p.items[i]===reviewItemSignature(item)?p.items[i]:null)};
}
function invalidateReviewProgress(draft,scope='meta',index=state.item){
  const p=reviewProgress(draft);
  if(scope==='item')p.items[index]=null;else p.items.fill(null);
  draft.review_progress=p;
}
function nextUnreviewed(draft,current){
  const p=reviewProgress(draft);
  for(let n=1;n<draft.items.length;n++){const i=(current+n)%draft.items.length;if(!p.items[i])return i;}
  return null;
}
function renderReviewProgress(draft){
  const p=reviewProgress(draft),count=p.items.filter(Boolean).length;
  const progress=$('#reviewProgress');
  if(progress)progress.textContent=`本輪已核對 ${count}／${draft.items.length} 筆 · 全部完成後才更新總表`;
  $$('#reviewScroll [data-item]').forEach(button=>{
    const done=!!p.items[Number(button.dataset.item)];
    const text=`明細 ${Number(button.dataset.item)+1}${done?' ✓ 本輪已核對':''}`;
    if(button.textContent!==text)button.textContent=text;
    button.classList.toggle('is-reviewed',done);
  });
}
function moveToReviewItem(index){
  selectReviewItem(index);
  const scroll=$('#reviewScroll'),form=$('#itemForm');
  if(scroll&&form){scroll.scrollTop=Math.max(0,form.offsetTop-scroll.offsetTop-48);form.querySelector('[data-key]')?.focus({preventScroll:true});}
}
function rememberAnalysisSave(id,snapshot,result){
  if(!result?.analysis_summary)return;
  const saved={snapshot:JSON.stringify(stableDraft(snapshot)),summary:result.analysis_summary};
  analysisSaves.set(id,saved);
  const doc=queue.find(d=>d.id===id);if(doc)doc.analysis_summary=saved.summary;
}
function mergeAnalysisState(doc,previous,saveAtRequestStart){
  if(!isMaterialDocument(doc)||(previous&&(previous.organization_version??0)!==(doc.organization_version??0))||(doc.content_version??0)>(localContentVersions.get(doc.id)??doc.content_version??0)){analysisSaves.delete(doc.id);return;}
  const saved=analysisSaves.get(doc.id);
  if(dirty.has(doc.id)){if(previous)doc.analysis_summary=previous.analysis_summary;return;}
  if(!saved)return;
  if(doc.status==='done'){
    if(saveAtRequestStart===saved){analysisSaves.delete(doc.id);return;}
    doc.analysis_summary=saved.summary;doc.status='pending';return;
  }
  if(['queued','extracting','error'].includes(doc.status)){analysisSaves.delete(doc.id);return;}
  if(JSON.stringify(stableDraft(doc.draft))===saved.snapshot)analysisSaves.delete(doc.id);
  else{doc.analysis_summary=saved.summary;doc.status='pending';}
}
function analysisLabel(summary){
  if(!summary)return '尚未檢查';
  const names={usable:'可分析',partial:'部分可分析',needs_review:'需核對／補充',duplicate:'重複已合併',unsupported:'暫未支援',customer_supplied:'客供料，無購料價格',unchecked:'尚未檢查'};
  return (summary.preview?'預檢 · ':'')+(names[summary.status]||'尚未檢查')+(['usable','partial','needs_review'].includes(summary.status)?` ${summary.usable}／${summary.total}`:'');
}
function analysisNeedsReview(doc){return dirty.has(doc.id)||['partial','needs_review'].includes(doc.analysis_summary?.status);}
function analysisBadge(doc){
  const changed=dirty.has(doc.id),s=doc.analysis_summary;
  return `<span class="analysis-quality ${changed?'modifying':esc(s?.status||'unchecked')}">${changed?'修改中，儲存後檢查':esc(analysisLabel(s))}</span>`+
    (!changed&&s&&s.status!=='unchecked'?`<span class="queue-analysis-note">${[s.tax_unconfirmed?'稅別未確認':'',s.theoretical_weight?'含理論重量估算':''].filter(Boolean).join(' · ')}</span>`:'');
}
function renderAnalysisCheck(doc=queue.find(d=>d.id===state.qSel)){
  const target=$('#reviewAnalysisBody');if(!target||!doc)return;
  const s=doc.analysis_summary,changed=dirty.has(doc.id);
  const html=analysisBadge(doc)+`<p class="k">含稅成交公斤價口徑（含加工費） · ${changed?'修改中的草稿，儲存後預檢。':s?.preview?'確認前僅預檢，不納入曲線。':'依已確認資料判斷。'}稅別須確認；理論重量仍為估算，客供料不納入購料價格。</p>`+
    (changed?'<p class="k">目前修改尚未檢查；儲存成功後更新分析結果。</p>':s?.lines?.map(line=>`<div class="analysis-line"><b>明細 ${line.position+1} · ${esc(line.grade||'材質未列')}</b><span>${line.duplicate_of?'重複已合併':line.transaction_type==='customer_supplied'?'客供料，無購料價格':line.eligible?'可分析':line.issues.length?'需核對／補充':'暫未檢查'}</span>${line.issues.length?`<ul>${line.issues.map(issue=>`<li><button type="button" class="summary-issue warning" data-analysis-issue="true" data-analysis-item="${line.position}" data-analysis-key="${esc(issue.key)}" data-analysis-scope="${esc(issue.scope)}">${esc(issue.message)}</button></li>`).join('')}</ul>`:''}</div>`).join('')||'');
  if(target.innerHTML!==html)target.innerHTML=html;
  const title=$('#reviewAnalysisTitle');if(title)title.textContent=changed?'分析檢查 · 修改中，儲存後檢查':'分析檢查 · '+analysisLabel(s);
}

// Queue selection, invoice review and return navigation share document IDs, never invoice numbers.
function queueCounts(documents){
  documents=documents.filter(isMaterialDocument);
  const counts={all:documents.length,pending:0,processing:0,error:0};
  for(const doc of documents){if(doc.status==='pending')counts.pending++;else if(['queued','extracting'].includes(doc.status))counts.processing++;else if(doc.status==='error')counts.error++;}
  return counts;
}
function filteredQueue(documents,filter,text,suppliers,draftFor=doc=>doc.draft,analysisOnly=false){
  const term=String(text||'').trim().toLocaleUpperCase();
  return documents.filter(doc=>{
    if(!isMaterialDocument(doc))return false;
    if(filter!=='all'&&!(filter==='processing'?['queued','extracting'].includes(doc.status):doc.status===filter))return false;
    if(analysisOnly&&!analysisNeedsReview(doc))return false;
    const meta=draftFor(doc)?.meta||{};
    return !term||[doc.name,meta.doc,suppliers[meta.sup]?.name,suppliers[meta.sup]?.short].join(' ').toLocaleUpperCase().includes(term);
  });
}
function nextPending(documents,current){
  const start=documents.findIndex(doc=>doc.id===current);
  for(let n=1;n<=documents.length;n++){
    const doc=documents[(Math.max(-1,start)+n)%documents.length];
    if(doc.id!==current&&isMaterialDocument(doc)&&doc.status==='pending')return doc;
  }
  return null;
}
// Location versions take priority over content versions: an older poll/save must never
// bring a parked document back into the material editor.
const detachedReviewDrafts=new Map();
let reviewMovePending=null;
function mergeDocumentSnapshot(incoming,previous){
  if(!previous)return incoming;
  const oldLocation=previous.organization_version??0,newLocation=incoming.organization_version??0;
  if(newLocation!==oldLocation)return newLocation>oldLocation?incoming:previous;
  const known=Math.max(previous.content_version??0,localContentVersions.get(incoming.id)??0);
  return (incoming.content_version??0)<known?previous:incoming;
}
function retainDepartedDraft(doc){
  if(!doc)return;
  clearTimeout(saveTimers.get(doc.id));saveTimers.delete(doc.id);
  if(dirty.has(doc.id)&&localDrafts.has(doc.id))detachedReviewDrafts.set(doc.id,
    {id:doc.id,name:doc.name||doc.id,bucket:doc.bucket,draft:structuredClone(localDrafts.get(doc.id))});
}
function assignReviewDocument(id,item=null,context=null){
  const doc=queue.find(d=>d.id===id);
  if(!isMaterialDocument(doc))return null;
  if(doc.draft&&!dirty.has(id)&&!confirming.has(id)){
    localDrafts.set(id,structuredClone(doc.draft));localDraftVersions.set(id,doc.organization_version??0);localContentVersions.set(id,doc.content_version??0);
  }
  if(item==null){const draft=documentDraft(id);item=Math.max(0,draft?reviewProgress(draft).items.findIndex(value=>!value):-1);}
  state.reviewGeneration++;state.reviewContext=context;state.qSel=id;state.item=item;
  return doc;
}
function organizationNavigationCurrent(request){return state.view===request.view&&state.reviewGeneration===request.generation;}
function reconcileUploadSelection(){
  const selected=queue.find(d=>d.id===state.qSel);
  if(isMaterialDocument(selected))return selected;
  const previousId=state.qSel;
  const ownMove=reviewMovePending&&organizationNavigationCurrent(reviewMovePending)&&(!previousId||reviewMovePending.id===previousId);
  if(previousId){
    retainDepartedDraft(selected||{id:previousId});
    state.qSel=null;state.item=0;state.reviewContext=null;
    if(!ownMove)state.reviewGeneration++;
  }
  // A committed move waits for a fresh list. A failed refresh has a refresh-only retry.
  if(ownMove||state.view!=='upload')return null;
  const next=nextPending(queue,previousId);
  if(next){assignReviewDocument(next.id);setQueueOpen(false);return next;}
  return null;
}
function recordReviewTarget(record,doc){
  if(!doc||doc.id!==record.document_id)return null;
  const pending=doc.status!=='done';
  const position=Number.isInteger(record.position)&&record.position>=0?record.position:0;
  return {item:pending?0:Math.min(position,Math.max(0,(doc.draft?.items.length||1)-1)),pending};
}
function readContinuous(storage){try{return storage.getItem('material-demo:continuous-review')!=='false';}catch{return true;}}
let continuousReview=readContinuous({getItem:key=>localStorage.getItem(key)});
const savedReviewRecovery=new Map(),busyFieldStates=new WeakMap();
let tableReturnPending=null;

function renderQueue(){
  const counts=queueCounts(queue);
  $('#qCount').textContent=`${counts.all} 份 · ${counts.pending} 份待確認`;
  $('#intakeCount').textContent=counts.all;
  const progress=`待確認 ${counts.pending} 張${counts.processing?' · 辨識中 '+counts.processing+' 張':''}${counts.error?' · 失敗 '+counts.error+' 張':''}`;
  $('#intakeProgress').textContent=progress;
  const filters=[['pending','待確認'],['all','全部'],['processing','辨識中'],['error','失敗']];
  const html=filters.map(([key,name])=>`<button class="btn btn-sm" type="button" data-queue-filter="${key}" aria-pressed="${state.queueFilter===key}">${name} <span>${counts[key]}</span></button>`).join('');
  if($('#queueFilters').innerHTML!==html)$('#queueFilters').innerHTML=html;
  const rows=filteredQueue(queue,state.queueFilter,state.queueSearch,SUP,d=>documentDraft(d.id)||d.draft,state.queueAnalysisOnly);
  $('#queueMatches').textContent=`顯示 ${rows.length} 份${state.queueSearch?'搜尋結果':''}`;
  const signature=JSON.stringify([state.queueFilter,state.queueSearch,state.queueAnalysisOnly,rows.map(d=>[d.id,d.name,d.status,d.pages[0]?.url,documentDraft(d.id)?.meta,d.id===state.qSel,d.analysis_summary,dirty.has(d.id)])]);
  if($('#queue').dataset.version===signature)return;
  const list=$('#queue'),scrollTop=list.scrollTop,parentScroll=list.parentElement?.scrollTop,focused=document.activeElement?.closest?.('[data-qid]')?.dataset.qid;
  $('#queue').dataset.version=signature;
  $('#queue').innerHTML=rows.length?rows.map(d=>{
    const meta=(documentDraft(d.id)||d.draft)?.meta||{};
    return `<li><button type="button" class="qi ${d.id===state.qSel?'is-sel':''} ${d.status==='error'?'is-error':''}" data-qid="${esc(d.id)}" ${d.id===state.qSel?'aria-current="true"':''}>${d.pages[0]?`<img class="qi-th" src="${esc(d.pages[0].url)}" alt="" loading="lazy" decoding="async">`:'<span class="qi-th">▤</span>'}<span class="qi-body"><span class="qi-doc mono">${esc(String(meta.doc||'').trim()||'未填單號')}</span><span class="qi-name">${esc(d.name)}</span><span class="qi-meta">${badge(d.status)}${meta.sup?supChip(meta.sup):''}</span>${analysisBadge(d)}</span></button></li>`;
  }).join(''):'<li class="queue-empty">沒有符合條件的單據</li>';
  list.scrollTop=scrollTop;if(list.parentElement)list.parentElement.scrollTop=parentScroll;
  if(focused)$$('[data-qid]',list).find(b=>b.dataset.qid===focused)?.focus({preventScroll:true});
}

function invoiceIssues(draft,suppliers){
  const issues=[];
  const add=(item,key,message,severity='error',scope='item')=>issues.push({item,key,message,severity,scope});
  const meta=draft.meta||{},items=draft.items||[];
  const tax=draft.tax_settings;
  if(tax&&(!Number.isFinite(Number(tax.tax_rate))||tax.tax_rate===''||Number(tax.tax_rate)<0||Number(tax.tax_rate)>100))add(null,'tax_rate','稅率須為 0–100%','error','tax');
  if(!suppliers[meta.sup])add(null,'sup','請確認供應商','error','meta');
  if(meta.date){const date=new Date(meta.date);if(!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==meta.date)add(null,'date','日期格式錯誤','error','meta');}
  for(const [key,name] of [['subtotal','整單小計'],['tax','整單稅額'],['total','整單總計']]){
    if(!isBlank(meta[key])&&(finiteNumber(meta[key])==null||finiteNumber(meta[key])<0))add(null,key,name+'必須是非負數','error','meta');
  }
  if(items.length<1||items.length>200)add(null,'label','每份單據需有 1–200 筆材料明細');
  items.forEach((item,index)=>{
    const check=(key,name,required=false,positive=false)=>{
      const n=finiteNumber(item[key]);
      if((required||!isBlank(item[key]))&&(n==null||(positive?n<=0:n<0)))add(index,key,`${name}必須是${positive?'正':'非負'}數`);
    };
    if(!String(item.label||'').trim())add(index,'label','請填寫品名／材料名稱');
    const shape=item.shape||'rect',count=shape==='round'?2:3;
    if(!['rect','round'].includes(shape))add(index,'shape','形狀不正確');
    if(!Array.isArray(item.dims)||item.dims.length!==count)add(index,'dim0',shape==='round'?'請填直徑與長度兩個尺寸':'請填三個尺寸');
    else item.dims.forEach((value,i)=>{if(!(finiteNumber(value)>0))add(index,'dim'+i,(shape==='round'?['直徑','長度'][i]:'尺寸 '+(i+1))+'必須是正數');});
    if(!['mm','cm','inch'].includes(item.dim_unit||'mm'))add(index,'dim_unit','請確認尺寸單位');
    if(!['件','公斤','支','片','張','組','公尺'].includes(item.unit||'件'))add(index,'unit','請確認數量單位');
    if(!['quantity','weight'].includes(item.pricing_basis||'quantity'))add(index,'pricing_basis','請確認計價依據');
    check('qty','數量',true,true);check('weight_kg','重量',item.pricing_basis==='weight',item.pricing_basis==='weight');
    for(const [key,name] of [['price','單價'],['amount','明細金額'],['processing_fee','加工費'],['material_amount','材料費']])check(key,name);
    const trial=estimateAmount(item),amount=finiteNumber(item.amount),material=finiteNumber(item.material_amount),fee=finiteNumber(item.processing_fee)??0;
    if(trial!=null&&amount!=null&&Math.abs(trial-amount)>.02000001)add(index,'amount',`試算與原單明細金額差異 NT$ ${money(Math.round((trial-amount)*100)/100)}`,'warning');
    if(trial!=null&&material!=null&&Math.abs(trial-fee-material)>.02000001)add(index,'material_amount','材料費與單價 × 計價數量不同','warning');
  });
  const amounts=items.map(item=>finiteNumber(item.amount)),known=amounts.filter(n=>n!=null),sum=known.reduce((a,b)=>a+b,0);
  if(known.length===items.length&&known.length){
    const sub=finiteNumber(meta.subtotal),tax=finiteNumber(meta.tax),total=finiteNumber(meta.total);
    const included=draft.tax_settings?.tax_basis==='included';
    if(sub!=null&&Math.abs(sub-sum)>.02000001)add(null,'subtotal','整單小計與明細加總不符','warning','meta');
    if(total!=null&&tax!=null&&Math.abs(total-(sub??sum)-(included?0:tax))>.02000001)add(null,'total','整單總計與小計＋稅額不符','warning','meta');
  }
  return {issues,sum:known.length?sum:null,missing:items.length-known.length};
}
function isBlank(value){return value==null||String(value).trim()==='';}
function summaryValue(value){return isBlank(value)?'未列':money(value);}
function renderInvoiceSummary(draft){
  const el=$('#invoiceSummaryBody');if(!el)return;
  const result=invoiceIssues(draft,SUP),blocking=result.issues.filter(i=>i.severity==='error').length;
  $('#invoiceSummaryTitle').textContent=`整張單據摘要 · ${draft.items.length} 筆${blocking?' · '+blocking+' 項待補正':''}`;
  const rows=draft.items.map((item,index)=>`<button class="invoice-row ${state.item===index?'is-current':''}" type="button" data-summary-item="${index}" aria-label="核對明細 ${index+1}"><strong>明細 ${index+1} · ${esc(item.label||'品名未填')}</strong><span>${esc(item.grade||'材質未列')} · ${item.shape==='round'?'Ø':''}${(item.dims||[]).map(value=>isBlank(value)?'—':esc(value)).join(' × ')} ${esc(item.dim_unit||'mm')}</span><span>${summaryValue(item.qty)} ${esc(item.unit||'件')} · ${billingBasisName(item)}${item.pricing_basis==='weight'?' '+summaryValue(item.weight_kg)+' 公斤':''}</span><span>單價 ${summaryValue(item.price)}／${esc(billingUnit(item))} · 加工費 ${summaryValue(item.processing_fee)}</span><b>明細金額 NT$ ${summaryValue(item.amount)}</b></button>`).join('');
  const issues=result.issues.map((issue,index)=>`<li><button class="summary-issue ${issue.severity}" type="button" data-summary-issue="${index}">${issue.item==null?'整張單據':'明細 '+(issue.item+1)}：${esc(issue.message)}</button></li>`).join('');
  const html=`<div class="invoice-totals">已列金額加總 NT$ ${money(result.sum)}${result.missing?' · '+result.missing+' 筆金額未列，未納入加總':''}</div><div class="invoice-rows">${rows}</div>${issues?`<ul class="invoice-issues">${issues}</ul>`:'<p class="k">未發現必填缺漏或金額差異，請再對照原圖確認。</p>'}`;
  if(el.innerHTML!==html)el.innerHTML=html;
}
function focusSummaryIssue(issue){
  if(issue.item!=null&&issue.item!==state.item){state.item=issue.item;renderUpload(true);}
  const field=$$('#reviewScroll [data-key]').find(el=>el.dataset.scope===issue.scope&&el.dataset.key===issue.key);
  if(field){field.focus({preventScroll:true});field.scrollIntoView({block:'center',inline:'nearest'});}
}

function renderReviewActions(doc,busy){
  const actions=$('#reviewActions'),ready=doc&&!busy&&isMaterialDocument(doc),context=state.reviewContext;
  const fromAnalysis=context?.kind==='analysis'&&context.documentId===doc?.id;
  const fromTable=!fromAnalysis&&context?.documentId===doc?.id;
  const recovery=doc&&savedReviewRecovery.get(doc.id);
  const key=ready?`${doc.id}:${fromAnalysis?'analysis':fromTable?'table':'queue'}`:'none';
  if(actions.dataset.state!==key){
    actions.dataset.state=key;actions.hidden=!ready;
    actions.innerHTML=!ready?'':`<span class="rv-err" id="rvErr" role="alert"></span><div class="review-action-options">${fromAnalysis?'<button class="linkbtn" type="button" data-action="return-analysis">← 返回分析</button>':fromTable?'<button class="linkbtn" type="button" data-action="return-table">← 返回材料總表</button>':'<label class="continuous-review"><input type="checkbox" id="continuousReview">連續核對，確認後開下一張</label>'}<details class="review-more"><summary>更多操作</summary><div>${fromTable||fromAnalysis?'':'<button class="btn btn-sm" type="button" data-action="save-next">暫存並下一張</button>'}<button class="btn btn-sm" type="button" data-action="retry">重新辨識</button><button class="btn btn-sm" type="button" data-action="park">移到待分類池</button><button class="btn btn-sm" type="button" data-action="trash">移到垃圾桶</button></div></details></div><div class="review-action-buttons"><button class="btn" type="button" data-action="refresh-saved" hidden>重試更新清單</button><button class="btn" type="button" data-action="save">儲存草稿</button><button class="btn btn-primary" type="button" data-action="confirm"></button></div>`;
  }
  if(!ready)return;
  const toggle=$('#continuousReview');if(toggle)toggle.checked=continuousReview;
  const confirm=$('#reviewActions [data-action="confirm"]');
  const draft=documentDraft(doc.id),next=draft&&nextUnreviewed(draft,state.item);
  confirm.textContent=next!=null?'確認本筆並到下一筆':'確認本筆並更新整張單據';
  confirm.disabled=!!recovery;
  $('#reviewActions [data-action="retry"]').hidden=doc.status==='done'||!!recovery;
  $('#reviewActions [data-action="refresh-saved"]').hidden=!recovery;
  $('#reviewActions [data-action="refresh-saved"]').textContent=fromAnalysis?'重試更新分析':'重試更新清單';
  const saveNext=$('#reviewActions [data-action="save-next"]');if(saveNext){saveNext.disabled=!!recovery;saveNext.hidden=doc.status==='done';}
  $('#reviewActions .review-more').hidden=!!recovery;
  if(recovery)$('#rvErr').textContent=recovery.message;
}
function syncReviewBusy(){
  const doc=queue.find(d=>d.id===state.qSel);
  const busy=confirming.has(state.qSel)||!isMaterialDocument(doc)||Number(documentVersionHeaders(state.qSel)['X-MaterialDemo-Document-Version'])!==(doc.organization_version??0);
  $$('#review input, #review select, #review [data-action], #review [data-item], #review [data-summary-item], #review [data-summary-issue]').forEach(el=>{
    const recoveryAction=['refresh-organization','retained-draft'].includes(el.dataset.action);
    if(busy&&!recoveryAction){if(!busyFieldStates.has(el))busyFieldStates.set(el,el.disabled);el.disabled=true;}
    else if(busyFieldStates.has(el)){el.disabled=busyFieldStates.get(el);busyFieldStates.delete(el);}
  });
}
function selectReviewDocument(id,item=null,context=null){
  if(!assignReviewDocument(id,item,context))return false;
  renderUpload(true);setQueueOpen(false);return true;
}
function selectReviewItem(item){
  state.reviewGeneration++;state.item=item;
  if(state.reviewContext?.kind==='analysis'){
    const row=records.find(r=>r.document_id===state.qSel&&r.position===item);
    if(row)state.reviewContext={...state.reviewContext,recordId:row.id,position:item,page:row.page||1};
  }
  renderUpload(true);
}
function reviewStillCurrent(id,generation){return state.view==='upload'&&state.qSel===id&&state.reviewGeneration===generation;}
function captureTableContext(record){
  return {documentId:record.document_id,recordId:record.id,filters:{fText:state.fText,fSup:state.fSup,fFam:state.fFam},sort:{...state.sort},scroll:window.scrollY,tableScroll:$('#tbl').closest('.tbl-wrap').scrollLeft};
}
async function openRecordReview(id){
  const record=records.find(row=>row.id===id);if(!record)return;
  const doc=queue.find(doc=>doc.id===record.document_id);
  const unconfirmed=dirty.has(record.document_id);
  const target=recordReviewTarget(record,unconfirmed&&doc?{...doc,status:'pending'}:doc);
  if(!target){toast('無來源單據');return;}
  if(state.qSel)await flushDraft(state.qSel);
  const context=state.view==='table'?captureTableContext(record):null;
  closeDrawer();selectReviewDocument(doc.id,target.item,context);
  location.hash='upload';
  if(target.pending)toast('這張單據有未確認修改，已開啟目前草稿第一筆，請核對整張單據。');
}
function returnToTable(context,message){
  Object.assign(state,context.filters);state.sort={...context.sort};state.tableHighlight=context.recordId;
  tableReturnPending=context;state.reviewContext=null;
  $('#tFilter').value=state.fText;$('#famSel').value=state.fFam;renderSupplierFilters();
  location.hash='table';
  if(state.view==='table')restoreTableReturn();
  const visible=tableRows().some(row=>row.id===context.recordId);
  toast(message+(visible?'':'；原材料已不在目前篩選結果中，篩選條件已保留。'));
}
function restoreTableReturn(){
  const context=tableReturnPending;if(!context)return;tableReturnPending=null;
  requestAnimationFrame(()=>{
    if(state.view!=='table')return;
    window.scrollTo(0,context.scroll);$('#tbl').closest('.tbl-wrap').scrollLeft=context.tableScroll;
    const button=$$('#tbl [data-review-record]').find(el=>el.dataset.reviewRecord===context.recordId);
    button?.focus({preventScroll:true});
  });
}
function noNextMessage(){const counts=queueCounts(queue);return `沒有其他待確認單據${counts.processing?' · '+counts.processing+' 張辨識中':''}${counts.error?' · '+counts.error+' 張辨識失敗':''}`;}
function advanceReview(id){
  const next=nextPending(queue,id);
  if(next){selectReviewDocument(next.id);return true;}
  return false;
}
function finishSavedReview(id,recovery){
  if(!reviewStillCurrent(id,recovery.generation))return;
  if(recovery.revision!=null&&(revisions.get(id)||0)!==recovery.revision){toast('先前內容已保存；目前另有修改，請再次確認後寫入。');return;}
  if(recovery.context?.kind==='analysis'){
    if(recovery.kind==='return-analysis')aReturnToAnalysis(recovery.context,'草稿已保存，已返回分析；確認整張單據後才會更新分析。');
    else aFinishReview(recovery.context,recovery.analysisResult,true);
    return;
  }
  if(recovery.kind==='confirm'&&recovery.context){returnToTable(recovery.context,`已更新 ${recovery.count} 筆材料`);return;}
  if(recovery.kind==='next'||continuousReview){
    if(advanceReview(id)){toast(recovery.kind==='confirm'?`已保存 ${recovery.count} 筆材料，已開啟下一張待確認單據`:'草稿已保存，已開啟下一張待確認單據');return;}
    toast((recovery.kind==='confirm'?'已確認保存':'草稿已保存')+'；'+noNextMessage());
  }else toast(`已保存 ${recovery.count} 筆材料`);
}
async function confirmReview(){
  assertMaterialEditable(state.qSel);
  const id=state.qSel;if(confirming.has(id)||savedReviewRecovery.has(id))return;
  const draft=documentDraft(id);if(!draft)return;
  const item=state.item;
  const issues=invoiceIssues(draft,SUP).issues;
  const issue=issues.find(i=>i.severity==='error'&&(i.item==null||i.item===item));
  if(issue){focusSummaryIssue(issue);toast(issue.message);return;}
  const next=nextUnreviewed(draft,item);
  if(next==null){
    const remaining=issues.find(i=>i.severity==='error');
    if(remaining){focusSummaryIssue(remaining);toast(remaining.message);return;}
  }
  const recovery={kind:next==null?'confirm':'line',item,next,generation:state.reviewGeneration,context:state.reviewContext};
  confirming.add(id);$('#rvErr')?.replaceChildren();syncReviewBusy();
  let written=false,draftSaved=false;
  const previousProgress=draft.review_progress;
  try{
    const progress=reviewProgress(draft);progress.items[item]=reviewItemSignature(draft.items[item]);
    draft.review_progress=progress;markDirty(id);
    const revision=revisions.get(id)||0;
    await flushDraft(id);
    draftSaved=true;
    if(!reviewStillCurrent(id,recovery.generation)||(revisions.get(id)||0)!==revision)return;
    if(next!=null){
      moveToReviewItem(next);toast(`明細 ${item+1} 已核對並保存草稿，請核對明細 ${next+1}；總表尚未更新。`);return;
    }
    const result=await api(`/api/documents/${id}/confirm`,{method:'POST',headers:documentVersionHeaders(id),body:JSON.stringify(draft)});
    written=true;if(result.content_version!=null){localContentVersions.set(id,result.content_version);const doc=queue.find(d=>d.id===id);if(doc)doc.content_version=result.content_version;}recovery.count=result.count;recovery.revision=revisions.get(id)||0;
    draft.review_progress.completed=true;
    clearTimeout(saveTimers.get(id));saveTimers.delete(id);dirty.delete(id);saveChains.delete(id);analysisSaves.delete(id);
    await refresh(true,{strict:true});
    if(recovery.context?.kind==='analysis')recovery.analysisResult=await aRefreshReview(recovery.context);
    finishSavedReview(id,recovery);
  }catch(error){
    if(!draftSaved){if(previousProgress)draft.review_progress=previousProgress;else delete draft.review_progress;}
    if(written){recovery.message=recovery.context?.kind==='analysis'?'已保存，但最新分析取得失敗。請按「重試更新分析」，不必重複確認。':'已保存，清單更新失敗。請按「重試更新清單」，不必重複確認。';savedReviewRecovery.set(id,recovery);}
    if(reviewStillCurrent(id,recovery.generation)){
      if(!written)focusReviewError(error.message);
      toast(written?recovery.message:error.message);
    }
  }finally{confirming.delete(id);if(state.qSel===id){syncReviewBusy();renderReviewActions(queue.find(doc=>doc.id===id),false);updateCalc();}}
}
async function saveAndNext(){
  const id=state.qSel;if(confirming.has(id)||savedReviewRecovery.has(id)||state.reviewContext)return;
  const recovery={kind:'next',generation:state.reviewGeneration};
  confirming.add(id);syncReviewBusy();let saved=false;
  try{await flushDraft(id);saved=true;recovery.revision=revisions.get(id)||0;await refresh(true,{strict:true});finishSavedReview(id,recovery);}
  catch(error){
    if(saved){recovery.message='草稿已保存，清單更新失敗。請按「重試更新清單」。';savedReviewRecovery.set(id,recovery);}
    if(reviewStillCurrent(id,recovery.generation)){$('#rvErr').textContent=saved?recovery.message:error.message;toast($('#rvErr').textContent);}
  }finally{confirming.delete(id);if(state.qSel===id){syncReviewBusy();renderReviewActions(queue.find(doc=>doc.id===id),false);updateCalc();}}
}
async function retrySavedRefresh(){
  const id=state.qSel,recovery=savedReviewRecovery.get(id);if(!recovery||confirming.has(id))return;
  confirming.add(id);syncReviewBusy();
  try{await refresh(true,{strict:true});if(recovery.context?.kind==='analysis')recovery.analysisResult=await aRefreshReview(recovery.context);savedReviewRecovery.delete(id);if($('#rvErr'))$('#rvErr').textContent='';finishSavedReview(id,recovery);}
  catch(error){if(state.qSel===id)toast(recovery.message);}
  finally{confirming.delete(id);if(state.qSel===id){syncReviewBusy();renderReviewActions(queue.find(doc=>doc.id===id),false);updateCalc();}}
}
async function returnFromReview(){
  const id=state.qSel,context=state.reviewContext,generation=state.reviewGeneration;if(!context||confirming.has(id))return;
  confirming.add(id);syncReviewBusy();
  const recovery={kind:'return-analysis',generation,context};let saved=false;
  try{
    const modified=dirty.has(id)||queue.find(doc=>doc.id===id)?.status!=='done';await flushDraft(id);saved=true;recovery.revision=revisions.get(id)||0;
    if(context.kind==='analysis'){
      await refresh(true,{strict:true});recovery.analysisResult=await aRefreshReview(context);
      if(reviewStillCurrent(id,generation)){savedReviewRecovery.delete(id);aReturnToAnalysis(context,modified?'草稿已保存，已返回分析；確認整張單據後才會更新分析。':'已返回分析');}
    }else if(reviewStillCurrent(id,generation))returnToTable(context,modified?'草稿已保存；確認更新後才會變更總表':'已返回材料總表');
  }
  catch(error){if(saved&&context.kind==='analysis'){recovery.message='草稿已保存，但最新分析取得失敗。請按「重試更新分析」後返回。';savedReviewRecovery.set(id,recovery);}if(reviewStillCurrent(id,generation)){$('#rvErr').textContent=recovery.message||error.message;toast($('#rvErr').textContent);}}
  finally{confirming.delete(id);syncReviewBusy();if(state.qSel===id)renderReviewActions(queue.find(doc=>doc.id===id),false);}
}

$('#queueAnalysisOnly').addEventListener('change',e=>{state.queueAnalysisOnly=e.target.checked;renderQueue();});
$('#queueSearch').addEventListener('input',e=>{state.queueSearch=e.target.value;renderQueue();});
$('#queueFilters').addEventListener('click',e=>{const button=e.target.closest('[data-queue-filter]');if(button){state.queueFilter=button.dataset.queueFilter;renderQueue();}});
$('#review').addEventListener('change',e=>{
  if(e.target.id!=='continuousReview')return;
  continuousReview=e.target.checked;
  try{localStorage.setItem('material-demo:continuous-review',String(continuousReview));}catch{/* The current session still uses the selected preference. */}
});
$('#review').addEventListener('click',e=>{
  if(confirming.has(state.qSel))return;
  const analysisIssue=e.target.closest('[data-analysis-issue]');
  if(analysisIssue&&!dirty.has(state.qSel)){selectReviewItem(Number(analysisIssue.dataset.analysisItem));focusSummaryIssue({item:Number(analysisIssue.dataset.analysisItem),key:analysisIssue.dataset.analysisKey,scope:analysisIssue.dataset.analysisScope});}
  const row=e.target.closest('[data-summary-item]'),issue=e.target.closest('[data-summary-issue]');
  if(row){selectReviewItem(Number(row.dataset.summaryItem));$('#itemForm')?.scrollIntoView({block:'start'});}
  if(issue){const result=invoiceIssues(documentDraft(state.qSel),SUP),target=result.issues[+issue.dataset.summaryIssue];if(target){selectReviewItem(target.item??state.item);focusSummaryIssue(target);}}
});
