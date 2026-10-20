import { loadPyodide } from './vendor/pyodide/pyodide.mjs';
let pyodide, bridge, seeded=false;
let chain=Promise.resolve();
const sendProgress=message=>postMessage({type:'progress',message});
function sync(populate=false){return new Promise((resolve,reject)=>pyodide.FS.syncfs(populate,e=>e?reject(e):resolve()));}
function call(name,...args){
  const fn=pyodide.globals.get(name);
  try{return fn(...args);}finally{fn.destroy();}
}
function asJS(value){
  if(value?.toJs){try{return value.toJs({dict_converter:Object.fromEntries});}finally{value.destroy();}}
  return value;
}
async function bytes(url){const r=await fetch(url);if(!r.ok)throw Error('載入示範檔案失敗：'+url);return new Uint8Array(await r.arrayBuffer());}
async function seed(){
  const spec=await (await fetch('./demo-seed.json')).json();
  let n=0;
  for(const doc of spec.documents){
    sendProgress(`準備虛構單據 ${++n} / ${spec.documents.length}`);
    const original=await bytes(doc.original);
    const pages=await Promise.all(doc.pages.map(p=>bytes(p.url)));
    const pOriginal=pyodide.toPy(original),pPages=pyodide.toPy(pages);
    try{call('seed_one',JSON.stringify(doc),pOriginal,pPages);}finally{pOriginal.destroy();pPages.destroy();}
  }
  call('finish_seed',JSON.stringify(spec));
}
async function initialize(){
  sendProgress('載入瀏覽器資料引擎…');
  pyodide=await loadPyodide({indexURL:new URL('./vendor/pyodide/',import.meta.url).href});
  const bundle=await bytes('./core.zip');pyodide.unpackArchive(bundle,'zip',{extractDir:'/app'});
  pyodide.FS.mkdirTree('/demo-data');pyodide.FS.mount(pyodide.FS.filesystems.IDBFS,{},'/demo-data');
  await sync(true);
  await pyodide.runPythonAsync("import sys;sys.path.insert(0,'/app')\nfrom browser_bridge import *");
  seeded=call('init_store');
  if(!seeded){await seed();await sync();}
  sendProgress('示範資料已就緒');
}
async function request(msg){
  if(msg.type==='init'){await initialize();return {ready:true};}
  if(!pyodide)throw Error('資料引擎尚未就緒');
  if(msg.type==='reset'){
    const rollback=call('snapshot_request','/internal/restore');
    try{call('reset_store');await seed();await sync();return {ok:true};}
    catch(error){call('rollback_request',rollback);throw error;}
    finally{rollback.destroy();}
  }
  const rollback=msg.method==='POST'?call('snapshot_request',msg.path,JSON.stringify(msg.body??{})):null;
  const data=msg.binary?pyodide.toPy(new Uint8Array(msg.binary)):null;
  let result;
  try{result=asJS(call('dispatch',msg.method||'GET',msg.path,JSON.stringify(msg.body??{}),JSON.stringify(msg.headers??{}),data));}
  catch(error){if(rollback)call('rollback_request',rollback);rollback?.destroy();throw error;}
  finally{data?.destroy();}
  if(msg.method==='POST'&&result.status<400){
    try{await sync();}
    catch(e){call('rollback_request',rollback);rollback?.destroy();throw Error('尚未保存到瀏覽器儲存空間。請保留此頁、釋放空間後重試：'+e.message);}
  }
  rollback?.destroy();
  // A failed flush can be retried with any subsequent request; do not report success first.
  return result;
}
self.onmessage=event=>{
  const msg=event.data;
  chain=chain.catch(()=>{}).then(async()=>{
    try{const result=await request(msg);postMessage({id:msg.id,result});}
    catch(error){postMessage({id:msg.id,error:error.message||String(error)});}
  });
};
