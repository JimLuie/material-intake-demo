import {cp, mkdir, readdir, readFile, writeFile, stat, rename, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {zipSync} from 'fflate';

export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export const models=[
  {language:'chi_tra',sha256:'11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743'},
  {language:'eng',sha256:'45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'}
].map(m=>({...m,url:`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${m.language}/4.0.0_best_int/${m.language}.traineddata.gz`}));
const hash=data=>createHash('sha256').update(data).digest('hex');
async function exists(file){try{await stat(file);return true;}catch{return false;}}
async function atomicWrite(file,data){
  await mkdir(path.dirname(file),{recursive:true});
  const temporary=file+`.partial-${process.pid}`;
  try{await writeFile(temporary,data);await rename(temporary,file);}finally{await rm(temporary,{force:true});}
}
export async function downloadModel(model,file,{fetchImpl=fetch}={}){
  try{if(hash(await readFile(file))===model.sha256)return false;}catch{}
  const response=await fetchImpl(model.url,{signal:AbortSignal.timeout(60000)});
  if(!response.ok||!response.body)throw Error(`OCR 模型下載失敗（${response.status}）。請確認網路後重新執行 npm start。`);
  const chunks=[];let size=0;
  for await(const value of response.body){size+=value.length;if(size>8*1024*1024)throw Error('OCR 模型大小不正確，請重新執行 npm start。');chunks.push(value);}
  const data=Buffer.concat(chunks);
  if(hash(data)!==model.sha256)throw Error('OCR 模型校驗失敗，請重新執行 npm start。');
  await atomicWrite(file,data);return true;
}
async function filesBelow(directory){
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())files.push(...await filesBelow(file));else files.push(file);
  }
  return files;
}
export async function prepareDemo({root=projectRoot,fetchImpl=fetch,log=console.log}={}){
  const require=createRequire(path.join(root,'package.json'));
  const pkg=name=>path.dirname(require.resolve(name+'/package.json'));
  const settings=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const vendor=path.join(root,'public/vendor'),manifestFile=path.join(root,'public/.runtime-manifest.json');
  let previous;try{previous=JSON.parse(await readFile(manifestFile,'utf8'));}catch{}
  const versions=JSON.stringify(settings.dependencies);
  let complete=previous?.versions===versions;
  if(complete)for(const [relative,size]of Object.entries(previous.files??{})){
    try{if((await stat(path.join(vendor,relative))).size!==size){complete=false;break;}}catch{complete=false;break;}
  }
  if(!complete){
    log('準備瀏覽器執行檔（Pyodide、OCR 與文件解碼器）…');
    await mkdir(vendor,{recursive:true});
    const copy=async(from,to)=>{const file=path.join(vendor,to);await mkdir(path.dirname(file),{recursive:true});await cp(from,file,{recursive:true});};
    for(const file of ['pyodide.mjs','pyodide.asm.mjs','pyodide.asm.wasm','python_stdlib.zip','pyodide-lock.json'])await copy(path.join(pkg('pyodide'),file),'pyodide/'+file);
    for(const file of ['tesseract.esm.min.js','worker.min.js','tesseract.min.js.LICENSE.txt','worker.min.js.LICENSE.txt'])await copy(path.join(pkg('tesseract.js'),'dist',file),'tesseract/'+file);
    for(const file of await readdir(pkg('tesseract.js-core')))if(/\.wasm(?:\.js)?$/.test(file)||/LICENSE/.test(file))await copy(path.join(pkg('tesseract.js-core'),file),'tesseract-core/'+file);
    for(const file of ['pdf.mjs','pdf.worker.mjs'])await copy(path.join(pkg('pdfjs-dist'),'build',file),'pdfjs/'+file);
    for(const file of ['LICENSE','cmaps','standard_fonts','wasm'])await copy(path.join(pkg('pdfjs-dist'),file),'pdfjs/'+file);
    await copy(path.join(pkg('libheif-js'),'libheif-wasm/libheif-bundle.mjs'),'libheif/libheif-bundle.mjs');
    for(const name of ['libheif-js','utif','pako'])await copy(path.join(pkg(name),'LICENSE'),(name==='libheif-js'?'libheif':name)+'/LICENSE');
    await copy(path.join(pkg('utif'),'UTIF.js'),'utif/UTIF.js');
    await copy(path.join(pkg('pako'),'dist/pako.min.js'),'utif/pako.min.js');
  }
  for(const model of models){
    const file=path.join(vendor,'tessdata',model.language+'.traineddata.gz');
    let valid=false;try{valid=hash(await readFile(file))===model.sha256;}catch{}
    if(!valid)log(`下載並校驗 ${model.language} OCR 模型…`);
    await downloadModel(model,file,{fetchImpl});
  }
  const core={},coreDir=path.join(root,'public/core');
  for(const file of (await readdir(coreDir)).filter(f=>f.endsWith('.py')).sort())core[file]=new Uint8Array(await readFile(path.join(coreDir,file)));
  const coreHash=hash(Buffer.concat(Object.entries(core).flatMap(([name,bytes])=>[Buffer.from(name+'\0'),bytes])));
  const archive=path.join(root,'public/core.zip');
  if(previous?.coreHash!==coreHash||!await exists(archive)){
    log('打包瀏覽器 Python 計算核心…');
    // Pure JavaScript: end users do not need a Python installation.
    await atomicWrite(archive,zipSync(core,{level:6,mtime:new Date('2026-01-01T00:00:00Z')}));
  }
  if(!complete||previous?.coreHash!==coreHash){
    const files={};for(const file of await filesBelow(vendor))files[path.relative(vendor,file).split(path.sep).join('/')]=(await stat(file)).size;
    await atomicWrite(manifestFile,JSON.stringify({versions,coreHash,files}));
  }
  log('本機資產已就緒。');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  prepareDemo().catch(error=>{console.error('準備失敗：'+error.message);process.exitCode=1;});
}
