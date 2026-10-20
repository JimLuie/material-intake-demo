"""SteelBenchmarker China observations, extracted with the separate macOS PDFKit helper."""
from datetime import datetime
import json
from pathlib import Path
import re
import subprocess
import tempfile

HISTORY_URL = 'https://www.steelbenchmarker.com/history2.pdf'
RECENT_URL = 'https://steelbenchmarker.com/history.pdf'
SERIES = ('sb-china-hrb', 'sb-china-plate')


def pdf_pages(content):
    helper = Path(__file__).resolve().parent/'.build/market-text'
    if not helper.is_file(): raise ValueError('請重新啟動程式以準備行情 PDF 文字工具')
    if not content.startswith(b'%PDF-'): raise ValueError('鋼價來源不是 PDF，保留快取')
    with tempfile.TemporaryDirectory(prefix='material-demo-steel-') as folder:
        path = Path(folder)/'market.pdf'; path.write_bytes(content)
        result = subprocess.run([str(helper), str(path)], capture_output=True, timeout=45)
    if result.returncode: raise ValueError('鋼價 PDF 文字讀取失敗，保留快取')
    return json.loads(result.stdout)['pages']


def parse_steel(pages, url):
    rows = {}; found = False
    date_pattern = r'\d{1,2}-[A-Za-z]{3}-\d{2}'
    for page in pages:
        text = page['text'].replace('\u2212', '-')
        if not re.search(r'^China\s*$', text, re.M) or not re.search(r'^'+date_pattern+r'\s', text, re.M): continue
        found = True
        if not re.search(r'^Ex-works\s*$', text, re.M) or not re.search(r'^Dollars per Metric Tonne\s*$', text, re.M):
            raise ValueError('中國鋼價地區／出廠／美元公噸表頭改變，保留快取')
        if not re.search(r'HRB[^\n]*CRC[^\n]*Plate[^\n]*Rebar', text) or not re.search(r'Price\s+Chng', text):
            raise ValueError('中國鋼價欄位順序改變，保留快取')
        matches = list(re.finditer(r'^('+date_pattern+r')\s+(.+)', text, re.M))
        for match in matches:
            # PDFKit may wrap a row, but continuation lines contain only numeric cells.
            tail = text[match.end():].lstrip('\r\n').splitlines(); cells = match[2].split()
            for line in tail:
                if len(cells) >= 12: break
                tokens = line.split()
                if not tokens or any(not re.fullmatch(r'[-+\d.,%]+|N/?A|na', t, re.I) for t in tokens): break
                cells.extend(tokens)
            if len(cells) not in (4, 12): raise ValueError('中國鋼價列欄數改變，保留快取：'+match[1])
            if len(cells) == 4 and match[1] != '10-Apr-06': raise ValueError('中國鋼價漲跌欄缺漏，保留快取')
            if len(cells) == 12 and any(not (cells[i].endswith('%') or cells[i].lower() in ('-', 'na', 'n/a')) for i in (2, 5, 8, 11)):
                raise ValueError('中國鋼價百分比欄位錯位，保留快取')
            # Four prices in the first baseline row, otherwise price/change/% for each product.
            prices = [cells[i] for i in ((0, 2) if len(cells) == 4 else (0, 6))]
            period = datetime.strptime(match[1], '%d-%b-%y').date().isoformat()
            for series, raw in zip(SERIES, prices):
                if raw.lower() in ('na', 'n/a', '-'): continue
                if not re.fullmatch(r'\d[\d,]*(?:\.\d+)?', raw): raise ValueError('中國鋼價價格欄無效')
                value = float(raw.replace(',', ''))
                if not 0 < value < 10000: raise ValueError('中國鋼價價格超出合理解析範圍')
                key = (series, period)
                if key in rows and rows[key]['value'] != value: raise ValueError('同日鋼價資料衝突，保留快取')
                plate = series == SERIES[1]
                rows[key] = dict(series=series, label='中國'+('標準鋼板' if plate else '熱軋鋼材')+'出廠參考價',
                    source='SteelBenchmarker / SteelHome', product='Standard Plate' if plate else 'Hot-rolled Band (HRB)',
                    contract='Ex-works / spot reference', region='China', metal='steel', frequency='daily',
                    observation_frequency='semi-monthly', period=period, value=value, currency='USD', unit='tonne',
                    url=url, source_page=page['number'])
    if not found or not rows or any(not any(r['series'] == s for r in rows.values()) for s in SERIES):
        raise ValueError('未找到完整中國 HRB／標準鋼板價格，保留快取')
    return sorted(rows.values(), key=lambda r: (r['series'], r['period']))


def fetch_steel(full=False):
    from market_data import download
    rows = {}
    for url in ([HISTORY_URL, RECENT_URL] if full else [RECENT_URL]):
        try: content = download(url)
        except OSError:
            # Same publisher and file; the bare host occasionally fails DNS on macOS.
            if url != RECENT_URL: raise
            url = 'https://www.steelbenchmarker.com/history.pdf'
            content = download(url)
        for row in parse_steel(pdf_pages(content), url): rows[(row['series'], row['period'])] = row
    return list(rows.values())
