import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const manifest={};
async function walk(dir){for(const e of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,e.name);if(e.isDirectory())await walk(file);else if(e.isFile())manifest[file.split(path.sep).join('/')]=createHash('sha256').update(await readFile(file)).digest('hex');}}
await walk('public/assets');await writeFile('tools/public-assets.sha256.json',JSON.stringify(manifest,null,2)+'\n');
console.log('Updated synthetic asset checksums. Review all generated images before committing.');
