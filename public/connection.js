'use strict';
let connectionIssueShown=false;
const LOCAL_CONNECTION_MESSAGE='瀏覽器資料引擎暫時無法保存。請保留本頁與修改，稍後重試。';
function showConnectionIssue(){document.querySelector('#connection').textContent='資料尚未保存';if(!connectionIssueShown)document.querySelector('#connectionNotice').hidden=false;connectionIssueShown=true;}
function clearConnectionIssue(){document.querySelector('#connection').textContent='瀏覽器資料已就緒';document.querySelector('#connectionNotice').hidden=true;connectionIssueShown=false;}
async function api(path,options={}){try{return await Demo.api(path,options);}catch(error){if(!error.status)showConnectionIssue();throw error;}}
document.querySelector('#retryConnection').addEventListener('click',()=>refresh(true));
document.querySelector('#dismissConnection').addEventListener('click',()=>document.querySelector('#connectionNotice').hidden=true);
