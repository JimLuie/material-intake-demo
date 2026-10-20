import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {findPython} from './python.mjs';
try{
  const {command,args}=findPython();
  const result=spawnSync(command,[...args,'-m','unittest','discover','-s','tests'],{stdio:'inherit',env:{...process.env,PYTHONUTF8:'1',PYTHONPATH:[path.resolve('public/core'),process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)}});
  process.exitCode=result.status??1;
}catch(error){console.error(error.message);process.exitCode=1;}
