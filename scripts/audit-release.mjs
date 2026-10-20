import {readdir,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const skip=new Set(['.git','node_modules','outputs','__pycache__','coverage']);
const problems=[];let checked=0;
const secrets=[/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{40,}/,/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,/appgprj_[0-9a-f]{24,}/,/\/Users\/[^\s"'<>]+/];
async function walk(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(skip.has(entry.name))continue;
    const file=path.join(directory,entry.name),relative=path.relative(root,file).split(path.sep).join('/');
    if(relative==='public/vendor'||relative==='public/core.zip'||relative==='public/.runtime-manifest.json')continue;
    if(entry.isSymbolicLink()){problems.push(relative+': unexpected symlink');continue;}
    if(entry.isDirectory()){if(['.openai','.sites-runtime','.wrangler','backups','data'].includes(entry.name))problems.push(relative+': unexpected private/runtime directory');else await walk(file);continue;}
    if(!entry.isFile())continue;
    checked++;
    if(/\.(sqlite3?|db|log|pem|key|zip|tgz)$/i.test(entry.name)||entry.name.startsWith('.env'))problems.push(relative+': unexpected private/runtime file');
    if((await stat(file)).size>25*1024*1024)problems.push(relative+': unexpectedly large source asset');
    if(/\.(m?js|cjs|json|py|md|html|css|yml|txt)$/.test(entry.name)){
      const text=await readFile(file,'utf8');for(const pattern of secrets)if(pattern.test(text))problems.push(relative+': credential, deployment identity or user path');
    }
  }
}
await walk(root);
const manifest=JSON.parse(await readFile(path.join(root,'tools/public-assets.sha256.json'),'utf8'));
const actual=[];
async function assets(directory){for(const e of await readdir(directory,{withFileTypes:true})){const p=path.join(directory,e.name);if(e.isDirectory())await assets(p);else if(e.isFile())actual.push(path.relative(root,p).split(path.sep).join('/'));}}
await assets(path.join(root,'public/assets'));
if(JSON.stringify(actual.sort())!==JSON.stringify(Object.keys(manifest).sort()))problems.push('public/assets: file allowlist differs');
for(const [file,expected]of Object.entries(manifest)){
  const digest=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');if(digest!==expected)problems.push(file+': public synthetic asset changed');
}
const seed=JSON.parse(await readFile(path.join(root,'public/demo-seed.json'),'utf8'));
if(seed.documents.length!==31||seed.quotes.length!==3||seed.documents.some(d=>!d.name.startsWith('DEMO-')||!d.draft.meta.note.includes('虛構')))problems.push('Synthetic seed contents are unexpected');
console.log(JSON.stringify({ok:problems.length===0,source_files_checked:checked,synthetic_assets_checked:actual.length,problems},null,2));
if(problems.length)process.exitCode=1;
