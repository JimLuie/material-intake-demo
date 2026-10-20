const GRADE = {
  '7075':'鋁合金','6061':'鋁合金','6063':'鋁合金','5083':'鋁合金','5052':'鋁合金','2017':'鋁合金','2024':'鋁合金',
  'S45C':'碳鋼','S50C':'碳鋼','S55C':'碳鋼','SS400':'碳鋼',
  'SCM440':'合金鋼','SCM415':'合金鋼',
  'SKD11':'模具鋼','SKD61':'模具鋼','NAK80':'模具鋼','P20':'模具鋼','DC53':'模具鋼',
  'SUS304':'不鏽鋼','SUS303':'不鏽鋼','SUS316':'不鏽鋼'
};
const famOf = g => !g?'材質未列':GRADE[g] || '其他';


const TPL = {
  "hh": {
    "key": "hh",
    "name": "示範鋁材一廠 · 虛構出貨單",
    "short": "示範鋁材一廠",
    "img": "assets/slip-a.jpg",
    "boxes": {
      "1": [
        14.0,
        2.5,
        30,
        4.5
      ],
      "2": [
        56.5,
        14.8,
        14,
        3
      ],
      "3": [
        56.5,
        18.3,
        18,
        3
      ],
      "4": [
        5.8,
        30.7,
        16,
        3
      ],
      "5": [
        46,
        30.7,
        3.5,
        3
      ],
      "6": [
        56.8,
        30.7,
        5,
        3
      ],
      "7": [
        81.4,
        84.5,
        6.5,
        3
      ]
    },
    "marks": [
      "四種版型沿用不同紙色與表格欄位",
      "公司、聯絡資訊、尺寸與交易數字全部為虛構",
      "辨識後仍須逐筆對照原圖確認",
      "預載單據及自行上傳內容只保存在此瀏覽器"
    ],
    "map": [
      [
        1,
        "供應商",
        "示範鋁材一廠",
        "依表頭與版型判斷；新供應商可人工新增"
      ],
      [
        2,
        "日期",
        "2026-01-07",
        "虛構進料日期"
      ],
      [
        3,
        "單號",
        "1260107N4101",
        "虛構單號，原樣保存"
      ],
      [
        4,
        "材質與尺寸",
        "7075 / 12 × 28 × 94 mm",
        "原圖與表單使用同一份示範資料"
      ],
      [
        5,
        "數量",
        "152 件",
        "原單數量與計價數量分開保存"
      ],
      [
        6,
        "單價",
        "18.75",
        "單價依件數或公斤計算，加工費整筆加計"
      ],
      [
        7,
        "整單總計",
        "5457.8",
        "整單金額含所有明細，空白與零元分開保存"
      ]
    ]
  },
  "sk": {
    "key": "sk",
    "name": "示範鋼材二廠 · 虛構出貨單",
    "short": "示範鋼材二廠",
    "img": "assets/slip-b.jpg",
    "boxes": {
      "1": [
        14.0,
        2.5,
        30,
        4.5
      ],
      "2": [
        56.5,
        14.8,
        14,
        3
      ],
      "3": [
        56.5,
        18.3,
        18,
        3
      ],
      "4": [
        8.4,
        30.7,
        28,
        3
      ],
      "5": [
        40.6,
        30.7,
        3,
        3
      ],
      "6": [
        54.4,
        30.7,
        4,
        3
      ],
      "7": [
        81.4,
        84.5,
        6,
        3
      ]
    },
    "marks": [
      "四種版型沿用不同紙色與表格欄位",
      "公司、聯絡資訊、尺寸與交易數字全部為虛構",
      "辨識後仍須逐筆對照原圖確認",
      "預載單據及自行上傳內容只保存在此瀏覽器"
    ],
    "map": [
      [
        1,
        "供應商",
        "示範鋼材二廠",
        "依表頭與版型判斷；新供應商可人工新增"
      ],
      [
        2,
        "日期",
        "2026-01-11",
        "虛構進料日期"
      ],
      [
        3,
        "單號",
        "20260111402",
        "虛構單號，原樣保存"
      ],
      [
        4,
        "材質與尺寸",
        "S50C / 22 × 54 × 146 mm",
        "原圖與表單使用同一份示範資料"
      ],
      [
        5,
        "數量",
        "10 件",
        "原單數量與計價數量分開保存"
      ],
      [
        6,
        "單價",
        "85.0",
        "單價依件數或公斤計算，加工費整筆加計"
      ],
      [
        7,
        "整單總計",
        "4076.0",
        "整單金額含所有明細，空白與零元分開保存"
      ]
    ]
  },
  "zf": {
    "key": "zf",
    "name": "示範鋁業三廠 · 虛構出貨單",
    "short": "示範鋁業三廠",
    "img": "assets/slip-c.jpg",
    "boxes": {
      "1": [
        14.0,
        2.5,
        30,
        4.5
      ],
      "2": [
        56.5,
        14.8,
        14,
        3
      ],
      "3": [
        56.5,
        18.3,
        18,
        3
      ],
      "4": [
        18.2,
        30.7,
        32,
        3
      ],
      "5": [
        54.8,
        30.7,
        4,
        3
      ],
      "6": [
        72.5,
        30.7,
        4,
        3
      ],
      "7": [
        43.6,
        81.2,
        15,
        3.5
      ]
    },
    "marks": [
      "四種版型沿用不同紙色與表格欄位",
      "公司、聯絡資訊、尺寸與交易數字全部為虛構",
      "辨識後仍須逐筆對照原圖確認",
      "預載單據及自行上傳內容只保存在此瀏覽器"
    ],
    "map": [
      [
        1,
        "供應商",
        "示範鋁業三廠",
        "依表頭與版型判斷；新供應商可人工新增"
      ],
      [
        2,
        "日期",
        "2026-01-15",
        "虛構進料日期"
      ],
      [
        3,
        "單號",
        "02601155103",
        "虛構單號，原樣保存"
      ],
      [
        4,
        "材質與尺寸",
        "客供料 圓條66 / Ø66 × 124 mm",
        "原圖與表單使用同一份示範資料"
      ],
      [
        5,
        "數量",
        "192 件",
        "原單數量與計價數量分開保存"
      ],
      [
        6,
        "單價",
        "未列",
        "單價依件數或公斤計算，加工費整筆加計"
      ],
      [
        7,
        "整單總計",
        "未列",
        "整單金額含所有明細，空白與零元分開保存"
      ]
    ]
  },
  "zm": {
    "key": "zm",
    "name": "示範金屬四廠 · 虛構出貨單",
    "short": "示範金屬四廠",
    "img": "assets/slip-d.jpg",
    "boxes": {
      "1": [
        14.0,
        2.5,
        30,
        4.5
      ],
      "2": [
        56.5,
        14.8,
        14,
        3
      ],
      "3": [
        56.5,
        18.3,
        18,
        3
      ],
      "4": [
        18.9,
        30.7,
        14,
        3
      ],
      "5": [
        56,
        30.7,
        4,
        3
      ],
      "6": [
        71.4,
        30.7,
        4,
        3
      ],
      "7": [
        81.4,
        84.5,
        7,
        3
      ]
    },
    "marks": [
      "四種版型沿用不同紙色與表格欄位",
      "公司、聯絡資訊、尺寸與交易數字全部為虛構",
      "辨識後仍須逐筆對照原圖確認",
      "預載單據及自行上傳內容只保存在此瀏覽器"
    ],
    "map": [
      [
        1,
        "供應商",
        "示範金屬四廠",
        "依表頭與版型判斷；新供應商可人工新增"
      ],
      [
        2,
        "日期",
        "2026-01-19",
        "虛構進料日期"
      ],
      [
        3,
        "單號",
        "2601196104",
        "虛構單號，原樣保存"
      ],
      [
        4,
        "材質與尺寸",
        "6061 圓條98 / Ø98 × 39 mm",
        "原圖與表單使用同一份示範資料"
      ],
      [
        5,
        "數量",
        "101 件",
        "原單數量與計價數量分開保存"
      ],
      [
        6,
        "單價",
        "59.5",
        "單價依件數或公斤計算，加工費整筆加計"
      ],
      [
        7,
        "整單總計",
        "10677.5",
        "整單金額含所有明細，空白與零元分開保存"
      ]
    ]
  }
};

