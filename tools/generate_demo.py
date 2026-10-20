#!/usr/bin/env python3
"""Build public demo data and flattened documents from invented source data only.

No production files, images, databases, OCR observations or transaction values are
read by this generator. Run with Python + Pillow. All visible fields and OCR
coordinates are drawn from the same source of truth as the seeded drafts.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import sys
import time
from decimal import Decimal, ROUND_HALF_UP
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'
ASSETS = PUBLIC / 'assets'
FIXTURES = ROOT / 'tests' / 'fixtures'
W, H = 1440, 900
SUPPLIERS = {
    'hh': ('示範鋁材一廠股份有限公司', '示範鋁材一廠', 'A', '#d8eeee', '#315f65'),
    'sk': ('示範鋼材二廠有限公司', '示範鋼材二廠', 'B', '#fff5be', '#486962'),
    'zf': ('示範鋁業三廠股份有限公司', '示範鋁業三廠', 'C', '#f4dfe7', '#725861'),
    'zm': ('示範金屬四廠', '示範金屬四廠', 'D', '#deecda', '#4a705e'),
}
FONT_CANDIDATES = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--font', help='Path to an installed CJK .ttf/.ttc font')
args = parser.parse_args()
FONT = args.font or next((p for p in FONT_CANDIDATES if Path(p).exists()), None)
TITLE_FONT = FONT
if not FONT:
    raise SystemExit('A CJK font is required. Pass --font with an installed CJK font.')


@lru_cache(maxsize=32)
def font(size, title=False):
    return ImageFont.truetype(TITLE_FONT if title else FONT, size)


def cash(value):
    if value is None:
        return ''
    return f'{value:,.2f}'.rstrip('0').rstrip('.')


def exact(value):
    return float(Decimal(str(value)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP))


def item(grade, dims, qty, price, *, shape='rect', weight=None, fee=None,
         customer=False, label=None, part='', note='', page=1):
    price = exact(price) if price is not None else None
    basis = 'weight' if weight is not None and weight > 0 else 'quantity'
    material = None if customer else exact(Decimal(str(price)) * Decimal(str(weight if basis == 'weight' else qty)))
    amount = None if customer else exact(Decimal(str(material)) + Decimal(str(fee or 0)))
    return dict(label=label or (f'{grade} 圓條{dims[0]}' if shape == 'round' else grade),
                grade=grade, part_no=part, shape=shape, dims=dims, dim_unit='mm',
                qty=qty, unit='件', price=None if customer else price,
                amount=amount, weight_kg=weight, material_amount=material,
                processing_fee=fee, pricing_basis=basis, note=note, page=page,
                raw='', confidence=1)


def invented_documents():
    """Fresh, intentionally invented quantities, dimensions, dates and prices."""
    out = []
    for month in range(1, 7):
        for supplier_index, supplier in enumerate(SUPPLIERS):
            seq = (month-1)*4 + supplier_index + 1
            date = f'2026-{month:02d}-{7+supplier_index*4:02d}'
            if supplier == 'hh':
                rows = [item('7075', [12, 28, 94], 144+month*8, 18.4+month*.35),
                        item('6061', [16, 44, 126], 72+month*6, 29.7+month*.4,
                             page=2 if month == 2 else 1)]
            elif supplier == 'sk':
                rows = [item('S50C', [22, 54, 146], 9+month, 82+month*3,
                             weight=exact(13.2+month*.8), fee=225+month*15,
                             note='銑4' if month == 1 else '示範切削'),
                        item('S45C' if month%2 else 'SUS304', [18, 36, 164],
                             24+month*3, 96+month*2,
                             fee=0 if month == 2 else None,
                             note='銑4' if month == 1 else '')]
            elif supplier == 'zf':
                rows = [item('', [64+month*2, 118+month*6], 180+month*12,
                             None, shape='round', customer=True,
                             label=f'客供料 圓條{64+month*2}', part=f'DEMO-P{300+month}')]
            else:
                rows = [item('6061', [96+month*2, 38+month], 96+month*5,
                             58+month*1.5, shape='round', part=f'DEMO-D{96+month*2}'),
                        item('7075', [42+month*2, 132+month*3], 48+month*4,
                             78+month*2, shape='round', part=f'DEMO-R{42+month*2}')]
            out.append(make_spec(supplier, seq, date, rows))
    for n, supplier in enumerate(SUPPLIERS):
        source = copy.deepcopy(next(d for d in out if d['supplier'] == supplier))
        rows = source['items']
        for row in rows:
            row['page'] = 1
        pending = make_spec(supplier, 25+n, f'2026-07-{5+n*3:02d}', rows, status='pending')
        pending['note'] = '待核對的虛構單據，可練習逐筆確認。'
        out.append(pending)
    out.append(make_spec('sk', 29, '2026-07-21', [item('', [10, 10, 80], 4, 275,
               label='示範鎢鋼銑刀', note='待分類：刀具')], status='pending', bucket='review', category='tools'))
    out.append(make_spec('hh', 30, '2026-07-23', [item('', [20, 20, 50], 6, 148,
               label='示範清潔劑', note='待分類：耗材')], status='pending', bucket='review', category='consumables'))
    out.append(make_spec('zm', 31, '2026-07-26', [item('6061', [56, 152], 20, 88,
               shape='round', part='DEMO-VOID')], status='pending', bucket='trash'))
    return out


def make_spec(supplier, seq, date, rows, status='done', bucket='materials', category=''):
    customer = supplier == 'zf'
    gross = supplier == 'sk'
    subtotal = None if customer else exact(sum(Decimal(str(r['amount'])) for r in rows))
    tax = None if customer or gross else float((Decimal(str(subtotal)) * Decimal('.05')).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    total = None if customer else exact(Decimal(str(subtotal)) + Decimal(str(tax or 0)))
    m, day = date[5:7], date[8:10]
    doc = (f'126{m}{day}N{4100+seq:04d}' if supplier == 'hh' else
           f'2026{m}{day}{400+seq:03d}' if supplier == 'sk' else
           f'026{m}{day}{5100+seq:04d}' if supplier == 'zf' else f'26{m}{day}{6100+seq:04d}')
    return dict(supplier=supplier, sequence=seq, date=date, doc=doc, items=rows,
                status=status, bucket=bucket, category=category, subtotal=subtotal,
                tax=tax, total=total, note='本單全部內容為虛構示範資料，不作交易使用。',
                tax_settings=dict(transaction_type='customer_supplied' if customer else 'purchase',
                                  tax_basis='unknown' if customer else 'included' if gross else 'pretax',
                                  tax_rate=5, source='synthetic_seed',
                                  evidence='虛構示範單據；客供料不計採購金額。' if customer else
                                  '虛構示範單據；所有品項單價已含稅。' if gross else
                                  '虛構示範單據；明細未稅，另列營業稅 5%。'))


def invented_quotes():
    """Three fictional offers, using validate_quote's public input schema."""
    offers = [
        dict(sup='hh', grade='7075', temper='T651', shape='rect', dims=[14,32,108],
             qty=180, price=21.5, material_amount=3870, processing_fee=0,
             amount=3870, tax_basis='pretax', fee_zero=True),
        dict(sup='sk', grade='S50C', temper='', shape='rect', dims=[24,58,152],
             qty=12, price=92, weight_kg=16.8, pricing_basis='weight',
             material_amount=1545.6, processing_fee=260, amount=1805.6,
             tax_basis='included', fee_zero=False),
        dict(sup='zm', grade='6061', temper='T6', shape='round', dims=[104,42],
             qty=120, price=63.25, material_amount=7590, processing_fee=120,
             amount=7710, tax_basis='pretax', fee_zero=False),
    ]
    for index, offer in enumerate(offers,1):
        offer.update(client_id=hashlib.sha256(f'material-demo-v1:quote-{index}'.encode()).hexdigest()[:32],
                     doc=f'DEMO-Q-{index:03d}', date='2026-10-18', valid_until='2026-11-18',
                     unit='件', tax_rate=5, note='虛構示範報價，不構成實際商業要約。')
        offer.setdefault('pricing_basis','quantity')
    return offers


