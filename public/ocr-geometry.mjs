// Convert Tesseract word boxes to the column observations used by the ledger.
const HEADERS=new Set(['材質','厚度','寬度','長度','數量','重量','單價','金額','合計','含計','總計','小計','材料費','加工費','單位','營業稅','產品名稱','產品代號','品名規格','客戶訂單','貨品編號','規格']);
export function observations(data,width,height){
  const result=[];
  for(const block of data.blocks||[])for(const paragraph of block.paragraphs||[])for(const line of paragraph.lines||[]){
    const words=line.words||[];
    for(let i=0;i<words.length;i++){
      let word=words[i],text=word.text.trim(),b={...word.bbox},confidence=word.confidence;
      if(!text)continue;
      // Traditional text can be segmented one glyph per word. Join known labels
      // only across a small gap; never join numbers from neighboring columns.
      for(let j=i+1;j<Math.min(i+7,words.length)&&/^[\u3400-\u9fff]+$/.test(text);j++){
        if(words[j].bbox.x0-b.x1>Math.max(16,height*.035))break;
        text+=words[j].text.trim();
        if(HEADERS.has(text)){
          b.x1=words[j].bbox.x1;b.y0=Math.min(b.y0,words[j].bbox.y0);b.y1=Math.max(b.y1,words[j].bbox.y1);confidence=Math.min(confidence,words[j].confidence);i=j;break;
        }
      }
      // Keep the original text unless a recognized compound label was joined.
      if(!HEADERS.has(text))text=word.text.trim();
      result.push({text,confidence:Math.max(0,Math.min(1,confidence/100)),x:b.x0/width,y:b.y0/height,width:(b.x1-b.x0)/width,height:(b.y1-b.y0)/height});
    }
  }
  return result;
}
