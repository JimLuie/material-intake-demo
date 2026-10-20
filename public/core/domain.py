"""Local document parsing and material lookup. No network calls or model prompts."""
import math
import copy
import re
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation
from billing import infer_pricing_basis

SUPPLIERS = {
    "hh": {"name": "示範鋁材一廠股份有限公司", "short": "示範鋁材一廠"},
    "sk": {"name": "示範鋼材二廠有限公司", "short": "示範鋼材二廠"},
    "zf": {"name": "示範鋁業三廠股份有限公司", "short": "示範鋁業三廠"},
    "zm": {"name": "示範金屬四廠", "short": "示範金屬四廠"},
}
GRADES = {
    **dict.fromkeys(["7075", "6061", "6063", "5083", "5052", "2017", "2024"], "鋁合金"),
    **dict.fromkeys(["S45C", "S50C", "S55C", "SS400"], "碳鋼"),
    **dict.fromkeys(["SCM440", "SCM415"], "合金鋼"),
    **dict.fromkeys(["SKD11", "SKD61", "NAK80", "P20", "DC53"], "模具鋼"),
    **dict.fromkeys(["SUS304", "SUS303", "SUS316", "SUS316L"], "不鏽鋼"),
}
GRADE_RE = re.compile(r"SUS\s*\d{3}L?|SCM\s*\d{3}|SKD\s*\d{1,2}|NAK\s*\d{2}|SS\s*\d{3}|S\s*\d{2}C|P20|DC53|(?<!\d)(?:7075|6061|6063|5083|5052|2017|2024)(?:-?T\d+)?(?!\d)", re.I)
DIM_RE = re.compile(r"(?<![\d.-])(\d+(?:\.\d+)?)\s*[xX×*✕]\s*(\d+(?:\.\d+)?)\s*[xX×*✕]\s*(\d+(?:\.\d+)?)")
NUM_RE = re.compile(r"(?<![A-Za-z])\d[\d,]*(?:\.\d+)?")


def pricing_unit(value):
    value = str(value or "").strip()
    return {"PC": "件", "PCS": "件", "KG": "公斤"}.get(value.upper(), value) or "件"


def dimension_unit(text):
    match = re.search(r'(?<![A-Za-z])(mm|cm|inch)(?![A-Za-z])|英吋', norm(text), re.I)
    return ('inch' if match[0] == '英吋' else match[0].lower()) if match else 'mm'


def default_units(draft):
    draft = copy.deepcopy(draft)
    for item in draft.get("items", []):
        item["dim_unit"] = str(item.get("dim_unit") or "").strip() or "mm"
        item["unit"] = pricing_unit(item.get("unit"))
    return draft


def material_volume(dims, shape="rect"):
    return math.pi * dims[0] ** 2 * dims[1] / 4 if shape == "round" else math.prod(dims)


def norm(text):
    return unicodedata.normalize("NFKC", str(text or "")).replace("，", ",").replace("×", "x")


def grade_of(text):
    text = norm(text).upper()
    text = re.sub(r"S\s*5[O0]\s*C", "S50C", text)
    match = GRADE_RE.search(text)
    return re.sub(r"\s+", "", match[0]) if match else ""


def number(text):
    text = norm(text).strip().replace(",", "").replace(" ", "")
    try:
        value = float(text)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError):
        return None


def grouped_lines(lines):
    """Group OCR observations by baseline, keeping the higher confidence duplicate."""
    cleaned = []
    for raw in lines:
        line = dict(raw, text=norm(raw["text"]))
        near = next((p for p in cleaned if abs(p["x"]-line["x"]) < .012 and abs(p["y"]-line["y"]) < .007 and abs(p["width"]-line["width"]) < .025), None)
        if near:
            # A valid grade/dimension is stronger evidence than OCR's often saturated score.
            score = lambda p: (bool(DIM_RE.search(p["text"])), bool(grade_of(p["text"])), p.get("confidence", 0), len(p["text"]))
            if score(line) > score(near):
                near.update(line)
        else:
            cleaned.append(line)
    rows = []
    for line in sorted(cleaned, key=lambda p: p["y"] + p["height"]/2):
        cy = line["y"]+line["height"]/2
        target = next((r for r in rows if abs(r["cy"]-cy) < max(.006, line["height"]*.6)), None)
        if target is None:
            rows.append({"cy": cy, "lines": [line]})
        else:
            target["lines"].append(line)
    for row in rows:
        row["lines"].sort(key=lambda p: p["x"])
        row["text"] = " ".join(p["text"] for p in row["lines"])
    return rows