/* ================= helpers ================= */
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const asc = a => [...a].sort((x,y)=>x-y);
const orderedDims = a => a.length===2?[...a]:asc(a);
const fmtDim = n => { const v = +n; return Number.isInteger(v) ? v.toFixed(1) : String(+v.toFixed(2)); };
const dimStr = d => (d.length===2?'Ø':'')+orderedDims(d).map(fmtDim).join(' × ');
const money = n => (n==null || n==='' || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US',{maximumFractionDigits:2});
const vol = d => d.length===2?Math.PI*d[0]*d[0]*d[1]/4:d.reduce((a,b)=>a*b,1);
const cm3 = d => vol(d)/1000;
const wait = ms => new Promise(r=>setTimeout(r,ms));
const supChip = (k, text) => `<span class="sup sup-${k||'xx'}">${esc(text || (SUP[k]||SUP.xx).short)}</span>`;
const srcTag = r => r.src==='real' ? '<span class="src src-real">原始單據</span>' : r.src==='manual' ? '<span class="src src-manual">手動輸入</span>' : '<span class="src">示範</span>';
const byDateDesc = (a,b) => (a.r||a).date < (b.r||b).date ? 1 : -1;
const AX = ['厚','寬','長'];


function normalize(s){
  return String(s||'').replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0)-0xFEE0)).replace(/　/g,' ').replace(/[×✕✖]/g,'x');
}
const STEEL_RE = /S\d{2}C|SKD[\s-]?\d{1,2}|SCM[\s-]?\d{3}|SUS[\s-]?\d{3}|NAK[\s-]?\d{2}|SS[\s-]?\d{3}|P20|DC53/;
function parseQuery(raw){
  const q = {raw, dims:null, grade:null, family:null, sup:null, doc:null};
  let s = normalize(raw).trim();
  if (!s) return q;
  const dm = s.match(/(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)(?:\s*[xX*]\s*(\d+(?:\.\d+)?))?/);
  if (dm){ q.dims = [dm[1],dm[2],dm[3]].filter(Boolean).map(Number); s = s.replace(dm[0],' '); }
  const docM = s.match(/\d{7}N\d{4}|\d{11}/i);
  if (docM){ q.doc = docM[0].toUpperCase(); s = s.replace(docM[0],' '); }
  if (/示範鋁材一廠/.test(s)) q.sup = 'hh'; else if (/示範鋼材二廠/.test(s)) q.sup = 'sk';
  let up = s.toUpperCase();
  const st = up.match(STEEL_RE);
  if (st){ q.grade = st[0].replace(/[\s-]/g,''); up = up.replace(st[0],' '); }
  if (!q.grade){
    const al = up.match(/(?:\bAL?\s*)?([1-7]\d{3})(?:-?T\d+)?/);
    if (al && (GRADE[al[1]] || /鋁/.test(up))){ q.grade = al[1]; up = up.replace(al[0],' '); }
  }
  if (q.grade) q.family = famOf(q.grade);
  else if (/不鏽|不銹|白鐵/.test(up)) q.family = '不鏽鋼';
  else if (/模具/.test(up)) q.family = '模具鋼';
  else if (/鋁|\bAL\b/.test(up)) q.family = '鋁合金';
  else if (/碳鋼/.test(up)) q.family = '碳鋼';
  else if (/合金鋼/.test(up)) q.family = '合金鋼';
  else if (/鋼|鐵/.test(up)) q.family = 'steel';
  if (!q.dims){
    const nums = up.match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) q.dims = nums.slice(0,3).map(Number);
  }
  if (q.dims && q.dims.some(n => !(n>0))) q.dims = null;
  return q;
}

