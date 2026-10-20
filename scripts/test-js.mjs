import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=readdirSync('tests').filter(f=>f.endsWith('.cjs')||f.endsWith('.test.mjs')).sort().map(f=>'tests/'+f);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
process.exit(result.status??1);