def extract_date(text):
    # Prefer explicitly labelled dates over unrelated numbers in addresses or noisy borders.
    labelled = re.search(r"(?:日期|日\s*期)\s*[:：]?\s*((?:20\d{6})|(?:民國\s*)?\d{2,4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2})", text)
    if labelled:
        parsed = extract_date(labelled[1])
        if parsed:
            return parsed
    for match in re.finditer(r"(?<!\d)(20\d{2})([01]\d)([0-3]\d)(?!\d)", text):
        try:
            return date(*map(int, match.groups())).isoformat()
        except ValueError:
            pass
    for match in re.finditer(r"(?:民國\s*)?(\d{2,4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})", text):
        y, m, d = map(int, match.groups())
        try:
            year = y+1911 if y < 1911 else y
            if not 1900 <= year <= 2100:
                continue
            return date(year, m, d).isoformat()
        except ValueError:
            pass
    return ""


def parse_ocr(result):
    pages = result.get("pages", [])
    lines = [line for p in pages for line in p.get("lines", [])]
    text = "\n".join(line["text"] for line in lines)
    compact = re.sub(r"\s+", "", norm(text))
    sup = "hh" if ("示範鋁材一廠" in compact or "DEMO-A" in compact.upper()) else "sk" if "示範鋼材二廠" in compact else ""
    if "示範鋁業三廠" in compact:
        sup = "zf"
    elif "示範金屬四廠" in compact:
        sup = "zm"
    if sup in ["zf", "zm"]:
        from round_ocr import parse_round_document
        from taxation import draft_context
        return draft_context(default_units(parse_round_document(result, sup)))
    if not sup and re.search(r'[圓圆][條条棒]\s*\d', norm(text)):
        from round_ocr import parse_round_document
        from taxation import draft_context
        draft=parse_round_document(result,'zm')
        draft['meta']['sup']=''
        draft['warnings'].append('未確認供應商，請選擇或新增供應商。')
        return draft_context(default_units(draft))
    document = re.search(r"\b\d{7}\s*N\s*\d{4}\b|(?<!\d)20\d{9}(?!\d)", norm(text), re.I)
    meta = {"sup": sup, "date": extract_date(norm(text)), "doc": re.sub(r"\s+", "", document[0]) if document else "",
            "subtotal": None, "tax": None, "total": None, "note": ""}
    items, warnings = [], []
    for page in pages:
        rows = grouped_lines(page.get("lines", []))
        # Table column positions come from detected headers, independent of photo crop.
        anchors = {}
        labels = {"qty": ["數量", "数量"], "weight_kg": ["重量"], "price": ["單價", "单价"],
                  "material_amount": ["材料費"], "processing_fee": ["加工費"], "amount": ["金額", "合計", "含計"],
                  "thick": ["厚度"], "width": ["寬度"], "length": ["長度"], "unit": ["單位", "单位"]}
        for row in rows:
            txt = re.sub(r"\s+", "", row["text"])
            if ("數量" in txt or "数量" in txt) and ("單價" in txt or "厚度" in txt or "材質" in txt):
                for line in row["lines"]:
                    clean = re.sub(r"\s+", "", line["text"])
                    for field, aliases in labels.items():
                        if any(a in clean for a in aliases):
                            anchors[field] = line["x"]+line["width"]/2
        # Spaced Chinese headings are often emitted as individual glyphs.
        # Reconstruct only adjacent glyphs on the detected table header baseline.
        for row in rows:
            compact_header = re.sub(r"\s+", "", row['text'])
            if not ('數量' in compact_header and '單價' in compact_header): continue
            cells = row['lines']
            for field, word in [('price','單價'), ('amount','金額')]:
                if field in anchors: continue
                for i, cell in enumerate(cells[:-1]):
                    following = cells[i+1]
                    if cell['text'].strip()==word[0] and following['text'].strip()==word[1] and following['x']-cell['x']<.15:
                        anchors[field]=(cell['x']+following['x']+following['width'])/2
        # Some layouts keep each heading on a separate OCR baseline.
        for line in page.get("lines", []):
            if .15 < line["y"] < .27:
                clean = re.sub(r"\s+", "", norm(line["text"]))
                for field, aliases in labels.items():
                    if any(clean.lower() in [a.lower(), (a+"mm").lower()] for a in aliases):
                        anchors[field] = line["x"]+line["width"]/2
        if sup == 'sk' and 'weight_kg' not in anchors and 'qty' in anchors and 'price' in anchors:
            anchors['weight_kg'] = (anchors['qty']+anchors['price'])/2
        def at_column(row, field):
            if field not in anchors:
                return None
            x = anchors[field]
            columns = sorted(set(anchors.values()))
            index = columns.index(x)
            low = (columns[index-1]+x)/2 if index else 0
            high = (columns[index+1]+x)/2 if index+1 < len(columns) else min(1,x+.06)
            candidates = [p for p in row["lines"] if low <= p['x']+p['width']/2 < high and
                          (NUM_RE.fullmatch(p['text'].strip()) or (field == 'amount' and re.match(r'^\d[\d,]*(?:\.\d+)?\s*[^\d.,\s]',p['text'].strip())))]
            if not candidates:
                return None
            value = min(candidates, key=lambda p: abs(p['x']+p['width']/2-x))['text'].strip()
            if field == 'amount':
                value = re.match(r'^\d[\d,]*(?:\.\d+)?',value)[0]
            return number(value)

        dimension_headers = ' '.join(norm(line['text']) for line in page.get('lines', [])
                                     if line['y'] < .35 and any(term in norm(line['text']) for term in ['厚度', '寬度', '長度']))

        for row in rows:
            label = re.sub(r"\s+", "", row["text"])
            nums = [number(p["text"]) for p in row["lines"] if number(p["text"]) is not None]
            if nums:
                for field, aliases in [("subtotal", ["小計"]), ("tax", ["營業稅"]), ("total", ["總計", "合計"])]:
                    if any(a in label for a in aliases) and not grade_of(row["text"]):
                        meta[field] = nums[-1]
            grade = grade_of(row["text"])
            if not grade or row["cy"] < .18 or row["cy"] > .7:
                continue
            dim_match = DIM_RE.search(row["text"])
            dims = [float(v) for v in dim_match.groups()] if dim_match else [at_column(row, k) for k in ["thick", "width", "length"]]
            if any(d is None for d in dims):
                # Split-column forms may have all numbers joined into one observation.
                after = GRADE_RE.sub(" ", row["text"])
                after = re.sub(r"^\s*\d+\s+", "", after)
                fallback = [number(m[0]) for m in NUM_RE.finditer(after)]
                if sup == "sk" and len(fallback) >= 3:
                    dims = fallback[:3]
            qty, price, amount = (at_column(row, k) for k in ["qty", "price", "amount"])
            if dim_match and sup != 'hh':
                after_dims = row["text"][dim_match.end():]
                tail = [number(m[0]) for m in NUM_RE.finditer(after_dims)]
                if len(tail) >= 3:
                    qty = qty if qty is not None else tail[0]
                    price = price if price is not None else tail[1]
                    amount = amount if amount is not None else tail[2]
            elif sup == "sk":
                after = GRADE_RE.sub(" ", row["text"])
                after = re.sub(r"^\s*\d+\s+", "", after)
                tail = [number(m[0]) for m in NUM_RE.finditer(after)]
                if len(tail) >= 7:
                    qty = qty if qty is not None else tail[3]
                    price = price if price is not None else tail[5]
                    # The next column is material cost, not the line total. Never use it as a fallback amount.
            if any(i.get("page") == page["number"] and abs(i.get("row_y", 0)-row["cy"]) < .014 for i in items):
                continue
            unit_text = next((p['text'].strip() for p in row['lines'] if 'unit' in anchors and abs(p['x']+p['width']/2-anchors['unit']) < .025 and p['text'].strip().upper() in ['PC','PCS','KG','件','公斤','支','片','張','組','公尺']), '')
            note = ''
            if 'amount' in anchors:
                for cell in row['lines']:
                    if abs(cell['x']+cell['width']/2-anchors['amount']) < .055:
                        suffix = re.match(r'^\s*\d[\d,]*(?:\.\d+)?\s*([^\d.,\s].*)$',cell['text'])
                        if suffix:
                            note = suffix[1].strip()
            item = {"label": grade, "grade": grade, "part_no": "", "shape": "rect", "dims": dims,
                          "dim_unit": dimension_unit(row['text']+' '+dimension_headers),
                          "qty": qty, "unit": pricing_unit(unit_text), "price": price, "amount": amount, "note": note,
                          **{key: at_column(row,key) for key in ['weight_kg','material_amount','processing_fee']},
                          "page": page["number"], "row_y": row["cy"], "raw": row["text"],
                          "confidence": round(min((p.get("confidence", 0) for p in row["lines"]), default=0), 3)}
            item['pricing_basis'], basis_warning = infer_pricing_basis(item)
            if basis_warning:
                warnings.append(f'第 {len(items)+1} 筆：'+basis_warning)
            items.append(item)
    # Cross-check alternate footer readings against observed subtotal + tax.
    if meta["subtotal"] is not None and meta["tax"] is not None:
        expected = meta["subtotal"] + meta["tax"]
        if meta["total"] != expected:
            observed = [line for line in lines if .5 < line["y"] < .66]
            candidates = []
            for line in observed:
                value = norm(line["text"]).strip()
                if NUM_RE.fullmatch(value):
                    candidates.append(number(value))
                    if re.fullmatch(r"\d{1,3}\.\d{3}", value):
                        candidates.append(number(value.replace(".", "")))
            if expected in candidates:
                meta["total"] = expected
                warnings.append("整單總計有不同 OCR 讀值，已選用與小計＋稅額相符的讀值，仍請核對原圖。")
            else:
                warnings.append("整單總計與小計＋稅額不符，請核對原圖修正。")
    if not items:
        items = [{"label": "", "grade": "", "part_no": "", "dims": [None, None, None], "dim_unit": "", "qty": None, "unit": "", "price": None, "amount": None, "note": "", "page": 1, "raw": ""}]
        warnings.append("沒有可靠地拆出材料列，請對照原圖補填；也可新增多筆明細。")
    if not sup:
        warnings.append("未確認供應商，請選擇或新增供應商。")
    warnings.append("請逐筆核對原圖；未註明尺寸單位預設 mm、計價單位預設件；材質與金額未列則留白。")
    from taxation import draft_context
    return draft_context(default_units({"meta": meta, "items": items, "warnings": warnings, "text": text}))