/* ================= isometric drawing ================= */
function fmtMargin(value){return Number(value.toFixed(4)).toLocaleString('en-US',{maximumFractionDigits:4});}
function iso(stock, part, o={}){
  const W = o.w || 460, H = o.h || 270, lab = o.labels !== false;
  const base = stock || part;
  if (!base) return '';
  if(base.length===2)return roundDrawing(stock,part,o);
  const [Z,Y,X] = base;
  const c = Math.cos(Math.PI/6), s = .5;
  const minx = -Y*c, maxx = X*c, miny = -Z, maxy = (X+Y)*s;
  const padX = lab ? 66 : 12, padY = lab ? 32 : 10;
  const k = Math.min((W-2*padX)/(maxx-minx), (H-2*padY)/(maxy-miny));
  const ox = (W-(maxx-minx)*k)/2 - minx*k, oy = (H-(maxy-miny)*k)/2 - miny*k;
  const P = (x,y,z) => [ox+(x-y)*c*k, oy+(x+y)*s*k - z*k];
  const f1 = n => n.toFixed(1);
  const pts = a => a.map(p => P(...p).map(f1).join(',')).join(' ');
  const faces = (x,y,z,cls,offset=[0,0,0]) => {
    const shifted=points=>pts(points.map(p=>p.map((v,i)=>v+offset[i])));
    return `<g class="${cls}" data-offset="${offset.join(',')}"><polygon class="f-l" points="${shifted([[0,y,0],[x,y,0],[x,y,z],[0,y,z]])}"/><polygon class="f-r" points="${shifted([[x,0,0],[x,y,0],[x,y,z],[x,0,z]])}"/><polygon class="f-t" points="${shifted([[0,0,z],[x,0,z],[x,y,z],[0,y,z]])}"/></g>`;
  };
  const line = (a,b) => { const p=P(...a), q=P(...b); return `<line x1="${f1(p[0])}" y1="${f1(p[1])}" x2="${f1(q[0])}" y2="${f1(q[1])}"/>`; };
  let g = '';
  if (stock) g += `<g class="iso-hidden">${line([0,0,0],[X,0,0])}${line([0,0,0],[0,Y,0])}${line([0,0,0],[0,0,Z])}</g>`;
  if (part){ const [pt,pw,pl] = part; g += faces(pl,pw,pt,'iso-part'+(stock?'':' is-alone'),stock?[(X-pl)/2,(Y-pw)/2,(Z-pt)/2]:[0,0,0]); }
  if (stock) g += faces(X,Y,Z,'iso-stock'+(part?' is-glass':''));
  if (lab){
    const a=P(0,Y,0), b=P(X,Y,0), cc=P(X,0,0), d=P(X,0,Z);
    const L=[(a[0]+b[0])/2-8,(a[1]+b[1])/2+18];
    const Wd=[(cc[0]+b[0])/2+9,(cc[1]+b[1])/2+17];
    const T=[cc[0]+9,(cc[1]+d[1])/2+4];
    if (Wd[1]-T[1] < 16) T[1] = Wd[1]-16;
    g += `<g class="iso-lab"><text x="${f1(L[0])}" y="${f1(L[1])}" text-anchor="end">長 ${fmtDim(X)}</text><text x="${f1(Wd[0])}" y="${f1(Wd[1])}">寬 ${fmtDim(Y)}</text><text x="${f1(T[0])}" y="${f1(T[1])}">厚 ${fmtDim(Z)}</text></g>`;
  }
  return `<svg class="iso" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria||'等角視圖')}">${g}</svg>`;
}
function roundDrawing(stock,part,o={}){
  const W=o.w||460,H=o.h||270,[diameter,length]=stock||part;
  const scale=Math.min((W-120)/(length+diameter*.45),(H-90)/diameter);
  const rx=diameter*.22*scale,ry=diameter*.5*scale,x=(W-length*scale)/2,y=H/2-8,end=x+length*scale;
  const cylinder=(dims,cls)=>{const r=dims[0]*.5*scale,ex=dims[0]*.22*scale,e=x+dims[1]*scale;
    return `<g class="${cls}"><path d="M${x},${y-r}L${e},${y-r}A${ex},${r} 0 0 1 ${e},${y+r}L${x},${y+r}A${ex},${r} 0 0 1 ${x},${y-r}Z"/><ellipse cx="${e}" cy="${y}" rx="${ex}" ry="${r}"/></g>`;};
  return `<svg class="iso round-figure" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria||'圓條尺寸圖')}">${stock?cylinder(stock,'round-stock'):''}${part?cylinder(part,'round-part'):''}<g class="iso-lab"><text x="${Math.max(12,x-rx-8)}" y="${y}" text-anchor="end">Ø${fmtDim(diameter)}</text><text x="${(x+end)/2}" y="${y+ry+28}" text-anchor="middle">長 ${fmtDim(length)} mm</text></g></svg>`;
}
const TRIAD = `<svg class="vp-triad" viewBox="0 0 44 40" aria-hidden="true"><path d="M22 24 37 32.5M22 24 7 32.5M22 24V6"/><text x="38" y="30">L</text><text x="1" y="30">W</text><text x="25" y="9">T</text></svg>`;


