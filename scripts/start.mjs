import {prepareDemo} from './prepare-demo.mjs';
import {startServer} from '../server/local-server.mjs';
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13)){console.error('請安裝 Node.js 22.13 以上版本。');process.exit(1);}
const args=process.argv.slice(2);
let port=4173;
if(args.length){
  if(args.length!==2||args[0]!=='--port'||!/^\d+$/.test(args[1])||+args[1]<1||+args[1]>65535){console.error('用法：npm start -- --port 4173（連接埠範圍 1–65535）');process.exit(1);}
  port=Number(args[1]);
}
try{
  await prepareDemo();
  const server=await startServer({port});
  console.log(`\n材料進料帳 · Demo\n開啟：http://127.0.0.1:${server.address().port}\n只接受本機連線。文件在各自瀏覽器辨識與保存。\n按 Ctrl+C 停止。`);
  let closing=false;
  const close=()=>{if(closing)return;closing=true;server.close(()=>process.exit(0));server.closeIdleConnections();};
  process.on('SIGINT',close);process.on('SIGTERM',close);
}catch(error){
  console.error(error.code==='EADDRINUSE'?`連接埠 ${port} 已被占用。請停止原服務，或使用 npm start -- --port 4174。`:'啟動失敗：'+error.message);
  process.exitCode=1;
}