def positive(value, label, zero=False):
    try:
        num = Decimal(str(value))
        if not num.is_finite() or (num < 0 if zero else num <= 0):
            raise InvalidOperation
        result = float(num)
        if not math.isfinite(result) or (result < 0 if zero else result <= 0):
            raise InvalidOperation
        return result
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"{label}必須是{'非負' if zero else '正'}數")


def validate_draft(draft, suppliers):
    draft = default_units(draft)
    meta = draft.get("meta", {})
    if meta.get("sup") not in suppliers:
        raise ValueError("請確認供應商")
    if meta.get("date"):
        try:
            date.fromisoformat(meta["date"])
        except ValueError:
            raise ValueError("日期格式錯誤")
    if not isinstance(draft.get("items"), list) or not 1 <= len(draft["items"]) <= 200:
        raise ValueError("每份單據需有 1–200 筆材料明細")
    records = []
    for index, item in enumerate(draft["items"], 1):
        label = str(item.get("label", "")).strip()
        grade = str(item.get("grade") or "").strip().upper()
        if not label:
            raise ValueError(f"第 {index} 筆請填寫品名／材料名稱")
        shape = item.get("shape", "rect")
        if shape not in ["rect", "round"]:
            raise ValueError(f"第 {index} 筆形狀不正確")
        dims = item.get("dims", [])
        if not isinstance(dims, list) or len(dims) != (2 if shape == "round" else 3):
            raise ValueError(f"第 {index} 筆需有{'直徑與長度兩個' if shape == 'round' else '三個'}尺寸")
        dims = [positive(d, f"第 {index} 筆尺寸") for d in dims]
        factor = {"mm": 1, "cm": 10, "inch": 25.4}.get(item.get("dim_unit"))
        if factor is None:
            raise ValueError(f"第 {index} 筆請確認尺寸單位")
        unit = str(item.get("unit", "")).strip()
        if unit not in ["件", "公斤", "支", "片", "張", "組", "公尺"]:
            raise ValueError(f"第 {index} 筆請確認數量／計價單位")
        basis = item.get('pricing_basis', 'quantity')
        if basis not in ['quantity', 'weight']:
            raise ValueError(f'第 {index} 筆請確認計價依據')
        weight = (positive(item.get('weight_kg'),f'第 {index} 筆重量') if basis == 'weight'
                  else optional_amount(item.get('weight_kg'),f'第 {index} 筆重量'))
        row = {"sup": meta["sup"], "date": meta.get("date", ""), "doc": str(meta.get("doc", "")),
               "label": label, "grade": grade, "part_no": str(item.get("part_no", "")), "shape": shape,
               "dims": [round(d*factor, 6) for d in dims], "original_dims": dims, "dim_unit": item["dim_unit"],
               "qty": positive(item.get("qty"), f"第 {index} 筆數量"), "unit": unit,
               "price": optional_amount(item.get("price"), f"第 {index} 筆單價"),
               "amount": optional_amount(item.get("amount"), f"第 {index} 筆明細金額"),
               "pricing_basis": basis, "weight_kg": weight,
               "processing_fee": optional_amount(item.get('processing_fee'),f'第 {index} 筆加工費'),
               "material_amount": optional_amount(item.get('material_amount'),f'第 {index} 筆材料費'),
               "note": str(item.get("note", "")), "page": int(item.get("page") or 1),
               "src": "real", "raw": str(item.get("raw", ""))}
        for k in ["tax", "subtotal", "total"]:
            row[k if k != "total" else "document_total"] = None if meta.get(k) in [None, ""] else positive(meta[k], k, True)
        # Existing UI's total column is the line amount. Whole-document totals stay separate.
        row["total"] = row["amount"]
        records.append(row)
    return records