class Sheet:
    def __init__(self, spec, page):
        self.spec, self.page = spec, page
        name, _, letter, paper, ink = SUPPLIERS[spec['supplier']]
        self.ink, self.paper = ink, paper
        self.image = Image.new('RGB', (W, H), paper)
        self.draw = ImageDraw.Draw(self.image)
        self.lines = []
        rng = random.Random(f'{spec["doc"]}-{page}')
        # New digital paper texture, generated without sampling any source image.
        for _ in range(17000):
            x,y = rng.randrange(W),rng.randrange(H)
            base = self.image.getpixel((x,y))
            delta = rng.choice([-3,-2,2,3])
            self.draw.point((x,y), fill=tuple(min(255,max(0,c+delta)) for c in base))
        for x in (28, W-28):
            for y in range(28, H, 69):
                self.draw.ellipse((x-11,y-11,x+11,y+11), fill='#fffef9', outline='#d2d8cf')
        self.draw.line((55,0,55,H), fill=ink, width=1)
        self.draw.line((W-55,0,W-55,H), fill=ink, width=1)
        self.draw.rounded_rectangle((80,28,165,107), radius=5, outline=ink, width=3)
        self.text(f'DEMO {letter}', 89, 47, 19, capture=False)
        self.draw.line((92,82,151,82), fill=ink, width=3)
        self.text(name, 205, 24, 35, title=True)
        self.text('出  貨  單' if spec['supplier'] != 'zm' else '銷  貨  單', 610, 76, 32, title=True)
        self.text('虛構供應商・公開展示用', 205, 78, 17)
        self.text(f'電話：00-0000-000{list(SUPPLIERS).index(spec["supplier"])+1}（示範）', 955, 28, 18)
        self.text('地址：示範市虛構區材料路 0 號', 955, 57, 18)
        self.text('聯絡人：範例聯絡員', 955, 86, 18)
        self.draw.line((80,119,1360,119),fill=ink,width=2)
        self.text('客戶名稱：範例製造所（虛構）', 85, 136, 21)
        self.text('統一編號：00000000（非營業資料）', 85, 168, 18)
        self.text('聯絡地址：示範市練習區工藝路 0 號', 85, 197, 18)
        self.text(f'日期：{spec["date"]}', 820, 136, 21)
        self.text(('貨單編號' if spec['supplier']=='zm' else '出貨單號')+f'：{spec["doc"]}',820,168,19)
        self.text(f'頁次：{page} / {max(i["page"] for i in spec["items"])}   |   客戶代號：DEMO-000',820,197,17)

    def text(self, text, x, y, size=21, title=False, capture=True, color=None):
        text = str(text)
        if not text:
            return
        f = font(size,title)
        self.draw.text((x,y), text, font=f, fill=color or self.ink)
        if capture:
            box = self.draw.textbbox((x,y),text,font=f)
            # Keep a common baseline across numeric and Chinese cells of one row.
            self.lines.append(dict(text=text,x=round(x/W,6),y=round(y/H,6),
                                   width=round((box[2]-box[0])/W,6),height=round(size/H,6),confidence=1))

    def centered(self, text, left, right, y, size=19):
        width=self.draw.textlength(str(text),font=font(size))
        self.text(text,(left+right-width)/2,y,size)

    def table(self, columns, items, top=231, bottom=670, row_step=63, right_notes=False):
        left,right=columns[0][1],columns[-1][2]
        self.draw.rectangle((left,top,right,bottom),outline=self.ink,width=2)
        for _,x,_ in columns[1:]:
            self.draw.line((x,top,x,bottom),fill=self.ink,width=1)
        self.draw.line((left,top+37,right,top+37),fill=self.ink,width=2)
        for label,x,xx in columns:
            self.centered(label,x,xx,top+7,18)
        body_y=top+49
        for index, row in enumerate(items):
            y=body_y+index*row_step
            values=self.values(row)
            for key,x,xx in columns:
                value=values.get(key,'')
                size=18 if xx-x < 100 else 20
                if key in ['產品名稱','品名規格','產品代號','貨品編號']:
                    self.text(value,x+9,y,size)
                else:
                    self.centered(value,x,xx,y,size)
            row['row_y']=round((y+10)/H,6)
            row['raw']=' '.join(str(values.get(key,'')) for key,_,_ in columns if values.get(key,'')!='')
            if self.spec['supplier'] in ('zf','zm') or index+1<len(items):
                self.draw.line((left,y+37,right,y+37),fill=self.ink,width=1)
        for y in range(top+100,bottom-20,row_step):
            if self.spec['supplier']=='zf':
                self.draw.line((left,y,right,y),fill=self.ink,width=1)
        if right_notes:
            self.draw.line((1050,top,1050,bottom),fill=self.ink,width=1)
            for index, text in enumerate(['第一聯：客戶留存','示範文件・不作交易使用','尺寸與數量請逐筆核對','全部資料均為虛構','所有金額僅供系統操作展示']):
                self.text(text,1064,top+51+index*47,16)

    def values(self, row):
        dims=' x '.join(cash(v) for v in row['dims'])
        label=(row['label']+' '+dims+' mm') if row['shape']=='rect' else row['label']
        note=row['note']
        amount=cash(row['amount'])
        if self.spec['supplier']=='sk' and note:
            amount+=' '+note
        return {'產品名稱':label,'材質':row['label'],'厚度':cash(row['dims'][0]),
                '寬度':cash(row['dims'][1]),'長度':cash(row['dims'][2]) if len(row['dims'])==3 else '',
                '數量':cash(row['qty']),'重量':cash(row['weight_kg']),
                '單位':'PCS','單價':cash(row['price']),'材料費':cash(row['material_amount']),
                '加工費':cash(row['processing_fee']),'金額':amount,'合計':amount,
                '產品代號':row['part_no'],'貨品編號':row['part_no'],
                '品名規格':row['label']+' x '+cash(row['dims'][1])+'L' if row['shape']=='round' else label,
                '規格(mm)':cash(row['dims'][1]),'客戶訂單':'DEMO-ORDER','備註':'客供料' if self.spec['supplier']=='zf' else ''}

    def finish(self, final_page):
        s=self.spec
        if s['supplier']=='zf':
            self.text('特殊說明：客供料；本單無採購價款，數量合計不是金額。',85,700,21)
            self.text('數量合計',635,735,21)
            self.centered(cash(sum(i['qty'] for i in s['items'])),765,860,735,21)
        else:
            self.text('備註：'+s['note'],85,704,17)
            self.text('單價已含稅' if s['supplier']=='sk' else '單價未稅・營業稅另計',85,739,19)
            if final_page:
                labels=[('小計',s['subtotal']),('營業稅',s['tax']),('總計',s['total'])]
                for n,(label,value) in enumerate(labels):
                    self.text(label,1020,695+n*35,20)
                    self.text(cash(value),1180,695+n*35,21)
            else:
                self.text('金額彙總請見末頁',1050,718,20)
        self.draw.line((80,814,1360,814),fill=self.ink,width=1)
        self.text('製單：示範文員',85,834,17)
        self.text('覆核：範例核對員',400,834,17)
        self.text('收貨：公開體驗者',760,834,17)
        self.text('DEMO / 非正式憑證',1120,834,16)
        watermark=Image.new('RGBA',(W,H),(0,0,0,0))
        wd=ImageDraw.Draw(watermark)
        wd.text((290,360),'DEMO · 虛構示範',font=font(96),fill=(80,95,90,25))
        watermark=watermark.rotate(14,resample=Image.Resampling.BICUBIC,center=(W/2,H/2))
        self.image=Image.alpha_composite(self.image.convert('RGBA'),watermark).convert('RGB')
        return self.image,dict(number=self.page,width=W,height=H,preview=f'page-{self.page}.jpg',lines=self.lines)


