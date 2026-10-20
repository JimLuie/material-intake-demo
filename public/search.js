'use strict';

// Query inputs are presentation state; catalog entries come only from confirmed server records.
const lookupState={mode:'structured',shape:'rect',dims:{rect:['','',''],round:['','']},metal:'all',
  grade:'',missing:false,gradeText:'',open:false,active:-1,catalog:{grades:[],metals:[],missing_count:0},catalogKey:''};
const metalLabel=key=>({aluminum:'鋁',steel:'鋼',other:'其他／未分類'})[key]||'不限';
const selectedMaterialText=()=>lookupState.missing?'材質未列':lookupState.grade;

function lookupRequest(){
  if(lookupState.mode==='text')return {params:new URLSearchParams({q:state.q,allow:String(state.allow)}),error:''};
  const s=lookupState,values=s.dims[s.shape],entered=values.map(v=>String(v).trim());
  const query={shape:s.shape,dims:entered.every(v=>v!==''&&Number.isFinite(Number(v))&&Number(v)>0)?entered.map(Number):null,
    grade:s.grade,missing_grade:s.missing,metal:s.metal};
  let error='';
  if(entered.some(Boolean)&&!entered.every(Boolean))error=s.shape==='round'?'請填妥直徑與長度，或全部留白。':'請填妥三個尺寸，或全部留白。';
  else if(entered.some(v=>v!==''&&(!Number.isFinite(Number(v))||Number(v)<=0)))error='尺寸必須是大於 0 的數字。';
  else if(s.gradeText.trim()!==selectedMaterialText())error='請從選單選擇材質，或清除文字以不限材質查詢。';
  const params=new URLSearchParams({mode:'structured',shape:s.shape,metal:s.metal,allow:String(state.allow)});
  if(entered.some(Boolean))params.set('dims',entered.join(','));
  if(s.grade)params.set('grade',s.grade);
  if(s.missing)params.set('missing_grade','1');
  return {params,error,query};
}
function scheduleLookup(immediate=false){
  state.sel=0;clearTimeout(searchTimer);
  if(immediate)renderSearch();else searchTimer=setTimeout(renderSearch,160);
}
function focusLookup(){(lookupState.mode==='text'?$('#q'):$('#searchDim0')).focus();}
function setMaterialOpen(open){
  if(open&&!lookupState.open&&selectedMaterialText()){
    const selected=materialOptions().findIndex(o=>o.label===selectedMaterialText());
    if(selected>=0)lookupState.active=selected;
  }
  lookupState.open=open;
  $('#materialList').hidden=!open;
  $('#materialSearch').setAttribute('aria-expanded',String(open));
  $('#toggleMaterials').setAttribute('aria-expanded',String(open));
  $('#toggleMaterials').setAttribute('aria-label',open?'收合材質選單':'展開材質選單');
  if(!open)$('#materialSearch').removeAttribute('aria-activedescendant');
}
function materialOptions(){
  const s=lookupState,term=normalize(s.gradeText).trim().toUpperCase();
  const all=[{grade:'',label:'不限材質',metal:'all',count:null},
    ...s.catalog.grades.filter(g=>s.metal==='all'||g.metal===s.metal).map(g=>({...g,label:g.grade})),
    ...(s.catalog.missing_count>0&&['all','other'].includes(s.metal)?[{grade:'',missing:true,label:'材質未列',metal:'other',count:s.catalog.missing_count}]:[])];
  // Reopening a chosen material shows all choices, while editing text filters the list.
  return all.filter(o=>!term||s.gradeText===selectedMaterialText()||o.label.toUpperCase().includes(term));
}
function renderMaterialOptions(){
  const s=lookupState,options=materialOptions(),input=$('#materialSearch');
  s.active=options.length?Math.max(0,Math.min(s.active,options.length-1)):-1;
  const html=options.map((o,i)=>`<li id="materialOption${i}" role="option" aria-selected="${i===s.active}" data-material-index="${i}" class="${i===s.active?'is-highlighted':''}"><span>${esc(o.label)}</span>${o.count!=null?`<small>${o.count} 筆</small>`:''}</li>`).join('')||'<li role="presentation" class="material-empty">沒有符合的材質，請調整文字或分類。</li>';
  if($('#materialList').innerHTML!==html)$('#materialList').innerHTML=html;
  if(s.open&&s.active>=0)input.setAttribute('aria-activedescendant','materialOption'+s.active);
  else input.removeAttribute('aria-activedescendant');
  $('#clearMaterial').hidden=!s.gradeText;
}
function chooseMaterial(index){
  const option=materialOptions()[index];if(!option)return;
  lookupState.grade=option.grade;lookupState.missing=!!option.missing;
  lookupState.gradeText=selectedMaterialText();$('#materialSearch').value=lookupState.gradeText;
  setMaterialOpen(false);renderMaterialOptions();$('#materialSearch').focus();scheduleLookup(true);
}
function renderMetalFilters(){
  const s=lookupState,options=[{id:'all',label:'全部'},...s.catalog.metals];
  const html=options.map(o=>`<button type="button" class="chip" data-metal="${esc(o.id)}" aria-pressed="${s.metal===o.id}">${esc(o.label)}</button>`).join('');
  if($('#metalFilters').innerHTML!==html){
    const focused=$('#metalFilters').contains(document.activeElement)?document.activeElement.dataset.metal:null;
    $('#metalFilters').innerHTML=html;
    if(focused)($('#metalFilters [data-metal="'+focused+'"]')||$('#metalFilters [data-metal="all"]')).focus({preventScroll:true});
  }
}
function updateMaterialCatalog(catalog){
  if(!catalog)return false;
  const key=JSON.stringify(catalog);if(lookupState.catalogKey===key)return false;
  lookupState.catalog=catalog;lookupState.catalogKey=key;
  if(lookupState.metal!=='all'&&!catalog.metals.some(m=>m.id===lookupState.metal)){
    lookupState.metal='all';toast('原分類已無資料，已改為全部；已填條件保留。');
  }
  renderMetalFilters();renderMaterialOptions();return true;
}
function renderSearchDimensions(){
  const s=lookupState,round=s.shape==='round';
  $('#searchDimThird').hidden=round;$('#searchDim2').disabled=round;
  $('#searchDimensions').classList.toggle('is-round',round);
  [0,1,2].forEach(i=>{
    $('#dimLabel'+i).textContent=round?['直徑','長度',''][i]:'尺寸 '+(i+1);
    $('#searchDim'+i).value=s.dims[s.shape][i]||'';
  });
  $('#dimensionHint').textContent=round?'直徑與長度固定順序，按 Tab 換格；不必輸入 Ø。':'三個尺寸可任意換序，按 Tab 換格；全部留白可只查材質。';
  $$('#searchShape [data-shape]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.shape===s.shape)));
}
function initLookup(){
  $('#lookupForm').addEventListener('submit',e=>{e.preventDefault();setMaterialOpen(false);scheduleLookup(true);});
  $('#searchDimensions').addEventListener('input',e=>{
    const field=e.target.closest('[data-search-dim]');if(!field)return;
    lookupState.dims[lookupState.shape][+field.dataset.searchDim]=field.validity.badInput?'invalid':field.value;
    scheduleLookup();
  });
  $('#searchShape').addEventListener('click',e=>{const b=e.target.closest('[data-shape]');if(b){lookupState.shape=b.dataset.shape;renderSearchDimensions();scheduleLookup(true);}});
  $('#metalFilters').addEventListener('click',e=>{
    const b=e.target.closest('[data-metal]');if(!b)return;
    const s=lookupState;s.metal=b.dataset.metal;
    const selected=s.missing?'other':s.catalog.grades.find(g=>g.grade===s.grade)?.metal;
    if(s.metal!=='all'&&selected&&selected!==s.metal){
      s.grade='';s.missing=false;s.gradeText='';$('#materialSearch').value='';
      toast('已清除不屬於此分類的材質，請重新選取。');
    }
    s.active=0;renderMetalFilters();renderMaterialOptions();setMaterialOpen(false);scheduleLookup(true);
  });
  const input=$('#materialSearch');
  input.addEventListener('click',()=>{setMaterialOpen(true);renderMaterialOptions();});
  input.addEventListener('input',()=>{
    const s=lookupState;s.gradeText=input.value;s.grade='';s.missing=false;s.active=0;
    setMaterialOpen(true);renderMaterialOptions();scheduleLookup();
  });
  input.addEventListener('keydown',e=>{
    const s=lookupState;
    if(['ArrowDown','ArrowUp'].includes(e.key)){
      e.preventDefault();const wasOpen=s.open;setMaterialOpen(true);
      const count=materialOptions().length;
      s.active=count?(wasOpen?(s.active+(e.key==='ArrowDown'?1:-1)+count)%count:e.key==='ArrowDown'?0:count-1):-1;
      renderMaterialOptions();if(s.active>=0)$('#materialOption'+s.active).scrollIntoView({block:'nearest'});
    }else if(e.key==='Enter'&&s.open){
      e.preventDefault();if(s.active>=0)chooseMaterial(s.active);else scheduleLookup(true);
    }else if(e.key==='Escape'){e.preventDefault();setMaterialOpen(false);}
    else if(e.key==='Tab')setMaterialOpen(false);
  });
  $('#toggleMaterials').addEventListener('click',()=>{const open=!lookupState.open;input.focus();setMaterialOpen(open);renderMaterialOptions();});
  $('#materialList').addEventListener('mousedown',e=>e.preventDefault());
  $('#materialList').addEventListener('click',e=>{const option=e.target.closest('[data-material-index]');if(option)chooseMaterial(+option.dataset.materialIndex);});
  $('#clearMaterial').addEventListener('click',()=>{
    lookupState.grade='';lookupState.missing=false;lookupState.gradeText='';input.value='';
    setMaterialOpen(false);renderMaterialOptions();input.focus();scheduleLookup(true);
  });
  document.addEventListener('click',e=>{if(!$('#materialPicker').contains(e.target))setMaterialOpen(false);});
  $$('[data-search-mode]').forEach(button=>button.addEventListener('click',()=>{
    lookupState.mode=button.dataset.searchMode;
    $$('[data-search-mode]').forEach(b=>{b.setAttribute('aria-pressed',String(b===button));b.classList.toggle('is-active',b===button);});
    $('#lookupForm').hidden=lookupState.mode!=='structured';$('#qForm').hidden=lookupState.mode!=='text';
    setMaterialOpen(false);focusLookup();scheduleLookup(true);
  }));
  $('#clearLookup').addEventListener('click',()=>{
    lookupState.shape='rect';lookupState.dims={rect:['','',''],round:['','']};lookupState.metal='all';lookupState.grade='';lookupState.missing=false;lookupState.gradeText='';
    input.value='';state.allow=0;$$('#allowSeg [data-allow]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.allow==='0')));
    renderSearchDimensions();renderMetalFilters();setMaterialOpen(false);renderMaterialOptions();focusLookup();scheduleLookup(true);
  });
  $('#q').addEventListener('input',e=>{state.q=e.target.value;scheduleLookup();});
  $('#qForm').addEventListener('submit',e=>{e.preventDefault();state.q=$('#q').value;scheduleLookup(true);});
  renderSearchDimensions();renderMaterialOptions();
}