/* ================= table view ================= */
function recordAnalysisSummary(record){
  const doc=queue.find(d=>d.id===record.document_id);
  if(doc&&(doc.status!=='done'||(typeof dirty!=='undefined'&&dirty.has(doc.id))))return {price_basis:'gross',status:'pending',reason:'原單待重新確認',issues:[]};
  return record.analysis_summary||{price_basis:'gross',status:'unchecked',reason:doc?'尚未取得分析檢查結果':'無來源單據，無法檢查',issues:[]};
}
function recordAnalysisLabel(summary){
  return ({usable:'可分析',needs_review:'需核對／補充',duplicate:'重複已合併',unsupported:'暫未支援',customer_supplied:'客供料，無購料價格',pending:'原單待重新確認',unchecked:'尚未檢查'})[summary.status]||'尚未檢查';
}
function recordAnalysisHtml(record,detail=false){
  const s=recordAnalysisSummary(record),notes=s.status==='pending'||s.status==='unchecked'?[]:[s.tax_unconfirmed?'稅別未確認':'',s.theoretical_weight?'理論重量估算':''].filter(Boolean);
  const status=`<span class="analysis-quality ${esc(s.status)}">${esc(recordAnalysisLabel(s))}</span>`;
  if(!detail)return `<button class="record-analysis-button" type="button" data-analysis-record="${esc(record.id)}" aria-label="查看明細分析狀態：${esc(recordAnalysisLabel(s))}">${status}</button>${s.reason?`<small class="record-analysis-reason">${esc(s.reason)}</small>`:''}${notes.length?`<small class="record-analysis-note">${notes.map(esc).join(' · ')}</small>`:''}`;
  const issues=['pending','unchecked','duplicate'].includes(s.status)?[]:s.issues||[];
  return `<h3>分析狀態</h3>${status}<p class="k">含稅成交公斤價口徑（含加工費） · 可分析代表符合此口徑的納入條件；圖表另受日期與篩選條件限制。</p>${s.reason?`<p>${esc(s.reason)}</p>`:''}${issues.length?`<ul class="record-analysis-issues">${issues.map(i=>`<li>${esc(i.message)}</li>`).join('')}</ul>`:''}${notes.length?`<p class="k">${notes.map(esc).join(' · ')}；不代表已核實未稅純材料成本。</p>`:''}`;
}
function refreshRecordAnalysisDetail(){
  const el=$('#recordAnalysisDetail'),row=el&&records.find(r=>r.id===el.dataset.recordId);
  if(!row)return;
  const html=recordAnalysisHtml(row,true);if(el.innerHTML!==html)el.innerHTML=html;
}
const COLS = [
  {k:'date', label:'進料日期'},
  {k:'sup', label:'供應商'},
  {k:'label', label:'材料種類'},
  {k:'dims', label:'尺寸（mm）'},
  {k:'qty', label:'數量', r:true},
  {k:'price', label:'單價', r:true},
  {k:'processing_fee', label:'加工費', r:true},
  {k:'total', label:'明細金額', r:true},
  {k:'doc', label:'單號'}
];
function sortVal(r,k){
  if (k==='sup') return SUP[r.sup].short;
  if (k==='dims') return vol(r.dims);
  return r[k];
}
function tableRows(){
  let rows = records.filter(r => (state.fSup==='all' || r.sup===state.fSup) && (state.fFam==='all' || famOf(r.grade)===state.fFam));
  const t = normalize(state.fText).toUpperCase().trim();
  if (t){
    rows = rows.filter(r => [SUP[r.sup].name, r.label, r.grade, famOf(r.grade), r.part_no, r.doc, r.date, dimStr(r.dims), orderedDims(r.dims).join('X'), r.note].join(' ').toUpperCase().includes(t));
  }
  const {key, dir} = state.sort;
  rows.sort((a,b)=>{ const va = sortVal(a,key), vb = sortVal(b,key); return (va>vb?1:va<vb?-1:0)*dir; });
  return rows;
}
function renderTable(){
  const rows = tableRows();
  const version=JSON.stringify([rows,SUP,state.sort,[...state.picked],state.tableHighlight,queue.map(d=>[d.id,d.status,typeof dirty!=='undefined'&&dirty.has(d.id)])]);
  if($('#tbl').dataset.version===version)return;
  $('#tbl').dataset.version=version;
  const sum = rows.reduce((a,r)=>a+(+r.total||0),0);
  const missing = rows.filter(r=>r.amount==null||r.amount==='').length;
  const fams = new Set(rows.map(r=>famOf(r.grade)));
  const latest = rows.slice().sort(byDateDesc)[0];
  const nReal = rows.filter(r=>r.src==='real').length;
  $('#strip').innerHTML = `
    <div><div class="k">紀錄</div><div class="v">${rows.length}<small> 筆</small></div><div class="k">原始單據 ${nReal} · 其他 ${rows.length-nReal}</div></div>
    <div><div class="k">已列明細金額合計</div><div class="v"><small>NT$</small>${money(missing===rows.length&&missing?null:sum)}</div><div class="k">${missing?missing+' 筆金額未列，未納入加總':'不重複累計整單總計'}</div></div>
    <div><div class="k">材質分類</div><div class="v">${fams.size}<small> 類</small></div><div class="k">${[...fams].join('、') || '—'}</div></div>
    <div><div class="k">最近進料</div><div class="v">${latest?latest.date:'—'}</div><div class="k">${latest?`${SUP[latest.sup].short} · ${esc(latest.label)}`:'—'}</div></div>`;
  const allPicked = rows.length && rows.every(r=>state.picked.has(r.id));
  const head = `<thead><tr><th class="c-pick"><input type="checkbox" id="pickAll" aria-label="全選目前列表"${allPicked?' checked':''}></th>${COLS.map(c=>{
    const on = state.sort.key===c.k;
    return `<th class="${c.r?'r':''}"${on?` aria-sort="${state.sort.dir>0?'ascending':'descending'}"`:''}><button class="th-sort" type="button" data-sort="${c.k}">${c.label}<i>${on?(state.sort.dir>0?'▲':'▼'):'▼'}</i></button></th>`;
  }).join('')}<th class="record-analysis-cell">分析狀態</th><th>單據核對</th></tr></thead>`;
  const body = rows.length ? rows.map(r=>`<tr data-id="${r.id}" class="${state.picked.has(r.id)?'is-picked':''} ${state.tableHighlight===r.id?'is-returned':''}">
      <td class="c-pick"><input type="checkbox" class="pick" data-id="${r.id}" aria-label="選取 ${esc(r.label)} ${r.date}"${state.picked.has(r.id)?' checked':''}></td>
      <td class="mono">${r.date}</td>
      <td>${supChip(r.sup)}</td>
      <td><span class="mat">${esc(r.label)}</span><span class="fam">${famOf(r.grade)}</span></td>
      <td class="mono">${dimStr(r.dims)}</td>
      <td class="num">${money(r.qty)} ${esc(r.unit)}${r.weight_kg!=null?`<div class="billing-note">${money(r.weight_kg)} 公斤</div>`:''}</td>
      <td class="num">${money(r.price)}<div class="billing-note">／${esc(billingUnit(r))}</div></td>
      <td class="num">${money(r.processing_fee)}</td>
      <td class="num strong">${money(r.total)}</td>
      <td><span class="doc"><span class="mono">${esc(r.doc)}</span>${srcTag(r)}</span></td>
      <td class="record-analysis-cell">${recordAnalysisHtml(r)}</td>
      <td>${queue.some(d=>d.id===r.document_id)?`<button class="btn btn-sm" type="button" data-review-record="${esc(r.id)}">核對單據</button>`:'<span class="k">無來源單據</span>'}</td>
    </tr>`).join('') : `<tr><td colspan="12" style="text-align:center;color:var(--ink-3);padding:28px">沒有符合篩選條件的紀錄</td></tr>`;
  const foot = `<tfoot><tr><td></td><td colspan="5">合計 ${rows.length} 筆${missing?' · '+missing+' 筆金額未列':''}</td><td></td><td></td><td class="num">${money(missing===rows.length&&missing?null:sum)}</td><td></td><td></td><td></td></tr></tfoot>`;
  const active=document.activeElement,focused=active?.closest?.('#tbl')?{id:active.closest('tr')?.dataset.id,
    kind:active.dataset.analysisRecord?'analysis':active.dataset.reviewRecord?'review':active.dataset.sort?'sort':'pick',sort:active.dataset.sort}:null;
  $('#tbl').innerHTML = head + `<tbody>${body}</tbody>` + foot;
  if(focused){
    const selector={analysis:'[data-analysis-record]',review:'[data-review-record]',sort:'[data-sort]',pick:'.pick'}[focused.kind];
    const target=$$('#tbl '+selector).find(el=>focused.kind==='sort'?el.dataset.sort===focused.sort:el.closest('tr')?.dataset.id===focused.id);
    target?.focus({preventScroll:true});
  }
  const n = state.picked.size;
  $('#cmpBtn').disabled = n < 2;
  $('#cmpBtn').textContent = n ? `並排比對（${n}）` : '並排比對';
}
$('#tbl').addEventListener('click', e => {
  const analysis=e.target.closest('[data-analysis-record]');
  if(analysis){openDetail(analysis.dataset.analysisRecord);$('#recordAnalysisDetail')?.scrollIntoView({block:'nearest'});return;}
  const review=e.target.closest('[data-review-record]');
  if(review){openRecordReview(review.dataset.reviewRecord).catch(err=>toast(err.message));return;}
  const s = e.target.closest('[data-sort]');
  if (s){ const k = s.dataset.sort; state.sort = {key:k, dir: state.sort.key===k ? -state.sort.dir : (k==='date'||k==='total'||k==='price'||k==='qty'||k==='dims' ? -1 : 1)}; renderTable(); return; }
  if (e.target.id==='pickAll'){
    const rows = tableRows();
    if (e.target.checked){
      for (const r of rows){ if (state.picked.size>=4) break; state.picked.add(r.id); }
      if (rows.length>4) toast('最多同時比對 4 筆，已選前 4 筆');
    } else rows.forEach(r=>state.picked.delete(r.id));
    renderTable(); return;
  }
  if (e.target.classList.contains('pick')){
    const id = e.target.dataset.id;
    if (e.target.checked){
      if (state.picked.size>=4){ e.target.checked = false; toast('最多同時比對 4 筆'); return; }
      state.picked.add(id);
    } else state.picked.delete(id);
    renderTable(); return;
  }
  const tr = e.target.closest('tbody tr[data-id]');
  if (tr) openDetail(tr.dataset.id);
});
$('#tFilter').addEventListener('input', e => { state.fText = e.target.value; renderTable(); });
$('#supSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-sup]'); if (!b) return;
  state.fSup = b.dataset.sup; $$('#supSeg button').forEach(x=>x.setAttribute('aria-pressed', x===b)); renderTable();
});
$('#famSel').addEventListener('change', e => { state.fFam = e.target.value; renderTable(); });
$('#cmpBtn').addEventListener('click', openCompare);
$('#copyBtn').addEventListener('click', () => {
  const rows = tableRows();
  const H = ['進料日期','供應商','材料種類','材質分類','尺寸1(mm)','尺寸2(mm)','尺寸3(mm)','數量','計價單位','單價','明細金額','整單稅額','整單總計','單號','備註','來源','形狀','直徑(mm)','長度(mm)','數量單位','重量(kg)','計價依據','計價數量','材料費','加工費','交易性質','單價稅別','稅率(%)','分攤稅額','含稅成交金額','含稅成交公斤價'];
  const lines = [H.join('\t')].concat(rows.map(r=>{ const round=r.shape==='round',d=round?['','','']:orderedDims(r.dims); return [r.date, SUP[r.sup].name, r.label, r.grade?famOf(r.grade):'', d[0], d[1], d[2], r.qty, billingUnit(r), r.price, r.amount, r.tax==null?'':r.tax, r.document_total??'', r.doc, r.note, r.src==='real'?'原始單據':r.src==='manual'?'手動輸入':'示範',round?'圓條':'長方體',round?r.dims[0]:'',round?r.dims[1]:'',r.unit,r.weight_kg,billingBasisName(r),billingQuantity(r),r.material_amount,r.processing_fee,...taxExportValues(r)].map(v=>String(v??'').replace(/[\t\r\n]/g,' ')).join('\t'); }));
  const text = lines.map(line=>line.split('\t').map(v=>/^[\s]*[=+@-]/.test(v)?"'"+v:v).join('\t')).join('\n');
  const fallback = () => {
    openDrawer(`<div class="dr-head"><div><div class="eyebrow">Copy</div><h2>手動複製表格</h2><p class="k">這個視窗不允許直接寫入剪貼簿。文字已全選，按 ⌘C 或 Ctrl+C 複製後貼到 Excel。</p></div>${X_BTN}</div><textarea class="copy-area" id="copyArea" readonly>${esc(text)}</textarea>`);
    const ta = $('#copyArea'); ta.focus(); ta.select();
  };
  try {
    navigator.clipboard.writeText(text).then(()=>toast(`已複製 ${rows.length} 筆，可直接貼到 Excel`), fallback);
  } catch(err){ fallback(); }
});

