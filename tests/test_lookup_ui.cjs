'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function lookup(){
  const nodes=new Map(),get=s=>{if(!nodes.has(s))nodes.set(s,{innerHTML:'',hidden:false,attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},contains(){return false;},focus(){},addEventListener(){}});return nodes.get(s);};
  const document={querySelector:get,querySelectorAll:()=>[],addEventListener(){}};
  const ctx=vm.createContext({document,URLSearchParams,setTimeout,clearTimeout,toast(){}});
  for(const name of ['state.js','billing.js','ui.js','search.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public',name),'utf8'),ctx);
  return {run:s=>vm.runInContext(s,ctx),get};
}
test('empty or complete dimensions work; partial and invalid dimensions never become an unrestricted request',()=>{
  const ui=lookup();assert.equal(ui.run('lookupRequest().error'),'');
  ui.run("lookupState.dims.rect=['7','','80']");assert.match(ui.run('lookupRequest().error'),/三個尺寸/);
  ui.run("lookupState.dims.rect=['7','16','80']");assert.equal(ui.run("lookupRequest().params.get('dims')"),'7,16,80');
  ui.run("lookupState.dims.rect=['NaN','16','80']");assert.match(ui.run('lookupRequest().error'),/大於 0/);
});
test('unselected material text cannot broaden the search and exact selections remain exact',()=>{
  const ui=lookup();ui.run("lookupState.gradeText='70'");assert.match(ui.run('lookupRequest().error'),/選擇材質/);
  ui.run("lookupState.gradeText='CUSTOM-9';lookupState.grade='CUSTOM-9'");
  assert.equal(ui.run('lookupRequest().error'),'');assert.equal(ui.run("lookupRequest().params.get('grade')"),'CUSTOM-9');
  ui.run("lookupState.grade='';lookupState.missing=true;lookupState.gradeText='材質未列'");
  assert.equal(ui.run("lookupRequest().params.get('missing_grade')"),'1');
});
test('round parameters preserve diameter then length, and text mode sends no structured filters',()=>{
  const ui=lookup();ui.run("lookupState.shape='round';lookupState.dims.round=['70','107']");
  assert.equal(ui.run("lookupRequest().params.get('dims')"),'70,107');
  ui.run("lookupState.mode='text';state.q='1150112N0081'");
  assert.equal(ui.run("lookupRequest().params.get('q')"),'1150112N0081');assert.equal(ui.run("lookupRequest().params.has('shape')"),false);
});
test('material options come from server catalog, filter by text and category, and retain typed text across refresh',()=>{
  const ui=lookup();
  assert.equal(ui.run('materialOptions().length'),1);
  ui.run(`updateMaterialCatalog({grades:[{grade:'7075',metal:'aluminum',count:2},{grade:'S50C',metal:'steel',count:3},{grade:'CUSTOM-9',metal:'other',count:1}],metals:[{id:'aluminum',label:'鋁'},{id:'steel',label:'鋼'},{id:'other',label:'其他／未分類'}],missing_count:1});lookupState.gradeText='70';lookupState.open=true;renderMaterialOptions()`);
  assert.equal(ui.run('materialOptions()[0].grade'),'7075');assert.equal(ui.run('materialOptions().length'),1);
  ui.run("lookupState.metal='steel'");assert.equal(ui.run('materialOptions().length'),0);
  ui.run("lookupState.metal='all';updateMaterialCatalog({grades:[{grade:'7075',metal:'aluminum',count:3}],metals:[{id:'aluminum',label:'鋁'}],missing_count:0})");
  assert.equal(ui.run('lookupState.gradeText'),'70');assert.equal(ui.run('lookupState.open'),true);
  assert.equal(ui.get('#materialSearch').attrs['aria-activedescendant'],'materialOption0');
});
test('reopening a selected grade keeps the highlighted choice rather than silently switching to any material',()=>{
  const ui=lookup();
  ui.run("lookupState.catalog={grades:[{grade:'6061',metal:'aluminum',count:1},{grade:'7075',metal:'aluminum',count:2}],metals:[],missing_count:0};lookupState.grade='7075';lookupState.gradeText='7075';setMaterialOpen(true);renderMaterialOptions()");
  assert.equal(ui.run('materialOptions()[lookupState.active].grade'),'7075');
  assert.equal(ui.get('#materialSearch').attrs['aria-expanded'],'true');
  ui.run('setMaterialOpen(false)');assert.equal(ui.get('#materialSearch').attrs['aria-activedescendant'],undefined);
});