def optional_amount(value, label):
    return None if value is None or (isinstance(value, str) and not value.strip()) else positive(value, label, True)


def parse_query(raw):
    text = norm(raw).upper().strip()
    round_marker = re.search(r"[Ø⌀Φφ]|圓[條棒]", text)
    dims = (re.search(r"(?:[Ø⌀Φφ]|圓[條棒])\s*(\d+(?:\.\d+)?)\s*[X*]\s*(\d+(?:\.\d+)?)\s*L?", text) if round_marker else DIM_RE.search(text))
    query = {"dims": None, "shape": "round" if round_marker else None, "grade": "", "family": "", "sup": "", "doc": "", "error": ""}
    if dims:
        values = [float(v) for v in dims.groups()]
        query["dims"] = values if round_marker else sorted(values)
        query["shape"] = "round" if round_marker else "rect"
        text = text[:dims.start()] + " " + text[dims.end():]
        if round_marker and re.search(r"^\s*[X*]\s*\d", text[dims.start():]):
            query["error"] = "圓條請輸入直徑 × 長度兩個尺寸，例如 Ø70×107"
        if any(d <= 0 for d in query["dims"]):
            query["error"] = "尺寸必須大於 0"
    elif round_marker and re.search(r'\d', text):
        query['error'] = '圓條請輸入直徑 × 長度兩個尺寸，例如 Ø70×107'
    elif re.search(r"\d\s*[X*]\s*\d", text):
        query["error"] = "長方體請輸入三個尺寸；圓條請標示 Ø直徑×長度，例如 Ø70×107"
    query["grade"] = grade_of(text)
    for key, supplier in SUPPLIERS.items():
        short_alias = supplier['short'][:2]
        unique_alias = sum(s['short'].startswith(short_alias) for s in SUPPLIERS.values()) == 1
        if supplier["short"] in text or (unique_alias and short_alias in text):
            query["sup"] = key
            text = text.replace(supplier['name'], ' ').replace(supplier['short'], ' ')
            if unique_alias: text = text.replace(short_alias, ' ')
            break
    doc = re.search(r"\d{7}N\d{4}|(?<!\d)(?:20\d{9}|\d{10})(?!\d)", text)
    if doc:
        query["doc"] = doc[0]
        if not dims:
            query["grade"] = ""
    if not query["grade"]:
        for term, family in [("不鏽", "不鏽鋼"), ("不銹", "不鏽鋼"), ("白鐵", "不鏽鋼"), ("模具", "模具鋼"), ("鋁", "鋁合金"), ("碳鋼", "碳鋼"), ("合金鋼", "合金鋼"), ("鋼", "steel")]:
            if term in text:
                query["family"] = family
                break
    # Never silently broaden an unrecognized grade (e.g. 7050) to all materials.
    if not query["grade"] and not query["doc"]:
        token = re.search(r"(?<![A-Z0-9])(?:\d{4}(?:-T\d+)?|[A-Z]{1,6}\d{2,}[A-Z]*)(?![A-Z0-9])", text)
        if token:
            query["grade"] = token[0]
            query["family"] = ""
    return query


