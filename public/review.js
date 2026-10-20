'use strict';

// Only transient presentation state lives here. Drafts and server records keep their existing shape.
const reviewView = {docId:null,pageKey:null,item:null,editorKey:null,mode:'width',scale:1,
  imageWidth:0,imageHeight:0,generation:0,observer:null,resizeFrame:0};

function setQueueOpen(open) {
  $('#intakeQueue').hidden=!open;
  $('#toggleQueue').setAttribute('aria-expanded',String(open));
  if(open) $('#intakeQueue [data-close-queue]').focus();
}

function captureReviewPosition() {
  const active=document.activeElement;
  const field=active?.closest('#review [data-key], #review [data-item]');
  return {scroll:$('#reviewScroll')?.scrollTop||0,
    focus:field?{scope:field.dataset.scope,key:field.dataset.key,item:field.dataset.item,
      start:field.selectionStart,end:field.selectionEnd}:null,
    details:$$('#reviewScroll details').map(d=>d.open)};
}

function restoreReviewPosition(saved, sameDocument) {
  if(!sameDocument)return;
  const scroll=$('#reviewScroll');
  if(scroll)scroll.scrollTop=saved.scroll;
  $$('#reviewScroll details').forEach((d,i)=>{if(saved.details[i]!=null)d.open=saved.details[i];});
  const f=saved.focus;
  if(!f)return;
  const target=f.key?$$('#review [data-key]').find(el=>el.dataset.key===f.key&&el.dataset.scope===f.scope):
    $$('#review [data-item]').find(el=>el.dataset.item===f.item);
  if(target){target.focus({preventScroll:true});if(f.start!=null&&target.type==='text')target.setSelectionRange(f.start,f.end);}
}

function ensureReviewShell() {
  if($('#reviewWorkspace'))return;
  $('#review').innerHTML=`
    <div class="rv-head review-heading">
      <div class="review-heading-text"><div class="rv-title" id="reviewName"></div><div class="rv-chips" id="reviewBadge"></div></div>
      <span class="review-status" id="saveStatus" role="status" aria-live="polite"></span>
    </div>
    <div id="reviewOrganization" aria-live="polite"></div>
    <div class="review-workspace" id="reviewWorkspace">
      <section class="source-pane" aria-label="單據原圖檢視器">
        <div class="source-toolbar" role="group" aria-label="原圖縮放">
          <span class="source-label">單據原圖</span>
          <button class="btn btn-sm" type="button" data-viewer="out" aria-label="縮小單據">−</button>
          <output id="viewerZoom" aria-live="polite" aria-label="原圖縮放比例">—</output>
          <button class="btn btn-sm" type="button" data-viewer="in" aria-label="放大單據">＋</button>
          <button class="btn btn-sm" type="button" data-viewer="width" aria-pressed="true">符合寬度</button>
          <button class="btn btn-sm" type="button" data-viewer="page" aria-pressed="false">顯示整頁</button>
        </div>
        <div class="source-pagebar" id="viewerPagebar"></div>
        <div class="source-viewport" id="sourceViewport" tabindex="0" role="region" aria-label="單據原圖，可水平及垂直捲動">
          <figure class="source-stage" id="sourceStage" hidden><img id="sourceImage" alt="" draggable="false"></figure>
          <div class="source-placeholder" id="sourcePlaceholder">選取材料單據後，原圖會顯示在這裡。</div>
        </div>
        <div class="source-hint">放大後可捲動查看細節；右側欄位可獨立捲動核對。</div>
      </section>
      <section class="editor-pane" aria-label="單據資料核對">
        <div class="editor-scroll" id="reviewScroll" tabindex="0" role="region" aria-label="核對欄位，可獨立捲動"></div>
        <div class="rv-actions review-actions" id="reviewActions"></div>
      </section>
    </div>`;
  reviewView.observer?.disconnect();
  reviewView.observer=new ResizeObserver(()=>{
    cancelAnimationFrame(reviewView.resizeFrame);
    reviewView.resizeFrame=requestAnimationFrame(()=>{
      if(reviewView.mode!=='manual'&&state.view==='upload')fitSource(reviewView.mode,false);
    });
  });
  reviewView.observer.observe($('#sourceViewport'));
}

