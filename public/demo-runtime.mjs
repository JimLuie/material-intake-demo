// Documents and ledger data never leave this browser. Only public market GETs use a server.
import {observations} from './ocr-geometry.mjs';
let worker, serial=0, ready=false, lockRelease, activeOCR=false;
const pending=new Map(), blobs=new Map(), queued=new Set();
let ocrChain=Promise.resolve(),ocrWorker,pdfLib,heifLib;
const status=message=>{for(const el of document.querySelectorAll('#demoTaskStatus,#demoMobileTaskStatus'))el.textContent=message;};
const progress=message=>{const el=document.querySelector('#startupMessage');if(el)el.textContent=message;};
function rpc(message){
  return new Promise((resolve,reject)=>{
    const id=++serial;pending.set(id,{resolve,reject});worker.postMessage({...message,id});
  });
}
async function exclusiveLock(){
  if(!navigator.locks)throw Error('此瀏覽器不支援安全的分頁儲存鎖，請使用最新版 Chrome、Edge 或 Safari。');
  await new Promise((resolve,reject)=>{
    navigator.locks.request('material-intake-demo-writer',{ifAvailable:true},async lock=>{
      if(!lock){reject(Error('此瀏覽器已有另一個 Demo 分頁。請先關閉該分頁，再按重新載入，避免資料互相覆寫。'));return;}
      resolve();await new Promise(r=>{lockRelease=r;});
    }).catch(reject);
  });
}
async function request(path,options={},bodyOverride){
  let body=bodyOverride??{},binary;
  if(options.body instanceof Blob)binary=await options.body.arrayBuffer();
  else if(options.body instanceof ArrayBuffer)binary=options.body;
  else if(ArrayBuffer.isView(options.body))binary=options.body.buffer.slice(options.body.byteOffset,options.body.byteOffset+options.body.byteLength);
  else if(typeof options.body==='string')body=JSON.parse(options.body);
  const result=await rpc({path,method:options.method||'GET',headers:options.headers||{},body,binary});
  if(result.status>=400){const error=Error(result.data?.error||'資料處理失敗');error.status=result.status;throw error;}
  return result;
}
async function fileURL(path,version=''){
  const key=path+'@'+version;
  if(blobs.has(key))return blobs.get(key);
  const result=await request(path),url=URL.createObjectURL(new Blob([result.bytes],{type:result.mime}));
  blobs.set(key,url);return url;
}
async function hydrate(value,versions={}){
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value)){await Promise.all(value.map(v=>hydrate(v,versions)));return value;}
  for(const [key,v] of Object.entries(value)){
    if(typeof v==='string'&&v.startsWith('/files/')||typeof v==='string'&&v.startsWith('/quote-files/'))value[key]=await fileURL(v,versions[v]||'');
    else if(v&&typeof v==='object')await hydrate(v,versions);
  }
  return value;
}
let latestVersions={};
async function api(path,options={}){
  if(!ready)throw Error('資料引擎尚未就緒，請稍候');
  if(path==='/api/market/update')return updateMarket();
  const result=await request(path,options),data=result.data;
  if(data?._file_versions)latestVersions=data._file_versions;
  await hydrate(data,latestVersions);
  if(options.method==='POST'&&(path.startsWith('/api/upload')||path.endsWith('/retry')))scheduleOCR(data.id||path.split('/')[3]);
  return data;
}
async function start(){
  await exclusiveLock();
  worker=new Worker(new URL('./ledger-worker.mjs',import.meta.url),{type:'module'});
  worker.onmessage=event=>{
    if(event.data.type==='progress'){progress(event.data.message);return;}
    const p=pending.get(event.data.id);if(!p)return;pending.delete(event.data.id);
    event.data.error?p.reject(Error(event.data.error)):p.resolve(event.data.result);
  };
  worker.onerror=event=>{for(const p of pending.values())p.reject(Error('資料引擎中斷，請保留畫面並重新載入。'));pending.clear();};
  await rpc({type:'init'});ready=true;
  const state=(await request('/api/state')).data;
  for(const d of state.documents)if(['queued','extracting'].includes(d.status))scheduleOCR(d.id);
  status('文件僅保存在此瀏覽器');
}
async function download(path){
  const r=await request(path);if(!r.bytes)throw Error('下載內容不完整');
  const url=URL.createObjectURL(new Blob([r.bytes],{type:r.mime}));
  const a=document.createElement('a');a.href=url;a.download=r.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(Error('無法載入檔案解碼器'));document.head.append(s);});}