/* ================= drawer: detail & compare ================= */
const X_BTN = `<button class="x-btn" type="button" data-close aria-label="關閉"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
let lastFocus = null;
function openDrawer(html, wide){
  lastFocus = document.activeElement;
  const p = $('#drawerPanel');
  p.setAttribute('aria-label','明細');
  p.className = 'drawer-panel' + (wide ? ' is-wide' : '');
  p.innerHTML = html;
  $('#drawer').hidden = false;
  document.body.classList.add('no-scroll');
  p.scrollTop = 0;
  p.focus();
}
function closeDrawer(){
  $('#drawer').hidden = true;
  document.body.classList.remove('no-scroll');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
$('#drawer').addEventListener('click', e => {
  if (e.target.closest('[data-close]')) closeDrawer();
  const g = e.target.closest('[data-goto]');
  if (g){ closeDrawer(); location.hash = g.dataset.goto; }
  const od = e.target.closest('[data-open]');
  if (od){ openDetail(od.dataset.open); }
});
document.addEventListener('keydown', e => {
  if (e.key==='Escape' && !$('#drawer').hidden) closeDrawer();
  if (e.key==='/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && $('#drawer').hidden){
    e.preventDefault(); location.hash = 'search'; go('search'); focusLookup();
  }
});

function slipView(url, boxes, alt){
  const b = boxes ? Object.entries(boxes).map(([i,[x,y,w,h]])=>`<span class="box" data-i="${i}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"><i class="tag">${i}</i></span>`).join('') : '';
  return `<figure class="slip"><div class="slip-in"><img src="${esc(url)}" alt="${esc(alt||'出貨單')}" loading="lazy">${b}</div></figure>`;
}


const CMP_ROWS = [
  ['供應商', r=>SUP[r.sup].short],
  ['進料日期', r=>r.date],
  ['單號', r=>r.doc],
  ['材料種類', r=>r.label],
  ['材質牌號', r=>r.grade||'—'],
  ['形狀', r=>r.shape==='round'?'圓條':'長方體'],
  ['材質分類', r=>famOf(r.grade)],
  ['尺寸 (mm)', r=>dimStr(r.dims)],
  ['單件體積', r=>cm3(r.dims).toFixed(1)+' cm³'],
  ['數量', r=>money(r.qty)+' '+r.unit],
  ['重量', r=>r.weight_kg==null?'—':money(r.weight_kg)+' 公斤'],
  ['計價依據', billingBasisName],
  ['計價數量', r=>money(billingQuantity(r))+' '+billingUnit(r)],
  ['單價', r=>'NT$ '+money(r.price)+' / '+billingUnit(r)],
  ['計價單位', billingUnit],
  ['原單材料費', r=>money(r.material_amount)],
  ['加工費', r=>money(r.processing_fee)],
  ['明細金額', r=>'NT$ '+money(r.amount)],
  ['營業稅', r=>r.tax==null?'未列':'NT$ '+money(r.tax)],
  ['整單總計', r=>'NT$ '+money(r.document_total)],
  ['交易性質',r=>taxTransactionName(r.analysis_summary?.transaction_type)],
  ['單價稅別',r=>taxBasisName(r.analysis_summary?.tax_basis)],
  ['分攤稅額',r=>money(r.analysis_summary?.allocated_tax)],
  ['含稅成交金額',r=>money(r.analysis_summary?.gross_amount)],
  ['含稅成交公斤價',r=>money(r.analysis_summary?.gross_unit_kg)],
  ['備註', r=>r.note||'—'],
  ['來源', r=>r.src==='real'?'原始單據':r.src==='manual'?'手動輸入':'示範']
];
function openCompare(){
  const rs = [...state.picked].map(id=>records.find(r=>r.id===id)).filter(Boolean);
  if (rs.length < 2) return;
  const head = `<thead><tr><th>欄位</th>${rs.map((r,i)=>`<th>#${i+1} ${supChip(r.sup)}</th>`).join('')}</tr></thead>`;
  const body = CMP_ROWS.map(([label, fn, num])=>{
    const vals = rs.map(fn);
    const diff = new Set(vals).size > 1;
    let lowIdx = -1;
    if (num && diff){ const ns = rs.map(num); const m = Math.min(...ns); lowIdx = ns.indexOf(m); }
    return `<tr class="${diff?'is-diff':''}"><th scope="row">${label}</th>${vals.map((v,i)=>`<td class="${i===lowIdx?'low':''}${/尺寸|單號|日期|體積|單價|金額|稅|數量/.test(label)?' mono':''}">${esc(v)}</td>`).join('')}</tr>`;
  }).join('');
  openDrawer(`
    <div class="dr-head"><div><div class="eyebrow">Compare · 並排比對</div><h2>比對 ${rs.length} 筆進料</h2></div>${X_BTN}</div>
    <div class="cmp-legend"><span><i></i>數值不同的欄位</span><span>比較單價時請一併確認計價單位、日期與加工條件</span></div>
    <div class="cmp-wrap"><table class="cmp">${head}<tbody>${body}</tbody></table></div>
    <div class="dr-sec"><h3>尺寸</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">${rs.map((r,i)=>`<div class="dr-fig"><div class="k">#${i+1} ${esc(r.label)} · <span class="mono">${dimStr(r.dims)}</span></div>${iso(orderedDims(r.dims), null, {w:300, h:170, aria:dimStr(r.dims)})}</div>`).join('')}</div></div>
  `, true);
}