METALS = {'aluminum': '鋁', 'steel': '鋼', 'other': '其他／未分類'}


def normalize_grade(value):
    return norm(value).strip().upper()


def metal_of(grade):
    family = GRADES.get(normalize_grade(grade))
    return 'aluminum' if family == '鋁合金' else 'steel' if family in ['碳鋼', '合金鋼', '模具鋼', '不鏽鋼'] else 'other'


def material_catalog(records):
    grades, metals, missing = {}, {}, 0
    for row in records:
        grade = normalize_grade(row.get('grade'))
        metal = metal_of(grade)
        metals[metal] = metals.get(metal, 0)+1
        if not grade:
            missing += 1
            continue
        if grade not in grades:
            grades[grade] = {'grade': grade, 'family': GRADES.get(grade, '其他／未分類'), 'metal': metal, 'count': 0}
        grades[grade]['count'] += 1
    return {'grades': [grades[g] for g in sorted(grades)],
            'metals': [{'id': k, 'label': v, 'count': metals[k]} for k, v in METALS.items() if k in metals],
            'missing_count': missing}


def structured_query(filters):
    shape, metal = filters.get('shape', 'rect'), filters.get('metal', 'all')
    if shape not in ['rect', 'round']:
        raise ValueError('請選擇長方體或圓條')
    if metal not in ['all', *METALS]:
        raise ValueError('金屬分類不正確')
    missing = str(filters.get('missing_grade', '0'))
    if missing not in ['0', '1']:
        raise ValueError('材質未列條件不正確')
    grade = normalize_grade(filters.get('grade'))
    if grade and missing == '1':
        raise ValueError('牌號與材質未列不能同時指定')
    raw_dims = str(filters.get('dims', '')).strip()
    dims = None
    if raw_dims:
        values = raw_dims.split(',')
        if len(values) != (2 if shape == 'round' else 3) or any(not v.strip() for v in values):
            raise ValueError('請填妥直徑與長度' if shape == 'round' else '請填妥三個尺寸')
        dims = [positive(v, '尺寸') for v in values]
        if shape == 'rect':
            dims.sort()
    return {'dims': dims, 'shape': shape, 'grade': grade, 'metal': metal, 'missing_grade': missing == '1',
            'family': '', 'sup': '', 'doc': '', 'error': ''}


