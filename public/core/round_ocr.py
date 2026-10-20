"""Column-aware parsers for the synthetic C and D round-bar forms."""
import re

from domain import grouped_lines, norm, number, extract_date, grade_of, pricing_unit, dimension_unit, GRADE_RE

ROUND = re.compile(r"[圓圆圖图][條条棒]\s*(\d+(?:\.\d+)?)(?:\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*[Ll]?)?")
HEADERS = {
    'part_no': ['產品代號', '貨品編號'], 'label': ['產品名稱', '品名規格'],
    'length': ['規格(mm)', '規格'], 'qty': ['數量', '数量'], 'weight': ['重量'],
    'unit': ['單位', '单位'], 'price': ['單價', '单价'],
    'amount': ['金額', '小計註', '小計'], 'order': ['客戶訂單'], 'note': ['備註'],
}


def parse_round_document(result, supplier):
    lines = [line for page in result.get('pages', []) for line in page.get('lines', [])]
    text = '\n'.join(line['text'] for line in lines)
    compact = re.sub(r'\s+', '', norm(text))
    doc = re.search(r'(?:出貨單號|貨單編號)[:：]?(\d{7,16})', compact)
    meta = {'sup': supplier, 'date': extract_date(norm(text)), 'doc': doc[1] if doc else '',
            'subtotal': None, 'tax': None, 'total': None, 'note': ''}
    items, warnings = [], []
    for page in result.get('pages', []):
        rows = grouped_lines(page.get('lines', []))
        material_rows = [row for row in rows if ROUND.search(row['text'])]
        first_y = min((row['cy'] for row in material_rows), default=.4)
        anchors = {}
        for row in rows:
            if not .12 < row['cy'] < first_y:
                continue
            for line in row['lines']:
                clean = re.sub(r'\s+', '', norm(line['text']))
                for field, labels in HEADERS.items():
                    if clean in labels or (field == 'length' and re.fullmatch(r'規格\((?:mm|cm|inch)\)',clean,re.I)):
                        anchors[field] = line['x'] + line['width']/2
        ordered = sorted(anchors, key=anchors.get)

        def cells(row, field):
            if field not in anchors:
                return []
            index = ordered.index(field)
            low = (anchors[ordered[index-1]]+anchors[field])/2 if index else 0
            high = (anchors[ordered[index+1]]+anchors[field])/2 if index+1 < len(ordered) else 1
            return [line for line in row['lines'] if low <= line['x']+line['width']/2 < high]

        def numeric(row, field):
            for line in sorted(cells(row, field), key=lambda v: -v.get('confidence', 0)):
                value = number(line['text'].strip().rstrip('.'))
                if value is not None:
                    return value
            return None

        for row in material_rows:
            # Require the product description to occur below the actual table headings.
            if not anchors or row['cy'] <= max((line['y'] for line in page['lines'] if re.sub(r'\s+', '', norm(line['text'])) in HEADERS['qty']), default=0):
                continue
            match = ROUND.search(row['text'])
            diameter = float(match[1])
            length = float(match[2]) if match[2] else numeric(row, 'length')
            label_cells = cells(row, 'label')
            label = next((line['text'] for line in label_cells if ROUND.search(line['text'])), match[0])
            parts = cells(row, 'part_no')
            part = parts[0]['text'].strip() if parts else ''
            # This form prints D followed by the diameter; OCR often reads its digit 1 as I.
            if supplier == 'zm' and re.fullmatch(r'D[\dIOil]+', part):
                corrected = part.translate(str.maketrans({'I': '1', 'i': '1', 'l': '1', 'O': '0'}))
                if corrected != part:
                    warnings.append('料號的 I／1 字元已按欄位格式校正，請核對原圖。')
                part = corrected
            unit_text = next((line['text'].strip(' -').upper() for line in cells(row, 'unit') if line['text'].strip(' -').upper() in ['PC', 'PCS', 'KG', '件', '公斤', '支', '片', '張', '組', '公尺']), '')
            # Only explicit material text can supply the grade; part numbers are excluded.
            material = re.search(r'(?<![A-Z0-9-])(?:'+GRADE_RE.pattern+r')(?![A-Z0-9-])',label,re.I)
            items.append({'label': label, 'grade': grade_of(material[0]) if material else '', 'part_no': part,
                          'shape': 'round', 'dims': [diameter, length], 'dim_unit': dimension_unit(label+' '+next((line['text'] for line in page['lines'] if re.match(r'規格',line['text'])),'')),
                          'qty': numeric(row, 'qty'), 'unit': pricing_unit(unit_text),
                          'price': numeric(row, 'price'), 'amount': numeric(row, 'amount'),
                          'note': '', 'page': page['number'], 'row_y': row['cy'], 'raw': row['text']})

        last_material_y = max((row['cy'] for row in material_rows), default=first_y)
        for row in rows:
            if row['cy'] <= last_material_y:
                continue
            label = re.sub(r'\s+', '', row['text'])
            # Read footer values from the money column. A quantity-column total is never money.
            value = numeric(row, 'amount')
            if value is None:
                continue
            if '營業稅' in label:
                meta['tax'] = value
            elif '總計' in label:
                meta['total'] = value
            elif '合計' in label or '小計' in label:
                meta['subtotal' if supplier == 'zm' else 'total'] = value
    if not items:
        items = [{'label': '', 'grade': '', 'part_no': '', 'shape': 'round', 'dims': [None, None],
                  'dim_unit': 'mm', 'unit': '件', 'qty': None, 'price': None, 'amount': None, 'page': 1, 'raw': '', 'note': ''}]
        warnings.append('沒有可靠地拆出圓條材料列，請對照原圖補填。')
    warnings.append('請逐筆核對原圖；未註明尺寸單位預設 mm、計價單位預設件；材質與金額未列則留白。')
    if meta['subtotal'] is not None and meta['tax'] is not None and meta['total'] is not None:
        if abs(meta['subtotal']+meta['tax']-meta['total']) > .02:
            warnings.append('整單總計與小計＋稅額不符，請核對原圖。')
    return {'meta': meta, 'items': items, 'warnings': list(dict.fromkeys(warnings)), 'text': text}