function applySourceScale(scale,reset=false) {
  if(!reviewView.imageWidth)return;
  const viewport=$('#sourceViewport'),stage=$('#sourceStage'),old=reviewView.scale;
  const oldWidth=reviewView.imageWidth*old;
  const centerX=(viewport.scrollLeft+viewport.clientWidth/2-Math.max(0,(viewport.clientWidth-24-oldWidth)/2))/old;
  const centerY=(viewport.scrollTop+viewport.clientHeight/2)/old;
  reviewView.scale=Math.max(.01,Math.min(4,scale));
  stage.style.width=(reviewView.imageWidth*reviewView.scale)+'px';
  stage.style.height=(reviewView.imageHeight*reviewView.scale)+'px';
  $('#viewerZoom').textContent=Math.round(reviewView.scale*100)+'%';
  $$('[data-viewer="width"], [data-viewer="page"]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.viewer===reviewView.mode)));
  if(reset){viewport.scrollLeft=0;viewport.scrollTop=0;}
  else {viewport.scrollLeft=centerX*reviewView.scale-viewport.clientWidth/2;viewport.scrollTop=centerY*reviewView.scale-viewport.clientHeight/2;}
}

function fitSource(mode='width',reset=true) {
  const viewport=$('#sourceViewport');
  if(!viewport||viewport.clientWidth===0||!reviewView.imageWidth)return;
  reviewView.mode=mode;
  const width=Math.max(1,viewport.clientWidth-24)/reviewView.imageWidth;
  const height=Math.max(1,viewport.clientHeight-24)/reviewView.imageHeight;
  applySourceScale(mode==='page'?Math.min(width,height):width,reset);
}

function renderSource(doc,item) {
  const pages=doc?.pages||[];
  const page=pages.find(p=>p.number===Number(item?.page))||pages[0];
  const pagebar=doc?`<a class="linkbtn" href="${esc(doc.original_url)}" target="_blank" rel="noopener">開啟原始檔 ↗</a><div class="source-pages">${pages.length>1?`<button class="btn btn-sm" type="button" data-viewer="previous" aria-label="上一頁" ${page===pages[0]?'disabled':''}>‹</button><label>頁次 <select class="sel" aria-label="單據頁次" data-scope="item" data-key="page">${pages.map(p=>`<option value="${p.number}" ${p===page?'selected':''}>${p.number}</option>`).join('')}</select></label><span class="k">/ ${pages.length}</span><button class="btn btn-sm" type="button" data-viewer="next" aria-label="下一頁" ${page===pages[pages.length-1]?'disabled':''}>›</button>`:`<span class="k">${page?'第 1 / 1 頁':'等待預覽'}</span>`}</div>`:'';
  const pagebarKey=JSON.stringify([doc?.id,doc?.original_url,pages.map(p=>p.number),page?.number]);
  if($('#viewerPagebar').dataset.version!==pagebarKey){$('#viewerPagebar').innerHTML=pagebar;$('#viewerPagebar').dataset.version=pagebarKey;}
  const key=doc?`${doc.id}:${page?.number||''}:${page?.url||''}`:'empty';
  if(reviewView.pageKey===key)return;
  reviewView.pageKey=key;
  reviewView.mode='width';reviewView.scale=1;reviewView.imageWidth=0;reviewView.imageHeight=0;
  const generation=++reviewView.generation;
  const img=$('#sourceImage'),placeholder=$('#sourcePlaceholder');
  $('#sourceStage').hidden=true;placeholder.hidden=false;
  $('#sourceViewport').scrollTop=0;$('#sourceViewport').scrollLeft=0;
  $('#viewerZoom').textContent='—';
  $$('[data-viewer]').filter(el=>['in','out','width','page'].includes(el.dataset.viewer)).forEach(el=>el.disabled=true);
  if(!page){img.removeAttribute('src');placeholder.textContent=doc?'原圖預覽尚未就緒，可開啟原始檔核對。':'選取材料單據後，原圖會顯示在這裡。';return;}
  placeholder.textContent='正在載入單據原圖…';
  img.onload=()=>{
    if(generation!==reviewView.generation)return;
    reviewView.imageWidth=img.naturalWidth;reviewView.imageHeight=img.naturalHeight;
    $('#sourceStage').hidden=false;placeholder.hidden=true;
    $$('[data-viewer]').filter(el=>['in','out','width','page'].includes(el.dataset.viewer)).forEach(el=>el.disabled=false);
    fitSource('width');
  };
  img.onerror=()=>{if(generation===reviewView.generation){placeholder.innerHTML='無法載入預覽，可重試或使用上方「開啟原始檔」。<br><button class="btn btn-sm" type="button" data-viewer="retry">重新載入原圖</button>';placeholder.hidden=false;$('#sourceStage').hidden=true;}};
  img.alt=`${doc.name}，第 ${page.number} 頁`;
  img.src=page.url;
}

function reviewFieldsHtml(doc,draft,item) {
  const meta=draft.meta;
  const supplierOptions=[['','請確認供應商'],...Object.entries(SUP).filter(([k])=>k!=='xx').map(([k,v])=>[k,v.name])];
  const units=['件','公斤','支','片','張','組','公尺'].map(v=>[v,v]);
  return `${doc.status==='error'?`<div class="net-error">${esc(doc.error)}<br>可按底部「重新辨識」，或對照原檔手動填寫。</div>`:''}
    ${draft.warnings?.length?`<details class="review-warnings" open><summary>辨識提醒（${draft.warnings.length}）</summary><ul class="warning-list">${draft.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''}
    <details class="invoice-summary" id="invoiceSummary" ${draft.items.length>1?'open':''}><summary id="invoiceSummaryTitle">整張單據摘要</summary><div id="invoiceSummaryBody"></div></details>
    <details class="review-analysis" id="reviewAnalysis" open><summary id="reviewAnalysisTitle">分析檢查</summary><div id="reviewAnalysisBody" aria-live="polite"></div></details>
    <h2 class="meta-title">單據資料</h2><div class="form-grid doc-meta">
      ${input('供應商','sup',meta.sup,{options:supplierOptions})}${input('單據日期','date',meta.date,{type:'date'})}${input('單據號碼','doc',meta.doc)}
      ${input('原單小計（未列可留白）','subtotal',meta.subtotal,{type:'number'})}${input('原單營業稅（未列可留白）','tax',meta.tax,{type:'number'})}${input('整單含稅總計（未列可留白）','total',meta.total,{type:'number'})}
      <div class="fld wide"><label for="newSupplier">新增供應商</label><div class="supplier-add"><input class="inp" id="newSupplier" placeholder="其他供應商公司全名"><button class="btn btn-sm" data-action="supplier">新增</button></div></div>
    </div>
    ${taxReviewHtml(draft)}
    <div class="line-tabs" role="group" aria-label="材料明細">${draft.items.map((_,i)=>`<button class="btn btn-sm" data-item="${i}" aria-pressed="${state.item===i}">明細 ${i+1}</button>`).join('')}<button class="btn btn-sm" data-action="add-line">＋新增明細</button><button class="btn btn-sm remove-line" data-action="remove-line" ${draft.items.length===1?'disabled':''}>移除此明細</button></div>
    <p class="review-progress" id="reviewProgress" role="status" aria-live="polite"></p>
    <div class="form-grid" id="itemForm">
      ${input('品名／材料名稱','label',item.label,{item:true})}${input('材質牌號（未註明可留白）','grade',item.grade,{item:true})}${input('原單料號（未列可留白）','part_no',item.part_no,{item:true})}
      ${input('形狀','shape',item.shape||'rect',{item:true,options:[['rect','長方體'],['round','圓條']]})}
      ${input('尺寸單位','dim_unit',item.dim_unit,{item:true,options:[['mm','mm'],['cm','cm'],['inch','inch（英吋）']]})}${(item.dims||['','','']).map((d,i)=>input(item.shape==='round'?['直徑','長度'][i]:`尺寸 ${i+1}`,'dim'+i,d,{type:'number',item:true})).join('')}
      ${input('原單數量','qty',item.qty,{type:'number',item:true})}${input('數量單位','unit',item.unit||'件',{item:true,options:units})}
      ${input('重量（公斤，可留白）','weight_kg',item.weight_kg,{type:'number',item:true})}${input('計價依據','pricing_basis',item.pricing_basis||'quantity',{item:true,options:[['quantity','按數量'],['weight','按重量（公斤）']]})}
      <div class="fld"><label><span id="priceLabel">單價（NT$／${esc(billingUnit(item))}，可留白）</span><input class="inp" data-scope="item" data-key="price" type="number" value="${esc(item.price??'')}" step="any" min="0"></label></div>
      ${input('原單材料費（NT$，可留白）','material_amount',item.material_amount,{type:'number',item:true})}${input('加工費（NT$／整筆，可留白）','processing_fee',item.processing_fee,{type:'number',item:true})}
      ${input('明細金額（NT$，可留白）','amount',item.amount,{type:'number',item:true})}${input('備註／加工條件','note',item.note,{item:true})}
    </div>
    <div class="calculation-panel"><div class="line-summary" id="calcHint" aria-live="polite"></div><button class="btn btn-sm" type="button" id="applyEstimate" data-action="apply-estimate">套用試算金額</button></div>
    <details><summary>查看這筆的辨識原文</summary><pre class="ocr-text">${esc(item.raw||'未取得可靠文字，請對照原圖填寫。')}</pre></details>
    <details><summary>查看整份單據辨識文字</summary><pre class="ocr-text">${esc(draft.text||'尚無辨識文字')}</pre></details>`;
}

function renderReviewWorkspace(doc) {
  const saved=captureReviewPosition(),sameDocument=reviewView.docId===doc?.id;
  ensureReviewShell();
  const docChanged=!sameDocument;
  reviewView.docId=doc?.id||null;
  $('#reviewName').textContent=doc?.name||'單據與資料同步核對';
  const badgeHtml=doc?`${badge(doc.status)}<span class="k">${esc(doc.engine)}</span>`:'<span class="k">上傳後可在同一個畫面核對原圖與欄位</span>';
  if($('#reviewBadge').innerHTML!==badgeHtml)$('#reviewBadge').innerHTML=badgeHtml;
  if(docChanged)$('#saveStatus').textContent=doc?'草稿已存到此瀏覽器':'';
  const busy=doc&&['queued','extracting'].includes(doc.status);
  let draft=doc?documentDraft(doc.id):null;
  if(doc&&!busy&&!draft){draft={meta:{sup:'',date:'',doc:'',subtotal:null,tax:null,total:null},items:[blankItem()],warnings:[],text:''};localDrafts.set(doc.id,draft);localDraftVersions.set(doc.id,doc.organization_version??0);}
  if(draft){state.item=Math.max(0,Math.min(state.item,draft.items.length-1));}
  const item=draft?.items[state.item];
  renderSource(doc,item);
  // A pending/done badge change must not recreate inputs or the image element.
  const awaitingList=reviewMovePending&&organizationNavigationCurrent(reviewMovePending);
  const editorKey=doc?`${doc.id}:${localDraftVersions.get(doc.id)??0}:${busy?'busy':draft?'ready':'empty'}:${busy?'':state.item}:${draft?.items.length||0}:${item?.shape||'rect'}:${doc.status==='error'?doc.error:''}`:awaitingList?'awaiting-list':'empty';
  if(reviewView.editorKey!==editorKey){
    reviewView.editorKey=editorKey;
    $('#reviewScroll').innerHTML=!doc?`<div class="empty"><b>${awaitingList?'單據已移出，等待更新清單':'目前沒有待確認單據'}</b>${awaitingList?'請重試更新清單，再接續下一張待確認材料單。':'可使用上方「切換單據」查看已確認單據，或前往<a href="#pool">待分類池</a>。'}</div>`:busy?`<div class="rv-busy">${badge(doc.status)}<p>正在瀏覽器辨識，完成後會出現待確認欄位。</p><div class="skel"></div></div>`:reviewFieldsHtml(doc,draft,item);
    restoreReviewPosition(saved,sameDocument);
  }
  if(draft&&!busy){
    for(const field of $$('#reviewScroll [data-scope=tax]')){const value=String(taxSettings(draft)[field.dataset.key]??'');if(field!==document.activeElement&&field.value!==value)field.value=value;}
    renderReviewProgress(draft);
    const select=$('#reviewScroll [data-key="sup"]');
    const options=[['','請確認供應商'],...Object.entries(SUP).filter(([k])=>k!=='xx').map(([k,v])=>[k,v.name])];
    const optionSignature=JSON.stringify(options);
    if(select&&select.dataset.options!==optionSignature){
      select.innerHTML=options.map(([k,v])=>`<option value="${esc(k)}">${esc(v)}</option>`).join('');
      select.value=draft.meta.sup||'';select.dataset.options=optionSignature;
    }
  }
  renderReviewActions(doc,busy);
  renderOrganizationNotice(doc);
  if(docChanged){$('#reviewScroll').scrollTop=0;if(!savedReviewRecovery.has(doc?.id))$('#rvErr')?.replaceChildren();}
  if(draft&&!busy)updateCalc();
  syncReviewBusy();
}

function focusReviewError(message) {
  const line=message.match(/第\s*(\d+)\s*筆/);
  const draft=documentDraft(state.qSel);
  if(line&&draft&&draft.items[+line[1]-1]&&state.item!==+line[1]-1){state.item=+line[1]-1;renderUpload(true);}
  const match=[[/供應商/,'sup','meta'],[/日期/,'date','meta'],[/尺寸單位/,'dim_unit','item'],[/計價依據/,'pricing_basis','item'],[/重量/,'weight_kg','item'],[/加工費/,'processing_fee','item'],[/材料費/,'material_amount','item'],[/計價單位/,'unit','item'],[/尺寸/,'dim0','item'],[/數量/,'qty','item'],[/單價/,'price','item'],[/明細金額/,'amount','item'],[/品名／材料名稱/,'label','item']].find(([pattern])=>pattern.test(message));
  const target=match?$$('#reviewScroll [data-key]').find(el=>el.dataset.key===match[1]&&el.dataset.scope===match[2]):null;
  if(target)requestAnimationFrame(()=>{if(target.isConnected){target.focus({preventScroll:true});target.scrollIntoView({block:'center',inline:'nearest'});}});
  if($('#rvErr'))$('#rvErr').textContent=message;
}

function changeSourcePage(direction) {
  const doc=queue.find(d=>d.id===state.qSel),draft=documentDraft(state.qSel);
  if(!doc||!draft||confirming.has(doc.id))return;
  const index=doc.pages.findIndex(p=>p.number===Number(draft.items[state.item].page));
  const page=doc.pages[Math.max(0,index)+direction];
  if(page){draft.items[state.item].page=page.number;invalidateReviewProgress(draft,'item');markDirty(doc.id);renderUpload(true);}
}

$('#toggleQueue').addEventListener('click',()=>setQueueOpen($('#intakeQueue').hidden));
$('#uploadDocument').addEventListener('click',()=>$('#file').click());
$$('[data-close-queue]').forEach(el=>el.addEventListener('click',()=>setQueueOpen(false)));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#intakeQueue').hidden){setQueueOpen(false);$('#toggleQueue').focus();}});
$('#review').addEventListener('click',e=>{
  const action=e.target.closest('[data-viewer]')?.dataset.viewer;
  if(!action)return;
  if(action==='retry'){reviewView.pageKey=null;const doc=queue.find(d=>d.id===state.qSel);renderSource(doc,documentDraft(state.qSel)?.items[state.item]);return;}
  if(action==='in'||action==='out'){reviewView.mode='manual';applySourceScale(reviewView.scale*(action==='in'?1.25:.8));}
  else if(action==='width'||action==='page')fitSource(action);
  else changeSourcePage(action==='next'?1:-1);
});