def render(spec, number):
    sheet=Sheet(spec,number)
    items=[r for r in spec['items'] if r['page']==number]
    s=spec['supplier']
    if s=='hh':
        columns=[('產品名稱',80,640),('數量',640,730),('單位',730,790),('單價',790,910),('金額',910,1050)]
        sheet.table(columns,items,right_notes=True)
        sheet.draw.rectangle((1050,231,1360,670),outline=sheet.ink,width=2)
    elif s=='sk':
        columns=[('材質',80,225),('厚度',225,335),('寬度',335,445),('長度',445,555),
                 ('數量',555,650),('重量',650,750),('單價',750,855),('材料費',855,1005),
                 ('加工費',1005,1135),('合計',1135,1360)]
        sheet.table(columns,items)
        sheet.text('==== 以下空白 ====',115,460,22)
    elif s=='zf':
        columns=[('產品代號',80,260),('產品名稱',260,635),('規格(mm)',635,765),('數量',765,860),
                 ('重量',860,950),('單位',950,1020),('單價',1020,1120),('金額',1120,1240),('備註',1240,1360)]
        # The round-form parser expects the literal 產品名稱 heading.
        original=sheet.values
        sheet.values=lambda row: dict(original(row),**{'產品名稱':row['label']})
        sheet.table(columns,items)
    else:
        columns=[('貨品編號',80,270),('品名規格',270,770),('數量',770,890),('單位',890,980),
                 ('單價',980,1130),('金額',1130,1360)]
        sheet.table(columns,items)
    return sheet.finish(number==max(i['page'] for i in spec['items']))


