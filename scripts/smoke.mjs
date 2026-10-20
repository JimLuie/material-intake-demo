import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {rm} from 'node:fs/promises';
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
// Force a fresh JS-only core package. Python is absent from the child PATH.
await rm('public/core.zip',{force:true});
const child=spawn(process.execPath,['scripts/start.mjs','--port',String(port)],{env:{...process.env,PATH:path.dirname(process.execPath)},stdio:['ignore','pipe','pipe']});
let output='',stderr='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{stderr+=b;});
const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));
try{
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{clearInterval(poll);reject(Error('Local startup timed out: '+output+stderr));},90000);
    const poll=setInterval(()=>{
      if(output.includes('開啟：http://')){clearInterval(poll);clearTimeout(timeout);resolve();}
      else if(child.exitCode!==null){clearInterval(poll);clearTimeout(timeout);reject(Error('Startup failed: '+output+stderr));}
    },50);
  });
  const base=`http://127.0.0.1:${port}`;
  const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/材料進料帳/);
  for(const [file,type]of [['/core.zip','application/zip'],['/vendor/pyodide/pyodide.asm.wasm','application/wasm'],['/vendor/tessdata/chi_tra.traineddata.gz','application/gzip'],['/vendor/pdfjs/pdf.mjs','text/javascript']]){
    const response=await fetch(base+file,{method:'HEAD'});assert.equal(response.status,200,file);assert.match(response.headers.get('Content-Type'),new RegExp(type));
  }
  assert.equal((await fetch(base+'/api/public-market?source=unapproved')).status,400);
  const invalid=spawn(process.execPath,['scripts/start.mjs','--port','bad'],{stdio:['ignore','pipe','pipe']});
  assert.equal(await new Promise(resolve=>invalid.once('exit',resolve)),1);
  const busy=spawn(process.execPath,['scripts/start.mjs','--port',String(port)],{env:{...process.env,PATH:path.dirname(process.execPath)},stdio:['ignore','pipe','pipe']});
  let message='';busy.stderr.on('data',b=>{message+=b;});
  assert.equal(await new Promise(resolve=>busy.once('exit',resolve)),1);assert.match(message,/已被占用/);
  console.log('PASS: Node-only startup, core packaging, static assets, CLI validation and occupied port.');
}finally{
  child.kill('SIGTERM');
  const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timeout);
}