async function pdf(){
  if(!pdfLib){pdfLib=await import('./vendor/pdfjs/pdf.mjs');pdfLib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.mjs',import.meta.url).href;}
  return pdfLib;
}
function canvasFor(width,height){
  if(width*height>100_000_000)throw Error('影像尺寸過大，請先縮小圖片後重試');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;
}
function resize(canvas){
  if(Math.max(canvas.width,canvas.height)<=3600)return canvas;
  const k=3600/Math.max(canvas.width,canvas.height),out=canvasFor(Math.round(canvas.width*k),Math.round(canvas.height*k));out.getContext('2d').drawImage(canvas,0,0,out.width,out.height);return out;
}
async function* pagesFrom(bytes,name){
  if(/\.pdf$/i.test(name)){
    const lib=await pdf(),doc=await lib.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,enableScripting:false,cMapUrl:'./vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'./vendor/pdfjs/standard_fonts/',wasmUrl:'./vendor/pdfjs/wasm/'}).promise;
    try{
      if(doc.numPages>20)throw Error('PDF 最多支援 20 頁');
      for(let i=1;i<=doc.numPages;i++){
        const page=await doc.getPage(i),v=page.getViewport({scale:1}),scale=Math.min(3,3600/Math.max(v.width,v.height)),viewport=page.getViewport({scale});
        const canvas=canvasFor(Math.ceil(viewport.width),Math.ceil(viewport.height));
        await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;yield canvas;page.cleanup();
      }
    }finally{await doc.loadingTask.destroy();}
  }else if(/\.(heic|heif)$/i.test(name)){
    if(!heifLib){const m=await import('./vendor/libheif/libheif-bundle.mjs');heifLib=await m.default();}
    const decoder=new heifLib.HeifDecoder(),images=decoder.decode(new Uint8Array(bytes));
    if(!images.length)throw Error('無法解碼此 HEIC 影像');
    const image=images[0],canvas=canvasFor(image.get_width(),image.get_height()),ctx=canvas.getContext('2d'),data=ctx.createImageData(canvas.width,canvas.height);
    await new Promise((resolve,reject)=>image.display(data,d=>d?resolve():reject(Error('HEIC 轉換失敗'))));ctx.putImageData(data,0,0);yield resize(canvas);
    images.forEach(image=>image.free?.());
  }else if(/\.(tif|tiff)$/i.test(name)){
    if(!globalThis.UTIF){await loadScript('./vendor/utif/pako.min.js');await loadScript('./vendor/utif/UTIF.js');}
    const ifds=UTIF.decode(bytes);if(!ifds.length)throw Error('TIFF 影像無法解碼');
    UTIF.decodeImage(bytes,ifds[0]);const im=ifds[0],canvas=canvasFor(im.width,im.height);canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(im)),im.width,im.height),0,0);yield resize(canvas);
  }else{
    const url=URL.createObjectURL(new Blob([bytes])),image=new Image();
    try{image.src=url;await image.decode();const canvas=canvasFor(image.naturalWidth,image.naturalHeight);canvas.getContext('2d').drawImage(image,0,0);yield resize(canvas);}finally{URL.revokeObjectURL(url);}
  }
}
function jpeg(canvas){return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('無法產生預覽圖')),'image/jpeg',.90));}
function contrast(canvas){
  const out=canvasFor(canvas.width,canvas.height),ctx=out.getContext('2d');ctx.drawImage(canvas,0,0);const image=ctx.getImageData(0,0,out.width,out.height);
  for(let i=0;i<image.data.length;i+=4){const n=Math.max(0,Math.min(255,(image.data[i]-128)*1.4+128));image.data[i]=image.data[i+1]=image.data[i+2]=n;}
  ctx.putImageData(image,0,0);return out;
}
async function tesseract(){
  if(!ocrWorker){
    const {default:Tesseract}=await import('./vendor/tesseract/tesseract.esm.min.js');
    const {createWorker}=Tesseract;
    ocrWorker=await createWorker(['chi_tra','eng'],1,{workerPath:new URL('./vendor/tesseract/worker.min.js',import.meta.url).href,corePath:new URL('./vendor/tesseract-core/',import.meta.url).href,langPath:new URL('./vendor/tessdata/',import.meta.url).href,logger:m=>{if(m.status==='recognizing text')status(`辨識單據中 ${Math.round(m.progress*100)}%`);}});
    await ocrWorker.setParameters({tessedit_pageseg_mode:'3',preserve_interword_spaces:'1',user_defined_dpi:'300'});
  }
  return ocrWorker;
}
function scheduleOCR(id){
  if(!id||queued.has(id))return;queued.add(id);
  ocrChain=ocrChain.catch(()=>{}).then(async()=>{
    activeOCR=true;
    try{
      const state=(await request('/api/state')).data,doc=state.documents.find(d=>d.id===id);
      if(!doc||!['queued','extracting'].includes(doc.status))return;
      await request('/internal/ocr-start',{method:'POST'}, {id});status('準備單據與辨識模型…');
      const source=await request(doc.original_url),pages=[];let number=0;
      for await(const canvas of pagesFrom(source.bytes.buffer.slice(source.bytes.byteOffset,source.bytes.byteOffset+source.bytes.byteLength),doc.name)){
        const engine=await tesseract();number++;
        status('辨識第 '+number+' 頁…');const original=await engine.recognize(canvas,{}, {blocks:true});
        let lines=observations(original.data,canvas.width,canvas.height);
        const enhanced=contrast(canvas),second=await engine.recognize(enhanced,{}, {blocks:true});
        for(const l of observations(second.data,canvas.width,canvas.height))if(!lines.some(p=>p.text===l.text&&Math.abs(p.x-l.x)<.012&&Math.abs(p.y-l.y)<.007))lines.push(l);
        await request('/internal/preview',{method:'POST',body:await jpeg(canvas)},{id,page:number});
        pages.push({number,width:canvas.width,height:canvas.height,preview:'page-'+number+'.jpg',lines});
        canvas.width=canvas.height=enhanced.width=enhanced.height=1;
      }
      await request('/internal/ocr-result',{method:'POST'},{id,ocr:{engine:'Tesseract.js · 瀏覽器辨識',pages}});status('辨識完成，請對照原圖核對');
    }catch(error){
      status('辨識未完成：'+error.message);
      try{await request('/internal/ocr-result',{method:'POST'},{id,error:error.message});}catch{}
    }finally{queued.delete(id);activeOCR=false;globalThis.dispatchEvent(new Event('demo-data-changed'));}
  });
}
async function publicFetch(source){
  const response=await fetch('/api/public-market?source='+source);if(!response.ok)throw Error((await response.json()).error||'公開來源暫時無法取得');
  return {bytes:new Uint8Array(await response.arrayBuffer()),url:response.headers.get('X-Source-URL')||''};
}
async function marketPdf(bytes){
  const lib=await pdf(),doc=await lib.getDocument({data:bytes,isEvalSupported:false,enableScripting:false,cMapUrl:'./vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'./vendor/pdfjs/standard_fonts/',wasmUrl:'./vendor/pdfjs/wasm/'}).promise,pages=[];
  try{for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i),content=await page.getTextContent(),rows=[];
    for(const item of content.items){if(!item.str)continue;const y=item.transform[5],row=rows.find(r=>Math.abs(r.y-y)<2);if(row)row.items.push(item);else rows.push({y,items:[item]});}
    rows.sort((a,b)=>b.y-a.y);pages.push({number:i,text:rows.map(r=>r.items.sort((a,b)=>a.transform[4]-b.transform[4]).map(v=>v.str).join(' ')).join('\n')});page.cleanup();
  }}finally{await doc.loadingTask.destroy();}return pages;
}
async function updateMarket(){
  const reports=[],errors=[],results={};
  const before=(await request('/internal/market-state')).data;
  for(const [source,name] of [['steel','中國鋼材'],['aluminium','世界銀行鋁價'],['fx_monthly','央行月匯率'],['fx_daily','央行日匯率']]){
    try{
      const indicator=document.querySelector('#aMarketStatus');if(indicator)indicator.textContent='正在更新'+name+'…';
      let r,body={source};
      if(source==='steel'){
        const full=!['sb-china-hrb','sb-china-plate'].every(series=>before.market.some(r=>r.series===series&&r.history_complete));
        const batches=[];
        if(full){const history=await publicFetch('steel-history');batches.push({pages:await marketPdf(history.bytes),url:history.url});}
        const recent=await publicFetch('steel-recent');batches.push({pages:await marketPdf(recent.bytes),url:recent.url});
        body={source,batches,full};r=(await request('/internal/market',{method:'POST'},body)).data;
      }else{
        const fetched=await publicFetch(source);body.url=fetched.url;r=(await request('/internal/market',{method:'POST',body:fetched.bytes},body)).data;
      }
      results[source]=r;reports.push({name,source,ok:true,count:r.count});
    }catch(error){errors.push(name+'：'+error.message);reports.push({name,source,ok:false,count:0,error:error.message});}
  }
  const current=(await request('/internal/market-state')).data;
  for(const report of reports){
    const rows=report.source==='steel'?current.market.filter(r=>r.series.startsWith('sb-china-')):report.source==='aluminium'?current.market.filter(r=>r.series==='wb-aluminium'):current.fx.filter(r=>r.source==='cbc'&&r.frequency===(report.source==='fx_daily'?'daily':'monthly'));
    report.cached_count=rows.length;report.latest=rows.map(r=>r.period).sort().at(-1)||null;
  }
  return {reports,results,errors,cached:true};
}
async function reset(){
  if(activeOCR||queued.size)throw Error('請等目前單據辨識完成後再重設');
  if(!confirm('重設會清除這個瀏覽器新增的單據、報價與修改，並還原虛構範例。請先下載需要的備份。確定重設？'))return;
  await rpc({type:'reset'});location.reload();
}
async function restore(file){
  if(activeOCR||queued.size)throw Error('請等目前單據辨識完成後再還原');
  if(file.size>200*1024*1024)throw Error('備份最多 200 MB');
  if(!confirm('還原將取代此瀏覽器目前的 Demo 資料。確定繼續？'))return;
  await request('/internal/restore',{method:'POST',body:file});location.reload();
}
globalThis.Demo={start,api,download,reset,restore,get activeOCR(){return activeOCR;}};
