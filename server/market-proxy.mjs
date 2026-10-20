const SOURCES={
  'steel-history':'https://www.steelbenchmarker.com/history2.pdf',
  'steel-recent':'https://steelbenchmarker.com/history.pdf',
  fx_monthly:'https://cpx.cbc.gov.tw/api/OpenData/FTDOpenData_Month',
  fx_daily:'https://cpx.cbc.gov.tw/api/OpenData/FTDOpenData_Day'
};
const HOSTS=new Set(['www.worldbank.org','thedocs.worldbank.org','cpx.cbc.gov.tw','steelbenchmarker.com','www.steelbenchmarker.com']);
function check(url){
  const u=new URL(url);
  if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||(u.port&&u.port!=='443')||u.username||u.password)throw Error('公開來源位置不正確');
}
export function createMarketHandler({fetchImpl=fetch,now=Date.now}={}){
  // Cache only these five public series. No visitor documents reach this server.
  const cache=new Map();
  async function download(url){
    for(let i=0;i<5;i++){
      check(url);
      const r=await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(18000),headers:{'User-Agent':'MaterialIntakeDemo/1.0 (public commodity reference)'}});
      if([301,302,303,307,308].includes(r.status)){
        const location=r.headers.get('Location');if(!location)throw Error('公開來源重新導向失敗');
        await r.body?.cancel();url=new URL(location,url).href;continue;
      }
      if(!r.ok||!r.body){await r.body?.cancel();throw Error('公開來源暫時無法取得（'+r.status+'）');}
      const reader=r.body.getReader(),chunks=[];let total=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>12*1024*1024)throw Error('公開行情檔案超過 12 MB');chunks.push(value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      return {data:Buffer.concat(chunks),url,type:r.headers.get('Content-Type')||'application/octet-stream'};
    }
    throw Error('公開來源重新導向次數過多');
  }
  function response(result){return new Response(result.data,{headers:{'Content-Type':result.type,'Cache-Control':'public,max-age=3600','X-Source-URL':result.url,'X-Content-Type-Options':'nosniff'}});}
  return async function handlePublicMarket(request){
    if(request.method!=='GET')return Response.json({error:'僅支援 GET'},{status:405,headers:{Allow:'GET'}});
    const search=new URL(request.url).searchParams,source=search.get('source')||'';
    if([...search.keys()].some(k=>k!=='source')||search.getAll('source').length!==1||(!Object.hasOwn(SOURCES,source)&&source!=='aluminium'))return Response.json({error:'不支援的固定行情來源'},{status:400});
    try{
      const previous=cache.get(source);if(previous&&now()-previous.time<3600000)return response(previous);
      let url=SOURCES[source];
      if(source==='aluminium'){
        url='https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx';
        try{const home=await download('https://www.worldbank.org/en/research/commodity-markets');const match=new TextDecoder().decode(home.data).match(/https:\/\/thedocs\.worldbank\.org\/[^"\s<>]*CMO-Historical-Data-Monthly\.xlsx/);if(match)url=match[0];}catch{}
      }
      let result;
      try{result=await download(url);}catch(error){if(source!=='steel-recent')throw error;result=await download('https://www.steelbenchmarker.com/history.pdf');}
      cache.set(source,{...result,time:now()});return response(result);
    }catch(error){return Response.json({error:error instanceof Error?error.message:'公開來源更新失敗，保留既有快取'},{status:502});}
  };
}
