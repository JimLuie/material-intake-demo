'use strict';
let SUP = {xx:{name:'未指定供應商',short:'未指定'}};
let records = [], queue = [];
function isMaterialDocument(doc){return !!doc&&(doc.bucket||'materials')==='materials';}
const state = {view:'search',q:'',allow:0,sel:0,sort:{key:'date',dir:-1},fSup:'all',fFam:'all',fText:'',picked:new Set(),qSel:null,item:0,rvKey:'',queueFilter:'pending',queueSearch:'',queueAnalysisOnly:false,reviewGeneration:0,reviewContext:null,tableHighlight:null};
