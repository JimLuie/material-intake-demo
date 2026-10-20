import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../server/local-server.mjs';
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'material-server-')),root=path.join(directory,'public');await mkdir(root);
  for(const [name,data]of Object.entries({'index.html':'<h1>Demo</h1>','worker.mjs':'export {};','test.wasm':'wasm','model.gz':'gzip','sample.pdf':'pdf','font.woff2':'font'}))await writeFile(path.join(root,name),data);
  await writeFile(path.join(directory,'secret.txt'),'private');await writeFile(path.join(root,'.hidden'),'hidden');
  const server=await startServer({root,port:0,marketHandler:async()=>new Response('public market')});
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(directory,{recursive:true,force:true});});
  return {root,directory,server,base:'http://127.0.0.1:'+server.address().port};
}
test('loopback server serves root, GET/HEAD, types and conditional requests',async t=>{
  const {server,base}=await fixture(t);assert.equal(server.address().address,'127.0.0.1');
  const response=await fetch(base+'/');assert.equal(await response.text(),'<h1>Demo</h1>');assert.match(response.headers.get('Content-Type'),/text\/html/);
  const cached=await fetch(base+'/',{headers:{'If-None-Match':response.headers.get('ETag')}});assert.equal(cached.status,304);
  for(const [file,type]of [['worker.mjs','text/javascript'],['test.wasm','application/wasm'],['model.gz','application/gzip'],['sample.pdf','application/pdf'],['font.woff2','font/woff2']]){
    const result=await fetch(base+'/'+file,{method:'HEAD'});assert.equal(result.status,200);assert.match(result.headers.get('Content-Type'),new RegExp(type));assert.equal(await result.text(),'');assert.ok(+result.headers.get('Content-Length')>0);
  }
});
test('settings, hidden files, malformed paths and unsupported methods are unavailable',async t=>{
  const {base}=await fixture(t);
  for(const location of ['/package.json','/.git/config','/.hidden','/%2e%2e%2fsecret.txt','/a%5c..%5csecret.txt','/not-there','/api/upload'])assert.equal((await fetch(base+location)).status,404,location);
  assert.equal((await fetch(base+'/%ZZ')).status,400);
  for(const [location,method]of [['/','POST'],['/api/public-market?source=fx_daily','POST'],['/api/public-market?source=fx_daily','HEAD']])assert.equal((await fetch(base+location,{method})).status,405);
  assert.equal(await(await fetch(base+'/api/public-market?source=fx_daily')).text(),'public market');
});
test('symlinks cannot expose files outside public',async t=>{
  const {root,directory,base}=await fixture(t);
  try{await symlink(path.join(directory,'secret.txt'),path.join(root,'leak.txt'));}catch(error){if(error.code==='EPERM'){t.skip('Host does not grant symlink permission');return;}throw error;}
  assert.equal((await fetch(base+'/leak.txt')).status,404);
});
test('unrelated Host headers are refused',async t=>{
  const {server}=await fixture(t);
  const status=await new Promise((resolve,reject)=>{
    const request=http.get({host:'127.0.0.1',port:server.address().port,path:'/',headers:{Host:'unrelated.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);
  });assert.equal(status,421);
});
