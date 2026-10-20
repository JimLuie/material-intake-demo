"""Public market data adapters and strict, previewable CSV imports (stdlib only)."""
import csv
import io
import json
import re
import urllib.request
import zipfile
from xml.etree import ElementTree as ET

from analysis import num, valid_date

WB_HOME = 'https://www.worldbank.org/en/research/commodity-markets'
WB_FALLBACK = 'https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx'
CBC_URL = 'https://cpx.cbc.gov.tw/api/OpenData/FTDOpenData_'
MARKET_COLUMNS = ['series', 'label', 'source', 'contract', 'frequency', 'period', 'value', 'currency', 'unit', 'url', 'metal', 'region']
FX_COLUMNS = ['source', 'frequency', 'period', 'value']


ALLOWED_HOSTS = {'www.worldbank.org', 'thedocs.worldbank.org', 'cpx.cbc.gov.tw', 'steelbenchmarker.com', 'www.steelbenchmarker.com'}


def check_origin(url):
    from urllib.parse import urlsplit
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS or parsed.port not in (None, 443):
        raise ValueError('行情來源重新導向至非預期網站')


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_origin(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url):
    # All remote requests have fixed public origins; no user-provided URL is fetched.
    check_origin(url)
    req = urllib.request.Request(url, headers={'User-Agent': 'MaterialDemoLocal/8.0 (local commodity analysis)'})
    with urllib.request.build_opener(PublicRedirect()).open(req, timeout=18) as response:
        check_origin(response.url)
        data = response.read(12*1024*1024+1)
    if len(data) > 12*1024*1024: raise ValueError('行情檔案過大')
    return data


def parse_worldbank(content, url):
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        if sum(x.file_size for x in z.infolist()) > 100*1024*1024: raise ValueError('行情活頁簿過大')
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(e.itertext()) for e in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', ns)]
        book = ET.fromstring(z.read('xl/workbook.xml'))
        sheet = next((s for s in book.findall('m:sheets/m:sheet', ns) if 'monthly' in s.attrib.get('name', '').lower() and 'price' in s.attrib.get('name', '').lower()), None)
        if sheet is None: raise ValueError('找不到世界銀行月價格工作表')
        rel_id = sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        target = next(r.attrib['Target'] for r in rels if r.attrib['Id'] == rel_id)
        target = target.lstrip('/') if target.startswith('/') else 'xl/'+target
        column = None; rows = []; unit_verified = False
        for row in ET.fromstring(z.read(target)).findall('m:sheetData/m:row', ns):
            cells = {}
            for c in row:
                ref = re.sub(r'\d', '', c.attrib.get('r', ''))
                raw = c.find('m:v', ns)
                value = raw.text if raw is not None else ''.join(c.find('m:is', ns).itertext()) if c.find('m:is', ns) is not None else ''
                if c.attrib.get('t') == 's': value = strings[int(value)]
                cells[ref] = str(value or '').strip()
            for col, text in cells.items():
                if text.lower() in ['aluminum', 'aluminium']: column = col
            if column and cells.get(column, '').replace(' ', '').lower() in ['($/mt)', '(us$/mt)', '($/tonne)']: unit_verified = True
            match = re.fullmatch(r'(\d{4})M(\d{2})', cells.get('A', ''))
            if match and column:
                if not unit_verified: raise ValueError('世界銀行鋁價單位未能確認為美元／公噸，保留快取')
                value = num(cells.get(column))
                if value is not None and value >= 0:
                    rows.append(dict(series='wb-aluminium', label='世界銀行鋁月均價', source='World Bank Pink Sheet', contract='Primary aluminium / monthly average', frequency='monthly', period=valid_date('-'.join(match.groups()), True), value=value, currency='USD', unit='tonne', url=url))
    if not rows: raise ValueError('世界銀行資料格式已變動，未讀到鋁價；保留既有快取')
    return rows


def fetch_worldbank():
    url = WB_FALLBACK
    try:
        html = download(WB_HOME).decode()
        found = re.search(r'https://thedocs\.worldbank\.org/[^"\s<>]*CMO-Historical-Data-Monthly\.xlsx', html)
        if found: url = found[0]
    except Exception:
        pass  # Official current-year URL is a fallback when the landing page blocks HTTP clients.
    return parse_worldbank(download(url), url)


