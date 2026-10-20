import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketHandler} from '../server/market-proxy.mjs';
const request=(query,method='GET')=>new Request('http://127.0.0.1/api/public-market?'+query,{method});
test('fixed public source preserves content, provenance, cache and MIME headers',async()=>{
  let calls=0;
  const handle=createMarketHandler({fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://cpx.cbc.gov.tw/api/OpenData/FTDOpenData_Month');assert.equal(options.redirect,'manual');
    return new Response('[{"date":"2026-09","value":31}]',{headers:{'Content-Type':'application/json'}});
  }});
  const first=await handle(request('source=fx_monthly'));
  assert.equal(first.status,200);assert.match(first.headers.get('X-Source-URL'),/^https:\/\/cpx.cbc.gov.tw/);
  assert.equal(first.headers.get('Cache-Control'),'public,max-age=3600');assert.equal(first.headers.get('Content-Type'),'application/json');
  assert.deepEqual(await first.json(),[{date:'2026-09',value:31}]);
  assert.equal(await (await handle(request('source=fx_monthly'))).text(),'[{"date":"2026-09","value":31}]');assert.equal(calls,1);
});
test('cache expires and failures preserve prior browser cache semantics',async()=>{
  let time=0,fail=false;
  const handle=createMarketHandler({now:()=>time,fetchImpl:async()=>{if(fail)throw Error('offline');return new Response('ok');}});
  assert.equal((await handle(request('source=fx_daily'))).status,200);time=3600001;fail=true;
  const response=await handle(request('source=fx_daily'));assert.equal(response.status,502);assert.match((await response.json()).error,/offline/);
});
test('unknown sources, duplicate sources, arbitrary URLs and methods are rejected without fetch',async()=>{
  const handle=createMarketHandler({fetchImpl:()=>{throw Error('unexpected fetch');}});
  for(const query of ['source=https://example.com','source=__proto__','source=fx_daily&url=https://example.com','source=fx_daily&source=fx_monthly',''])assert.equal((await handle(request(query))).status,400);
  const response=await handle(request('source=fx_daily','POST'));assert.equal(response.status,405);assert.equal(response.headers.get('Allow'),'GET');
});
test('redirects cannot escape the source allowlist or switch protocol',async()=>{
  for(const location of ['https://example.com/private','http://cpx.cbc.gov.tw/','https://user:password@cpx.cbc.gov.tw/','https://cpx.cbc.gov.tw:444/']){
    let calls=0;
    const handle=createMarketHandler({fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{Location:location}});}});
    const response=await handle(request('source=fx_daily'));assert.equal(response.status,502);assert.match((await response.json()).error,/公開來源位置不正確/);assert.equal(calls,1);
  }
});
test('redirect loops and overlarge responses stop with errors',async()=>{
  let calls=0;
  const handle=createMarketHandler({fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'/loop'}});}});
  assert.equal((await handle(request('source=fx_daily'))).status,502);assert.equal(calls,5);
  const large=createMarketHandler({fetchImpl:async()=>new Response(new Uint8Array(12*1024*1024+1))});
  const response=await large(request('source=fx_daily'));assert.equal(response.status,502);assert.match((await response.json()).error,/12 MB/);
});
test('steel recent uses the alternate official host on failure',async()=>{
  const calls=[];
  const handle=createMarketHandler({fetchImpl:async url=>{calls.push(url);if(calls.length===1)return new Response('unavailable',{status:503});return new Response('pdf',{headers:{'Content-Type':'application/pdf'}});}});
  assert.equal((await handle(request('source=steel-recent'))).status,200);assert.deepEqual(calls,['https://steelbenchmarker.com/history.pdf','https://www.steelbenchmarker.com/history.pdf']);
});
test('World Bank discovery only follows the allowlisted spreadsheet host',async()=>{
  const url='https://thedocs.worldbank.org/en/doc/example/CMO-Historical-Data-Monthly.xlsx',calls=[];
  const handle=createMarketHandler({fetchImpl:async target=>{calls.push(target);return calls.length===1?new Response(`<a href="${url}">Data</a>`):new Response('xlsx');}});
  assert.equal((await handle(request('source=aluminium'))).status,200);assert.equal(calls[1],url);
});