def search_materials(records, raw='', allowance=0, *, filters=None):
    q = structured_query(filters) if filters is not None else parse_query(raw)
    allowance = positive(allowance, "加工餘量", True)
    groups = {}
    if q["error"]:
        return {"query": q, "groups": [], "total": 0}
    need = [d+2*allowance for d in q["dims"]] if q["dims"] else None
    for record in records:
        if q["sup"] and record["sup"] != q["sup"]:
            continue
        if q["grade"] and normalize_grade(record.get('grade')) != q["grade"]:
            continue
        if q.get('missing_grade') and normalize_grade(record.get('grade')):
            continue
        if q.get('metal', 'all') != 'all' and metal_of(record.get('grade')) != q['metal']:
            continue
        shape = record.get("shape", "rect")
        if q["shape"] and shape != q["shape"]:
            continue
        family = GRADES.get(record["grade"], "其他")
        if q["family"] and (family not in ["碳鋼", "合金鋼", "模具鋼", "不鏽鋼"] if q["family"] == "steel" else family != q["family"]):
            continue
        if q["doc"] and q["doc"] not in record["doc"].upper():
            continue
        dims = record["dims"] if shape == "round" else sorted(record["dims"])
        if need and len(dims) != len(need):
            continue
        deltas = [round(d-n, 6) for d, n in zip(dims, need)] if need else []
        if need and any(d < -1e-8 for d in deltas):
            continue
        match = {"r": record, "deltas": deltas, "util": material_volume(need, shape)/material_volume(dims, shape) if need else None}
        groups.setdefault(record["sup"], []).append(match)
    output = []
    for sup in sorted(groups):
        matches = groups[sup]
        if need:
            matches.sort(key=lambda m: (material_volume(m["r"]["dims"], m["r"].get("shape", "rect")), sum(m["deltas"]), -int(m["r"]["date"].replace("-", "") or 0), m["r"]["id"]))
        else:
            matches.sort(key=lambda m: (m["r"]["date"], m["r"]["id"]), reverse=True)
        output.append({"sup": sup, "count": len(matches), "items": matches[:3]})
    return {"query": q, "need": need, "groups": output, "total": sum(g["count"] for g in output)}
