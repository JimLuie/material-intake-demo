'use strict';

let analysisReturnPending=null,analysisReviewOpenSeq=0;
function aCaptureContext(id){
  const row=analysisState.result?.observations.find(r=>r.id===id);if(!row)return null;
  const rows=aVisibleRows(),index=rows.findIndex(r=>r.id===id),viewport=$('#aTableScroll');
  return {kind:'analysis',documentId:row.document_id,recordId:id,position:row.position,page:row.page||1,
    order:rows.slice(index+1).filter(r=>r.review_status==='needs_review').map(r=>({id:r.id,document_id:r.document_id,position:r.position,page:r.page||1})),
    visited:[],filters:aFormObject($('#aFilters')),requestFilters:structuredClone(analysisState.appliedFilters||aFilters()),
    fixed:structuredClone(analysisState.fixed),view:analysisState.view,listStatus:analysisState.listStatus,category:analysisState.category,categoryName:analysisState.categoryName,
    scroll:window.scrollY,tableTop:viewport.scrollTop,tableLeft:viewport.scrollLeft};
}
function aReviewTarget(row){
  const doc=queue.find(d=>d.id===row.document_id),draft=doc&&documentDraft(doc.id);
  if(!doc||!Number.isInteger(row.position)||!draft?.items[row.position])throw Error('找不到對應文件與明細，請重新載入分析後核對。');
  if(Number(draft.items[row.position].page||1)!==Number(row.page||1))throw Error('目前草稿頁次已變動，請先在上傳單據核對並確認，再重新載入分析。');
  return {doc,item:row.position};
}
async function aOpenReview(id){
  const row=analysisState.result?.observations.find(r=>r.id===id);if(!row)return;
  const request=++analysisReviewOpenSeq,generation=state.reviewGeneration,view=state.view,context=aCaptureContext(id);
  if(state.qSel)await flushDraft(state.qSel);
  if(request!==analysisReviewOpenSeq||state.reviewGeneration!==generation||state.view!==view)return;
  aSelectProblem(row,context);
}
function aSelectProblem(row,context){
  if(!row.document_id){aOpenQuote(row.id).catch(error=>aError(error.message));return;}
  const target=aReviewTarget(row);
  const nextContext={...context,documentId:row.document_id,recordId:row.id,position:row.position,page:row.page||1};
  closeDrawer();selectReviewDocument(target.doc.id,target.item,nextContext);location.hash='upload';go('upload');
  const issue=row.primary_issue;
  if(issue?.key)focusSummaryIssue({item:row.position,key:issue.key,scope:issue.scope});
  if(target.doc.status!=='done')toast('已定位目前草稿對應明細；請對照原圖並確認整張單據。');
}
async function aRefreshReview(context){
  const result=await api('/api/analysis?filter='+encodeURIComponent(JSON.stringify(context.requestFilters)));
  if(!result.review_lookup||!result.review)throw Error('未取得最新分析檢查結果，請重試更新分析。');
  return result;
}
function aNextProblem(context,result,wholeDocument=false){
  const visited=new Set([...context.visited,context.recordId]);
  const documents=new Set([...(context.visitedDocuments||[]),...(wholeDocument?[context.documentId]:[])]);
  const remaining=context.order.filter(r=>!visited.has(r.id)).map(r=>result.review_lookup[r.id]).filter(r=>r?.review_status==='needs_review'&&!documents.has(r.document_id));
  return (!wholeDocument&&remaining.find(r=>r.document_id===context.documentId))||remaining[0]||null;
}
function aFinishReview(context,result,wholeDocument=false){
  const next=aNextProblem(context,result,wholeDocument);
  if(!next){aReturnToAnalysis(context,'本次清單後續問題已核對完成；尚未解決的項目仍保留在問題清單。');return;}
  const following={...context,visited:[...context.visited,context.recordId],visitedDocuments:[...(context.visitedDocuments||[]),...(wholeDocument?[context.documentId]:[])]};
  if(next.primary_issue?.code==='stale_supplement'){
    // Supplements remain bound to confirmed source fingerprints.
    analysisState.result=result;aReturnToAnalysis(following,'下一筆需重新確認分析補充。',()=>
      aOpenNote(next.id,{...following,documentId:next.document_id,recordId:next.id,position:next.position,page:next.page||1}));
  }else{
    try{aSelectProblem(next,following);toast('已保存並取得最新分析，已定位下一筆問題。');}
    catch(error){toast('本筆已保存；下一筆無法安全定位：'+error.message);}
  }
}
function aReturnToAnalysis(context,message='已返回分析',afterRestore=null){
  for(const [name,value]of Object.entries(context.filters)){const field=$('#aFilters').elements.namedItem(name);if(field)field.value=value;}
  Object.assign(analysisState,{tab:'compare',fixed:structuredClone(context.fixed),view:context.view,listStatus:context.listStatus,category:context.category,categoryName:context.categoryName});
  $$('[data-a-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.aTab==='compare')));
  $('#aCompare').hidden=false;$('#aQuotes').hidden=true;$('#aSettings').hidden=true;
  $$('[data-a-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.aView===context.view)));
  $('#aFixed').hidden=context.view!=='fixed';
  analysisReturnPending={...context,afterRestore};state.reviewContext=null;closeDrawer();
  if(location.hash==='#analysis')go('analysis');else location.hash='analysis';
  toast(message);
}
function aRestoreReturn(){
  const context=analysisReturnPending;if(!context||state.view!=='analysis')return;
  analysisReturnPending=null;
  const generation=state.reviewGeneration;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(state.view!=='analysis'||state.reviewGeneration!==generation)return;
    window.scrollTo(0,context.scroll);const table=$('#aTableScroll');table.scrollTop=context.tableTop;table.scrollLeft=context.tableLeft;
    const button=$$('#aRows [data-a-review]').find(b=>b.dataset.aReview===context.recordId);button?.focus({preventScroll:true});
    context.afterRestore?.();
  }));
}
function aBindNote(row,context){
  const form=$('#aNoteForm'),generation=state.reviewGeneration,view=state.view,button=$('button[type=submit]',form),error=$('#aNoteError');
  let saved=false,busy=false;
  const current=()=>$('#aNoteForm')===form&&state.reviewGeneration===generation&&state.view===view;
  form.addEventListener('input',()=>{if(saved&&!busy){saved=false;button.textContent=context?'確認並下一筆問題':'保存分析補充';}});
  $('[data-note-return]',form)?.addEventListener('click',()=>{if(!busy)aReturnToAnalysis(context,'已返回分析；未保存的補充未套用。');});
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(busy)return;busy=true;button.disabled=true;
    const fields=[...form.elements].filter(el=>el!==button),disabled=fields.map(el=>el.disabled);fields.forEach(el=>el.disabled=true);
    try{
      if(!saved){
        // FormData excludes disabled fields, so temporarily restore them for the snapshot.
        fields.forEach((el,i)=>el.disabled=disabled[i]);const data=aFormObject(form);fields.forEach(el=>el.disabled=true);
        await api('/api/analysis/notes/'+encodeURIComponent(row.id),{method:'POST',body:JSON.stringify({...data,fingerprint:row.fingerprint})});saved=true;
      }
      await refresh(true,{strict:true});
      const result=await aRefreshReview(context||{requestFilters:analysisState.appliedFilters||aFilters()});
      if(!current())return;
      closeDrawer();
      if(context)aFinishReview(context,result);
      else{analysisState.result=result;aRenderStats();aRenderChart();aRenderRows();toast('已保存分析補充，原單金額維持原值');}
    }catch(err){
      if(current()){error.textContent=saved?'分析補充已保存，但最新分析取得失敗。請按「重試更新分析」，不必重複保存。 '+err.message:err.message;if(saved)button.textContent='重試更新分析';}
    }finally{busy=false;fields.forEach((el,i)=>el.disabled=disabled[i]);button.disabled=false;}
  });
}