def parse_cbc(content, frequency):
    records = json.loads(content); rows = []
    for row in records:
        raw = str(row.get('西元年月') if frequency == 'monthly' else row.get('日期'))
        value = num(row.get('NTD_USD'))
        if len(raw) != (6 if frequency == 'monthly' else 8) or value is None or value <= 0: raise ValueError('中央銀行匯率格式已變動')
        period = raw[:4]+'-'+raw[4:6]+('' if frequency == 'monthly' else '-'+raw[6:])
        rows.append(dict(source='cbc', frequency=frequency, period=valid_date(period, frequency == 'monthly'), value=value))
    if not rows: raise ValueError('中央銀行未回傳匯率')
    return rows


def csv_preview(kind, content, existing):
    reader = csv.DictReader(io.StringIO(content.lstrip('\ufeff')))
    required = set(FX_COLUMNS if kind == 'fx' else MARKET_COLUMNS)-{'url', 'metal', 'region'}
    if not reader.fieldnames or not required <= set(reader.fieldnames): raise ValueError('CSV 缺少必要欄位，請下載範本')
    rows, errors, duplicates, seen = [], [], 0, set()
    identity = lambda r: (r['source'] if kind == 'fx' else r['series'], r['frequency'], r['period'])
    known = {identity(r) for r in existing}
    definitions = {r['series']: (r['source'], r['contract'], r['frequency'], r['currency'], r['unit']) for r in existing} if kind != 'fx' else {}
    metals = {r['series']: r.get('metal', '') for r in existing if r.get('metal')} if kind != 'fx' else {}
    for i, raw in enumerate(reader, 2):
        if i > 10001: raise ValueError('每次最多匯入 10,000 筆')
        try:
            if None in raw: raise ValueError('欄位數量不符，請確認 CSV 引號與逗號')
            r = {k: str(v or '').strip() for k, v in raw.items() if k}
            if r['frequency'] not in ['daily', 'monthly']: raise ValueError('頻率需為 daily 或 monthly')
            r['period'] = valid_date(r['period'], r['frequency'] == 'monthly')
            value = num(r['value'])
            if value is None or value < 0 or (kind == 'fx' and value <= 0): raise ValueError('價格／匯率無效')
            r['value'] = value
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', r['source'] if kind == 'fx' else r['series']): raise ValueError('來源代碼只允許英數字、底線與連字號')
            if kind == 'fx':
                if r['source'] == 'cbc': raise ValueError('cbc 為自動更新保留來源，請另設匯入來源代碼')
            else:
                if r['series'].startswith(('wb-', 'sb-')): raise ValueError('wb-／sb- 為自動更新保留代碼')
                if not r['label'] or not r['source'] or not r['contract']: raise ValueError('請填行情名稱、來源與合約／現貨定義')
                r['metal'] = r.get('metal', '')
                if r['metal'] not in ['', 'aluminum', 'steel']: raise ValueError('metal 需為 aluminum、steel，或留白後明確分類')
                if r['metal'] and r['series'] in metals and r['metal'] != metals[r['series']]: raise ValueError('同一行情代碼不可混合鋁與鋼分類')
                if r['metal']: metals[r['series']] = r['metal']
                if r['currency'] not in ['USD', 'TWD'] or r['unit'] not in ['tonne', 'kg']: raise ValueError('僅接受 USD／TWD 及公噸 tonne／公斤 kg，請勿混用短噸')
                definition = (r['source'], r['contract'], r['frequency'], r['currency'], r['unit'])
                if r['series'] in definitions and definitions[r['series']] != definition: raise ValueError('同一行情代碼不可混合來源、合約、頻率或單位，請另設代碼')
                definitions[r['series']] = definition
                if r.get('url') and not r['url'].startswith('https://'): raise ValueError('來源連結請填 https 網址')
            key = identity(r)
            if key in seen: raise ValueError('CSV 內日期重複，請先刪除重複列')
            seen.add(key)
            if key in known: duplicates += 1
            rows.append(r)
        except (ValueError, KeyError) as e: errors.append({'line': i, 'error': str(e)})
    return dict(rows=rows, errors=errors, duplicates=duplicates)
