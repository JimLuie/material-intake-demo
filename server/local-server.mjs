import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,realpath} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMarketHandler} from './market-proxy.mjs';
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.wasm':'application/wasm','.woff2':'font/woff2','.gz':'application/gzip','.zip':'application/zip','.txt':'text/plain; charset=utf-8','.py':'text/plain; charset=utf-8'};
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
export async function startServer({port=4173,root=publicRoot,marketHandler=createMarketHandler()}={}){
  root=await realpath(root);
  const server=http.createServer(async(req,res)=>{
    const reply=(status,error,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(req.method==='HEAD'?undefined:JSON.stringify({error}));};
    try{
      const host=req.headers.host;
      if(!host||!['127.0.0.1','localhost'].includes(new URL('http://'+host).hostname))return reply(421,'此服務僅供本機使用');
      if(!req.url?.startsWith('/')||req.url.startsWith('//'))return reply(400,'網址不正確');
      const url=new URL(req.url,'http://127.0.0.1'),pathname=decodeURIComponent(url.pathname);
      if(pathname==='/api/public-market'){
        if(req.method!=='GET')return reply(405,'僅支援 GET',{Allow:'GET'});
        const response=await marketHandler(new Request(url,{method:req.method}));
        res.writeHead(response.status,Object.fromEntries(response.headers));
        res.end(req.method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));return;
      }
      if(pathname.startsWith('/api/'))return reply(404,'此資料介面在瀏覽器內執行');
      if(!['GET','HEAD'].includes(req.method))return reply(405,'僅支援 GET／HEAD',{Allow:'GET, HEAD'});
      if(pathname.includes('\0')||pathname.includes('\\')||pathname.split('/').some(p=>p.startsWith('.')))return reply(404,'找不到檔案');
      const candidate=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
      if(!inside(root,candidate))return reply(404,'找不到檔案');
      let file,info;
      try{file=await realpath(candidate);if(!inside(root,file))return reply(404,'找不到檔案');info=await stat(file);}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return reply(404,'找不到檔案');throw error;}
      if(!info.isFile())return reply(404,'找不到檔案');
      const etag=`W/"${info.size}-${Math.trunc(info.mtimeMs)}"`;
      const headers={'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',ETag:etag};
      if(req.headers['if-none-match']===etag){delete headers['Content-Length'];res.writeHead(304,headers);res.end();return;}
      res.writeHead(200,headers);
      if(req.method==='HEAD'){res.end();return;}
      await pipeline(createReadStream(file),res);
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      reply(error instanceof URIError||error.code==='ERR_INVALID_URL'?400:500,error instanceof URIError?'網址不正確':'本機服務處理失敗');
    }
  });
  server.requestTimeout=120000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  return server;
}
