import {loadPyodide} from 'pyodide';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {findPython} from '../scripts/python.mjs';
const seed=JSON.parse(fs.readFileSync('public/demo-seed.json'));
const py=await loadPyodide();py.FS.mkdir('/app');
for(const file of fs.readdirSync('public/core').filter(f=>f.endsWith('.py')))py.FS.writeFile('/app/'+file,fs.readFileSync('public/core/'+file));
py.FS.writeFile('/app/parity_summary.py',fs.readFileSync('tests/parity_summary.py'));
await py.runPythonAsync("import sys,json;sys.path.insert(0,'/app')\nimport browser_bridge as bridge\nfrom parity_summary import summary\nbridge.init_store('/demo-data')");
const bridgeProxy=py.globals.get('bridge'),seedOne=bridgeProxy.seed_one;
for(const spec of seed.documents){
 const original=py.toPy(new Uint8Array(fs.readFileSync('public'+spec.original))),pages=py.toPy(spec.pages.map(p=>new Uint8Array(fs.readFileSync('public'+p.url))));
 try{seedOne(JSON.stringify(spec),original,pages);}finally{original.destroy();pages.destroy();}
}
seedOne.destroy();py.globals.set('seed_json',JSON.stringify(seed));py.runPython('bridge.finish_seed(seed_json)');
const actual=JSON.parse(py.runPython('json.dumps(summary(bridge),sort_keys=True)'));
const script=`import sys,json,tempfile\nfrom pathlib import Path\nsys.path[:0]=['public/core','tests']\nimport browser_bridge as bridge\nfrom parity_summary import summary\nspec=json.load(open('public/demo-seed.json'))\nwith tempfile.TemporaryDirectory() as folder:\n bridge.init_store(folder)\n for d in spec['documents']:bridge.seed_one(json.dumps(d),Path('public'+d['original']).read_bytes(),[Path('public'+p['url']).read_bytes() for p in d['pages']])\n bridge.finish_seed(json.dumps(spec))\n print(json.dumps(summary(bridge),sort_keys=True))\n bridge.store.executor.shutdown()\n`;
const python=findPython();
const native=spawnSync(python.command,[...python.args,'-c',script],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});assert.equal(native.status,0,native.stderr);assert.deepEqual(actual,JSON.parse(native.stdout));
// Pyodide's SQLite serialization and binary bridge must also support rollback/ZIP.
py.runPython("snap=bridge.snapshot_request('/api/upload')\nr=bridge.dispatch('POST','/api/upload?name=rollback.jpg','{}','{}',b'virtual-payload')\nassert r['status']==200\nbridge.rollback_request(snap)\nassert len(bridge.store.records())==42\nbackup=bridge.store.backup()\nassert backup.startswith(b'PK')\nbridge.restore_backup(backup)\nassert len(bridge.store.state()['documents'])==31");
console.log('PASS: native Python and browser WebAssembly agree on 31 documents, 42 records, S50C financial analysis, rollback and backup restore.');
