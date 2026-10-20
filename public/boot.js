'use strict';
(async function boot(){
  const startup=document.querySelector('#startup'),app=document.querySelector('.app');
  const theme=new URLSearchParams(location.search).get('theme');if(['light','dark'].includes(theme))document.documentElement.dataset.theme=theme;
  try{
    if(!['http:','https:'].includes(location.protocol))throw Error('請使用網站網址或本機啟動網址開啟 Demo。');
    await import('./demo-runtime.mjs');await Demo.start();
    startup.hidden=true;app.hidden=false;
    for(const src of ['connection.js','state.js','billing.js','ui.js','review.js','search.js','workflow.js','organization.js','analysis-compare.js','analysis.js','analysis-review.js','tax.js','app.js']){
      await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(Error('頁面檔案載入失敗：'+src));document.body.append(script);});
    }
    document.addEventListener('click',event=>{
      const a=event.target.closest('a[href]');if(!a)return;
      const url=new URL(a.href,location.href);
      if(url.origin===location.origin&&/^\/api\/(?:backup|export\.csv|analysis\/(?:export\.csv|template))$/.test(url.pathname)){
        event.preventDefault();Demo.download(url.pathname+url.search).catch(e=>toast(e.message));
      }
    });
    document.querySelectorAll('#demoReset,[data-demo-reset]').forEach(b=>b.addEventListener('click',()=>Demo.reset().catch(e=>toast(e.message))));
    const input=document.querySelector('#demoRestoreFile');document.querySelectorAll('#demoRestore,[data-demo-restore]').forEach(b=>b.addEventListener('click',()=>input.click()));
    input.addEventListener('change',()=>{if(input.files[0])Demo.restore(input.files[0]).catch(e=>toast(e.message));input.value='';});
    window.addEventListener('demo-data-changed',()=>refresh(true));
  }catch(error){
    app.hidden=true;startup.hidden=false;
    document.querySelector('#startupTitle').textContent='工作台尚未就緒';document.querySelector('#startupMessage').textContent=error.message;
    const link=document.querySelector('#openLocalApp');link.href=location.href;link.textContent='重新載入';
  }
})();