def main():
    ASSETS.mkdir(parents=True,exist_ok=True)
    FIXTURES.mkdir(parents=True,exist_ok=True)
    # Only remove this generator's prior numbered output when source rows change.
    for pattern in ('demo-[abcd]-[0-9][0-9][0-9]-page-*.png','demo-[abcd]-[0-9][0-9][0-9].pdf'):
        for generated in ASSETS.glob(pattern):
            generated.unlink()
    documents=[]
    samples=[]
    fixture_docs={}
    for spec in invented_documents():
        identifier=hashlib.sha256(('material-demo-v1:'+spec['doc']).encode()).hexdigest()[:32]
        _,short,letter,_,_=SUPPLIERS[spec['supplier']]
        basename=f'demo-{letter.lower()}-{spec["sequence"]:03d}'
        pages=[]
        ocr=dict(engine='示範資料產生器 · 人工校準座標（虛構）',pages=[])
        images=[]
        for number in range(1,max(i['page'] for i in spec['items'])+1):
            picture,page=render(spec,number)
            filename=f'{basename}-page-{number}.png'
            picture.save(ASSETS/filename,optimize=True)
            pages.append(dict(number=number,url='/assets/'+filename))
            ocr['pages'].append(page)
            images.append(picture)
        text='\n'.join(line['text'] for p in ocr['pages'] for line in p['lines'])
        draft=dict(meta={key:spec[key] for key in ['date','doc','subtotal','tax','total','note']},
                   items=spec['items'],warnings=[],text=text,tax_settings=spec['tax_settings'])
        draft['meta']['sup']=spec['supplier']
        original=pages[0]['url']
        extension='.png'
        if len(images)>1:
            pdf=f'{basename}.pdf'
            images[0].save(ASSETS/pdf,'PDF',save_all=True,append_images=images[1:],resolution=150,
                           title='虛構材料單據 DEMO',author='材料進料帳 Demo',
                           creationDate=time.gmtime(1767225600),modDate=time.gmtime(1767225600))
            original='/assets/'+pdf
            extension='.pdf'
        documents.append(dict(id=identifier,name=f'DEMO-{letter}_{spec["date"]}_{spec["sequence"]:03d}{extension}',
                              extension=extension,status=spec['status'],draft=draft,ocr=ocr,
                              pages=pages,original=original,bucket=spec['bucket'],category=spec['category'],note=spec['note']))
        if spec['supplier'] not in fixture_docs:
            fixture_docs[spec['supplier']]=copy.deepcopy(ocr)
            images[0].save(ASSETS/f'slip-{letter.lower()}.jpg',quality=94,subsampling=0)
            samples.append((letter,images[0]))
    samples.sort(key=lambda v:v[0])
    samples[0][1].save(ASSETS/'demo-samples.pdf','PDF',save_all=True,
                       append_images=[im for _,im in samples[1:]],resolution=150,
                       title='四種虛構單據 · 公開 Demo',author='材料進料帳 Demo',
                       creationDate=time.gmtime(1767225600),modDate=time.gmtime(1767225600))
    market_cache=json.loads((PUBLIC/'market-seed.json').read_text()) if (PUBLIC/'market-seed.json').exists() else {'market':[],'fx':[]}
    seed=dict(version=1,documents=documents,quotes=invented_quotes(),market=market_cache['market'],fx=market_cache['fx'])
    (PUBLIC/'demo-seed.json').write_text(json.dumps(seed,ensure_ascii=False,indent=2)+'\n')
    for vendor,ocr in fixture_docs.items():
        (FIXTURES/f'{vendor}.json').write_text(json.dumps(ocr,ensure_ascii=False,indent=2)+'\n')
    (FIXTURES/'sk_fees.json').write_text(json.dumps(fixture_docs['sk'],ensure_ascii=False,indent=2)+'\n')
    split=copy.deepcopy(fixture_docs['hh'])
    for page in split['pages']:
        rebuilt=[]
        for line in page['lines']:
            if line['text'] in ('單價','金額'):
                for index,char in enumerate(line['text']):
                    rebuilt.append(dict(line,text=char,x=round(line['x']+index*line['width']/2,6),width=round(line['width']/2,6)))
            else:
                rebuilt.append(line)
        page['lines']=rebuilt
    (FIXTURES/'hh-split-header.json').write_text(json.dumps(split,ensure_ascii=False,indent=2)+'\n')
    confirmed=[d for d in documents if d['status']=='done']
    print(json.dumps(dict(documents=len(documents),confirmed=len(confirmed),
                          confirmed_records=sum(len(d['draft']['items']) for d in confirmed),
                          pending=sum(d['status']=='pending' and d['bucket']=='materials' for d in documents),
                          assets=str(ASSETS),seed=str(PUBLIC/'demo-seed.json')),ensure_ascii=False))


if __name__=='__main__':
    main()
