import {spawnSync} from 'node:child_process';
export function findPython(){
  const candidates=process.env.PYTHON?[[process.env.PYTHON]]:[['python3'],['python'],['py','-3']];
  for(const [command,...args]of candidates){
    const r=spawnSync(command,[...args,'-c','import sys;print(int(sys.version_info >= (3,11)))'],{encoding:'utf8'});
    if(r.status===0&&r.stdout.trim()==='1')return {command,args};
  }
  throw Error('開發測試需要 Python 3.11 以上；一般使用 npm start 不需要安裝 Python。');
}
