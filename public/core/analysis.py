"""Read-only procurement analysis. Supplements never rewrite invoice records."""
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP, localcontext
import csv
import hashlib
import io
import json
import math
import re

from billing import decimal_value, billing_quantity
from taxation import context as document_tax_context, settings as tax_settings, gross_document, gross_price_issues

DENSITY_URL = 'https://www.thyssenkrupp-aerospace.com/en/materials/aluminium-plate/alloy-density-offerings'
S50C_DENSITY_URL = 'https://www.makerz.co.jp/material_database/materials/s50c.html'
DEFAULT_DENSITIES = {'6061': 2.71, '7075': 2.80, 'S50C': 7.85}
DEFAULT_DENSITY_SOURCES = {'6061': DENSITY_URL, '7075': DENSITY_URL, 'S50C': S50C_DENSITY_URL}
GRADE_METALS = {'6061': 'aluminum', '7075': 'aluminum', 'S50C': 'steel'}
PRICE_BASES = {'material', 'original', 'gross'}
COUNT_UNITS = {'件', '支', '片', '張', '個', 'PC', 'PCS'}
QUOTE_COLUMNS = ['supplier', 'date', 'valid_until', 'doc', 'grade', 'temper', 'shape', 'dim1', 'dim2', 'dim3', 'qty', 'unit', 'pricing_basis', 'price', 'weight_kg', 'material_amount', 'processing_fee', 'amount', 'tax_basis', 'tax_rate', 'fee_zero', 'note']
NOTE_FIELDS = {'temper', 'tax_basis', 'tax_rate', 'material_cost', 'weight_kg', 'fee_zero', 'note'}


def num(value):
    v = decimal_value(value)
    return float(v) if v is not None and abs(v) <= Decimal('1e18') else None


def rounded(value):
    with localcontext() as ctx:
        ctx.prec = 60
        return float(Decimal(str(value)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP))


def fingerprint(row):
    return hashlib.sha256(json.dumps({k: v for k, v in row.items() if k not in {'id', 'document_id', 'position'}}, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def valid_date(value, monthly=False):
    value = str(value or '')
    try:
        parsed = date.fromisoformat(value + '-01' if monthly else value)
        if value != parsed.isoformat()[:7 if monthly else 10]: raise ValueError()
        return value
    except ValueError:
        raise ValueError('日期請使用 YYYY-MM' + ('' if monthly else '-DD'))


def optional_number(data, key, positive=False):
    raw = data.get(key)
    if raw is None or str(raw).strip() == '': return None
    value = num(raw)
    if value is None or (value <= 0 if positive else value < 0):
        raise ValueError(key + (' 必須大於 0' if positive else ' 不可為負數或無效數字'))
    return value


def validate_note(data):
    if not isinstance(data, dict): raise ValueError('分析補充格式錯誤')
    result = {k: str(data.get(k) or '').strip()[:1000] for k in ['temper', 'note']}
    result['tax_basis'] = data.get('tax_basis') or 'unknown'
    if result['tax_basis'] not in ['unknown', 'pretax', 'included']: raise ValueError('稅別無效')
    for key in ['tax_rate', 'material_cost', 'weight_kg']:
        result[key] = optional_number(data, key, key == 'weight_kg')
    if result['tax_rate'] is not None and result['tax_rate'] > 100: raise ValueError('稅率不可超過 100%')
    if result['tax_basis'] == 'included' and result['tax_rate'] is None: raise ValueError('含稅金額需填明確稅率')
    flag = str(data.get('fee_zero') or '').lower()
    if flag not in ['', 'true', 'false', '1', '0']: raise ValueError('加工費確認值無效')
    result['fee_zero'] = flag in ['true', '1']
    return result


def validate_quote(data, suppliers):
    if not isinstance(data, dict): raise ValueError('報價格式錯誤')
    row = {k: str(data.get(k) or '').strip()[:1000] for k in ['doc', 'grade', 'temper', 'note']}
    row['sup'] = str(data.get('sup') or data.get('supplier') or '')
    if row['sup'] not in suppliers:
        row['sup'] = next((k for k, v in suppliers.items() if row['sup'] in [v['name'], v['short']]), '')
    if not row['sup']: raise ValueError('請選擇現有供應商，或先於單據頁新增供應商')
    row['date'] = valid_date(data.get('date'))
    row['valid_until'] = valid_date(data['valid_until']) if data.get('valid_until') else ''
    if row['valid_until'] and row['valid_until'] < row['date']: raise ValueError('報價有效日期不可早於報價日期')
    row['shape'] = data.get('shape') or 'rect'
    if row['shape'] not in ['rect', 'round']: raise ValueError('形狀需為 rect 或 round')
    count = 2 if row['shape'] == 'round' else 3
    raw_dims = data.get('dims') or [data.get('dim'+str(i+1)) for i in range(count)]
    if not isinstance(raw_dims, list) or len(raw_dims) != count: raise ValueError('尺寸欄位數量錯誤')
    row['dims'] = [optional_number({'v': v}, 'v', True) for v in raw_dims]
    if any(v is None for v in row['dims']): raise ValueError('請填妥所有尺寸（mm）')
    row['qty'] = optional_number(data, 'qty', True)
    if row['qty'] is None: raise ValueError('請填詢價數量')
    row['unit'] = str(data.get('unit') or '件').strip()
    row['unit'] = {'PC': '件', 'PCS': '件', 'KG': '公斤'}.get(row['unit'].upper(), row['unit'])
    row['pricing_basis'] = data.get('pricing_basis') or 'quantity'
    if row['pricing_basis'] not in ['quantity', 'weight']: raise ValueError('計價依據無效')
    for key in ['price', 'weight_kg', 'material_amount', 'processing_fee', 'amount']:
        row[key] = optional_number(data, key, key == 'weight_kg')
    if row['pricing_basis'] == 'weight' and row['weight_kg'] is None: raise ValueError('按重量報價需填公斤數')
    row.update(validate_note(data)); row['label'] = row['grade']; row['currency'] = 'TWD'
    return row


def quote_csv_preview(content, suppliers, existing):
    reader = csv.DictReader(io.StringIO(content.lstrip('\ufeff')))
    if not reader.fieldnames or not {'supplier', 'date', 'grade', 'qty'} <= set(reader.fieldnames): raise ValueError('CSV 缺少必要欄位，請使用下載的範本')
    rows, errors, seen, duplicates = [], [], set(), 0
    known = {fingerprint(validate_quote(q, suppliers)) for q in existing}
    for index, raw in enumerate(reader, 2):
        if index > 2001: raise ValueError('每次最多匯入 2,000 筆')
        try:
            if None in raw: raise ValueError('欄位數量不符，請確認含逗號的儲存格有加引號')
            row = validate_quote(raw, suppliers); key = fingerprint(row)
            if key in seen or key in known: duplicates += 1; continue
            seen.add(key); rows.append(row)
        except (ValueError, TypeError) as e: errors.append({'line': index, 'error': str(e)})
    return {'rows': rows, 'errors': errors, 'duplicates': duplicates}


def theoretical_weight(row, densities):
    density = num(densities.get(row.get('grade')))
    dims, qty = row.get('dims') or [], num(row.get('qty'))
    shape = row.get('shape') or 'rect'
    if density is None or density <= 0 or row.get('unit') not in COUNT_UNITS or qty is None or qty <= 0 or not qty.is_integer(): return None
    if len(dims) != (2 if shape == 'round' else 3) or any(num(d) is None or num(d) <= 0 for d in dims): return None
    dims = list(map(float, dims))
    volume = math.pi*dims[0]**2*dims[1]/4 if shape == 'round' else math.prod(dims)
    mass = volume*density*qty/1_000_000
    return mass if math.isfinite(mass) and mass > 0 else None


def invoice_tax_basis(rows):
    """Infer only from an explicit, internally consistent subtotal + tax equation."""
    if not rows: return 'unknown'
    first = rows[0]
    sub, tax, total = [num(first.get(k)) for k in ['subtotal', 'tax', 'document_total']]
    amounts = [num(r.get('amount')) for r in rows]
    if None not in [sub, tax, total] and all(v is not None for v in amounts) and abs(sum(amounts)-sub) <= .02000001 and abs(sub+tax-total) <= .02000001:
        return 'pretax'
    return 'unknown'


def material_cost(row, note, tax_basis):
    if num(note.get('material_cost')) is not None: return num(note['material_cost']), ''
    material, amount, fee, price = [num(row.get(k)) for k in ['material_amount', 'amount', 'processing_fee', 'price']]
    if price is None and material is None: return None, '價格與材料費未列'
    if fee is None and note.get('fee_zero'): fee = 0
    basis = note.get('tax_basis') or 'unknown'
    basis = tax_basis if basis == 'unknown' else basis
    if basis == 'unknown': return None, '未確認金額是否未稅'
    qty = num(billing_quantity(row))
    if material is None and amount is None and row.get('kind') == 'quote' and price is not None and qty and qty > 0:
        material = rounded(price*qty)
    # Never reverse an unknown processing fee from a difference in money.
    if material is None:
        if amount is None: return None, '材料費與明細金額未列'
        if fee is None: return None, '加工費未列，需確認未加工或補材料費'
        material = amount-fee
    if material < 0: return None, '材料費不可為負數'
    if price is not None and qty is not None and abs(rounded(price*qty)-material) > .02000001: return None, '單價與材料費不符，請核對原單'
    if amount is not None and fee is not None and abs(material+fee-amount) > .02000001: return None, '材料費＋加工費與明細金額不符'
    if basis == 'included':
        rate = num(note.get('tax_rate'))
        if rate is None: return None, '含稅金額缺少稅率'
        material /= 1+rate/100
    return material, ''


def original_price_details(row):
    """Shared arithmetic diagnostics for curves, saved invoices and draft previews."""
    issues = []
    def add(key, message): issues.append({'key': key, 'message': message, 'scope': 'item', 'code': key})
    price, quantity = num(row.get('price')), num(billing_quantity(row))
    if price is None or price < 0: add('price', '原單單價未列或無效')
    if quantity is None or quantity <= 0: add('weight_kg' if row.get('pricing_basis') == 'weight' else 'qty', '計價數量未列或無效，請核對原單')
    cost = rounded(price*quantity) if not issues else None
    values = {k: num(row.get(k)) for k in ['material_amount', 'processing_fee', 'amount']}
    for k, value in values.items():
        if row.get(k) not in [None, ''] and (value is None or value < 0): add(k, '原單金額或加工費無效，請核對原單')
    if cost is not None:
        if values['material_amount'] is not None and abs(cost-values['material_amount']) > .02000001:
            add('material_amount', '單價 × 計價數量與原單材料費不符，請核對原單')
        # Blank is zero ONLY for this check; the source fee remains blank.
        if values['amount'] is not None and abs(cost+(values['processing_fee'] or 0)-values['amount']) > .02000001:
            add('amount', '單價 × 計價數量＋已列加工費與明細金額不符，請核對原單')
    return (None if issues else cost), issues


def original_price_cost(row):
    cost, issues = original_price_details(row)
    return cost, issues[0]['message'] if issues else ''


def market_metal(row):
    # This built-in series has a verified definition; imported labels are never guessed.
    return 'aluminum' if row.get('series') == 'wb-aluminium' else 'steel' if row.get('series') in ['sb-china-hrb', 'sb-china-plate'] else row.get('metal', '')


def review_metadata(row):
    """Group the existing primary reason; never change eligibility or hide diagnostics."""
    if row.get('duplicate_of'): return {'review_status': 'duplicate', 'primary_issue': None}
    if row.get('transaction_type') == 'customer_supplied': return {'review_status': 'customer_supplied', 'primary_issue': None}
    if row['eligible']: return {'review_status': 'included', 'primary_issue': None}
    reason = row['reason']
    issue = next((i for i in row['issues'] if i['message'] == reason), {})
    code, key = issue.get('code', ''), issue.get('key', '')
    if row.get('stale'): category, label = 'stale_supplement', '分析補充失效'
    elif reason == '單據目前待確認，未納入分析': category, label = 'pending', '原單待確認'
    elif reason == '已作廢報價': category, label = 'void_quote', '已作廢報價'
    elif code == 'missing_weight' or key == 'weight_kg': category, label = 'missing_weight', '缺少重量／重量無效'
    elif key == 'price' or reason == '價格與材料費未列': category, label = 'missing_price', '缺少單價／價格未列'
    elif reason in ['未確認金額是否未稅', '含稅金額缺少稅率']: category, label = 'tax_basis', '稅別待補充'
    elif reason in ['加工費未列，需確認未加工或補材料費', '材料費與明細金額未列']: category, label = 'material_cost', '材料費／加工費待補充'
    elif key in ['amount', 'material_amount', 'processing_fee']: category, label = 'amount_mismatch', '金額不符／金額無效'
    else:
        category = code or 'other'
        label = {'missing_grade': '缺少材質', 'unsupported': '暫未支援材質', 'qty': '數量待核對', 'dim0': '尺寸待核對', 'date': '日期待核對', 'pricing_basis': '計價依據待核對'}.get(category, '其他待核對')
    return {'review_status': 'needs_review', 'primary_issue': dict(code=category, label=label, key=key, scope=issue.get('scope', 'item'), message=reason)}


def observations(records, documents, quotes, notes, densities, price_basis='material', preview_ids=frozenset()):
    if price_basis not in PRICE_BASES: raise ValueError('價格口徑無效')
    docs = {d['id']: d for d in documents}; groups = defaultdict(list)
    for r in records: groups[r['document_id']].append(r)
    # A duplicate is an entire identical invoice, not two equal lines in one invoice.
    canonical, duplicate_of = {}, {}
    ordered_groups = sorted(groups.items(), key=lambda pair: (invoice_tax_basis(pair[1]) != 'pretax', docs.get(pair[0], {}).get('created', ''), pair[0]))
    for doc_id, rows in ordered_groups:
        if doc_id in preview_ids or docs.get(doc_id, {}).get('status') != 'done': continue
        fields = ['grade', 'label', 'part_no', 'shape', 'dims', 'qty', 'unit', 'pricing_basis', 'weight_kg', 'price', 'amount', 'material_amount', 'processing_fee', 'note']
        key = (rows[0].get('sup'), rows[0].get('doc'), rows[0].get('date'), tuple(json.dumps({k: r.get(k) for k in fields}, sort_keys=True, ensure_ascii=False) for r in sorted(rows, key=lambda r: r['position'])))
        if key[1] and key in canonical: duplicate_of[doc_id] = canonical[key]
        else: canonical[key] = doc_id
    gross = {}
    contexts = {}
    for identifier, rows in groups.items():
        cfg = document_tax_context(docs.get(identifier, {}), identifier in preview_ids)
        contexts[identifier] = cfg
        gross.update(gross_document(rows, cfg))
    output = []
    for r in records + quotes:
        is_quote = r.get('kind') == 'quote'
        row = dict(r); reason = ''; stale = False; issues = list(r.get('_input_issues', []))
        def add(key, message, code=None, scope='item'):
            issue = {'key': key, 'message': message, 'code': code or key, 'scope': scope}
            if issue not in issues: issues.append(issue)
        if is_quote:
            note = row; basis = 'unknown'
            if row.get('void'): reason = '已作廢報價'
            row['source_ids'] = [row['id']]
        else:
            saved = notes.get(row['id'], {})
            stale = bool(saved) and saved.get('fingerprint') != fingerprint(row)
            note = {} if stale else saved.get('data', {})
            basis = invoice_tax_basis(groups[row['document_id']])
            row['source_ids'] = [row['document_id']] + [d for d, original in duplicate_of.items() if original == row['document_id']]
            if row['document_id'] not in preview_ids and docs.get(row['document_id'], {}).get('status') != 'done': reason = '單據目前待確認，未納入分析'
            elif row['document_id'] in duplicate_of: reason = '重複單據，已合併來源'
            elif stale: reason = '原單已更新，請重新確認分析補充資料'
            if stale: add('grade', '原單已更新，請重新確認分析補充資料', 'stale_supplement')
        cfg = tax_settings(dict(row, tax_rate=row.get('tax_rate') if row.get('tax_rate') is not None else 5)) if is_quote else contexts.get(row['document_id'], tax_settings())
        row['transaction_type'] = cfg['transaction_type']
        row['tax_source'] = cfg['source']
        if cfg['tax_basis'] != 'unknown':
            basis = cfg['tax_basis']
            note = dict(note, tax_basis=basis, tax_rate=cfg['tax_rate'])
        row['kind'] = 'quote' if is_quote else 'invoice'
        row['temper'] = note.get('temper', '')
        row['metal'] = GRADE_METALS.get(row.get('grade'), '')
        tax_basis = note.get('tax_basis') or 'unknown'
        tax_basis = basis if tax_basis == 'unknown' else tax_basis
        tax_rate = num(note.get('tax_rate')) if tax_basis in ['included','pretax'] else None
        row['tax_status'] = tax_basis+(':'+str(tax_rate) if tax_basis == 'included' else '')
        row['tax_basis'], row['tax_rate'] = tax_basis, tax_rate
        if num(row.get('qty')) is None or num(row.get('qty')) <= 0: add('qty', '數量未列或無效')
        if row.get('pricing_basis', 'quantity') not in ['quantity', 'weight']: add('pricing_basis', '計價依據無效')
        dims, shape = row.get('dims') or [], row.get('shape') or 'rect'
        if shape not in ['rect', 'round'] or len(dims) != (2 if shape == 'round' else 3) or any(num(d) is None or num(d) <= 0 for d in dims):
            add('dim0', '尺寸無效，請核對原單')
        for raw in [note.get('weight_kg'), row.get('weight_kg')]:
            if raw not in [None, ''] and (num(raw) is None or num(raw) <= 0): add('weight_kg', '重量無效，請核對原單')
        weight = num(note.get('weight_kg')) or num(row.get('weight_kg'))
        if not weight and str(row.get('unit', '')).upper() in ['公斤', 'KG'] and (num(row.get('qty')) or 0) > 0: weight = num(row['qty'])
        source = 'actual' if weight and weight > 0 else 'theoretical'
        if source == 'theoretical': weight = theoretical_weight(row, densities)
        net_cost, net_reason = material_cost(row, note, basis)
        raw_cost, raw_issues = original_price_details(row)
        raw_reason = raw_issues[0]['message'] if raw_issues else ''
        detail = gross.get(row['id'], {})
        if is_quote:
            virtual = dict(row, document_total=row.get('amount'))
            if cfg['tax_basis']=='pretax' and num(row.get('amount')) is not None:
                from taxation import dec
                virtual['document_total'] = num(row['amount']) + float((dec(row['amount'])*dec(cfg['tax_rate'])/100).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
            detail = gross_document([virtual],cfg).get(row['id'],{})
        row.update({k:v for k,v in detail.items() if k!='tax_issues'})
        gross_issues = detail.get('tax_issues', []) + gross_price_issues(row)
        gross_cost = detail.get('gross_amount') if not gross_issues else None
        row['gross_unit_kg'] = gross_cost/weight if gross_cost is not None and weight and weight>0 else None
        cost, cost_reason = (gross_cost, '') if price_basis == 'gross' else (raw_cost, raw_reason) if price_basis == 'original' else (net_cost, net_reason)
        if not row.get('grade'): add('grade', '材質牌號未列', 'missing_grade')
        elif row['grade'] not in GRADE_METALS: add('grade', '目前支援 S50C、6061、7075', 'unsupported')
        if not weight or weight <= 0: add('qty', '缺少可用重量或理論重量所需資料', 'missing_weight')
        if price_basis == 'original': issues.extend(i for i in raw_issues if i not in issues)
        elif price_basis == 'gross': issues.extend(i for i in gross_issues if i not in issues)
        elif cost_reason: add('material_amount', cost_reason)
        try: valid_date(row.get('date'))
        except ValueError: add('date', '日期無效', scope='meta')
        if cfg['transaction_type'] == 'customer_supplied':
            issues = []; reason = reason or '客供料，無購料價格'; cost = None; row['gross_unit_kg'] = None
        reason = reason or (issues[0]['message'] if issues else '')
        qty = num(row.get('qty'))
        piece_weight = weight/qty if weight and qty and qty > 0 and qty.is_integer() and row.get('unit') in COUNT_UNITS else None
        row.update(weight=weight, piece_weight=piece_weight, weight_source=source, material_cost=net_cost, analysis_cost=cost,
                   price_basis=price_basis, original_price_cost=raw_cost, original_unit_kg=raw_cost/weight if raw_cost is not None and weight and weight > 0 else None,
                   unit_kg=cost/weight if cost is not None and weight and weight > 0 else None,
                   eligible=not reason, reason=reason, issues=issues, duplicate_of=duplicate_of.get(row.get('document_id')), fingerprint=fingerprint({k:v for k,v in r.items() if not k.startswith('_')}), supplement=note if not is_quote else {}, stale=stale)
        row.update(review_metadata(row))
        output.append(row)
    return output


def period_key(value, frequency):
    if frequency == 'monthly': return value[:7]
    day = date.fromisoformat(value)
    return (day-timedelta(days=day.weekday())).isoformat() if frequency == 'weekly' else value


def filter_range(filters, prefix, label):
    bounds = []
    for suffix, name in [('min', '最小值'), ('max', '最大值')]:
        raw = filters.get(prefix+'_'+suffix)
        if raw is None or isinstance(raw, str) and not raw.strip():
            bounds.append(None); continue
        try:
            if isinstance(raw, bool) or not isinstance(raw, (str, int, float)): raise ValueError()
            value = float(raw)
            if not math.isfinite(value) or value <= 0: raise ValueError()
        except (ValueError, TypeError, OverflowError):
            raise ValueError(label+name+'須為有限正數')
        bounds.append(value)
    if bounds[0] is not None and bounds[1] is not None and bounds[0] > bounds[1]:
        raise ValueError(label+'最小值不得大於最大值')
    return bounds


def in_filter_range(value, bounds, calculated=False):
    if value is None or not math.isfinite(value) or value <= 0: return False
    # Dividing a computed weight by piece count can land a few float ULPs past a boundary.
    def equal(bound): return calculated and abs(value-bound) <= 4*max(math.ulp(value), math.ulp(bound))
    return (bounds[0] is None or value >= bounds[0] or equal(bounds[0])) and (bounds[1] is None or value <= bounds[1] or equal(bounds[1]))


def build_analysis(observed, prices, rates, filters):
    if not isinstance(filters, dict): raise ValueError('分析條件格式錯誤')
    price_basis = filters.get('price_basis', 'material')
    if price_basis not in PRICE_BASES: raise ValueError('價格口徑無效')
    metal = filters.get('metal') or GRADE_METALS.get(filters.get('grade'), '')
    if metal not in ['', 'aluminum', 'steel']: raise ValueError('金屬分類無效')
    if filters.get('grade') in GRADE_METALS and metal and GRADE_METALS[filters['grade']] != metal: raise ValueError('牌號與金屬分類不符')
    frequency = filters.get('frequency', 'monthly')
    if frequency not in ['monthly', 'weekly', 'daily']: raise ValueError('分析頻率無效')
    kind = filters.get('kind', 'invoice')
    if kind not in ['invoice', 'quote']: raise ValueError('請分開比較成交與報價')
    start, end = filters.get('start') or '0001-01-01', filters.get('end') or '9999-12-31'
    if start != '0001-01-01': valid_date(start)
    if end != '9999-12-31': valid_date(end)
    if start > end: raise ValueError('開始日期不可晚於結束日期')
    qty_range = filter_range(filters, 'qty', '採購數量')
    piece_range = filter_range(filters, 'piece_weight', '單件重量（公斤）')
    quantity_active, piece_active = any(v is not None for v in qty_range), any(v is not None for v in piece_range)
    qty_unit = filters.get('qty_unit', '件')
    if qty_unit is None or qty_unit == '': qty_unit = '件'
    if quantity_active and (not isinstance(qty_unit, str) or not qty_unit.strip() or len(qty_unit) > 100): raise ValueError('請選擇採購數量單位')
    if quantity_active: qty_unit = qty_unit.strip()
    temper = filters.get('temper', '')
    if temper is None: temper = ''
    if not isinstance(temper, str) or len(temper) > 1000: raise ValueError('供料／熱處理狀態格式錯誤')
    missing_temper = filters.get('temper_missing', False)
    if missing_temper is None or missing_temper == '': missing_temper = False
    if not isinstance(missing_temper, bool) or missing_temper and temper: raise ValueError('請選擇單一供料／熱處理狀態條件')
    fixed = filters.get('fixed')
    if fixed:
        if not isinstance(fixed, dict) or not str(fixed.get('temper') or '').strip() or not fixed.get('grade') or not isinstance(fixed.get('dims'), list) or not num(fixed.get('qty')): raise ValueError('固定規格需指定牌號、供料／熱處理狀態、形狀、完整尺寸與數量')
        if fixed.get('shape', 'rect') not in ['round', 'rect'] or len(fixed['dims']) != (2 if fixed.get('shape') == 'round' else 3) or any(num(d) is None or num(d) <= 0 for d in fixed['dims']) or num(fixed['qty']) <= 0: raise ValueError('固定規格尺寸或數量無效')
    selected, market_rows = [], []
    missing_piece_weight = 0
    option_rows = [r for r in observed if r['kind'] == kind and (not metal or r.get('metal', GRADE_METALS.get(r.get('grade'), '')) == metal) and (not filters.get('grade') or r.get('grade') == filters['grade'])]
    for r in observed:
        if r['kind'] != kind or not start <= r.get('date', '') <= end: continue
        if metal and r.get('metal', GRADE_METALS.get(r.get('grade'), '')) != metal: continue
        if filters.get('grade') and r.get('grade') != filters['grade']: continue
        if filters.get('sup') and r.get('sup') != filters['sup']: continue
        if filters.get('shape') and r.get('shape', 'rect') != filters['shape']: continue
        if filters.get('weight_source') and r.get('weight_source') != filters['weight_source']: continue
        dims = filters.get('dims')
        if dims and r.get('dims') != dims: continue
        if fixed and not (r.get('grade') == fixed['grade'] and r.get('temper') == fixed['temper'] and r.get('shape', 'rect') == fixed.get('shape', 'rect') and r.get('dims') == fixed['dims'] and num(r.get('qty')) == num(fixed['qty']) and r.get('unit') == fixed.get('unit', '件')): continue
        # Preserve the existing international-market window before procurement conditions.
        market_rows.append(r)
        if quantity_active and (r.get('unit') != qty_unit or not in_filter_range(num(r.get('qty')), qty_range)): continue
        if missing_temper and str(r.get('temper') or '').strip(): continue
        if temper and r.get('temper') != temper: continue
        if piece_active:
            piece = r.get('piece_weight')
            if not isinstance(piece, (int, float)) or isinstance(piece, bool) or not math.isfinite(piece) or piece <= 0:
                missing_piece_weight += 1; continue
            if not in_filter_range(piece, piece_range, calculated=True): continue
        selected.append(r)
    # Supplier series are split by grade and weight provenance, never pooled across either.
    buckets = defaultdict(list)
    for r in selected:
        if r['eligible']: buckets[(r['sup'], r['grade'], r['weight_source'], r.get('tax_status', 'unknown') if price_basis in ['original','gross'] else 'pretax', period_key(r['date'], frequency))].append(r)
    series = {}
    for (sup, grade, source, tax_status, period), rows in sorted(buckets.items()):
        key = '|'.join([sup, grade, source, price_basis, tax_status])
        series.setdefault(key, {'id': key, 'kind': kind, 'sup': sup, 'grade': grade, 'weight_source': source, 'price_basis': price_basis, 'tax_status': tax_status, 'points': []})
        cost, weight = sum(r.get('analysis_cost', r['material_cost']) for r in rows), sum(r['weight'] for r in rows)
        series[key]['points'].append({'period': period, 'value': cost/weight, 'cost': cost, 'weight': weight, 'count': len(rows), 'price_basis': price_basis, 'tax_status': tax_status, 'ids': [r['id'] for r in rows]})
    fx = {(r['source'], r['frequency'], r['period']): r['value'] for r in rates}
    market_buckets = defaultdict(list); gaps = []
    market_id = filters.get('market')
    available = sorted({r['series'] for r in prices if market_metal(r) in ['aluminum', 'steel'] and (not metal or market_metal(r) == metal)})
    if market_id and market_id not in available: raise ValueError('此行情未分類或不適用目前金屬，請重新選擇行情')
    if not market_id: market_id = 'sb-china-hrb' if metal == 'steel' and 'sb-china-hrb' in available else 'wb-aluminium' if 'wb-aluminium' in available else next(iter(available), '')
    # Keep the entire cache, but default the comparison window to the selected procurement months.
    procurement_dates = sorted(r['date'] for r in market_rows if re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(r.get('date') or '')))
    if market_id not in ['sb-china-hrb', 'sb-china-plate']: procurement_dates = []
    market_start = start if filters.get('start') or not procurement_dates else procurement_dates[0][:7]+'-01'
    if filters.get('end') or not procurement_dates: market_end = end
    else:
        from calendar import monthrange
        year, month = map(int, procurement_dates[-1][:7].split('-'))
        market_end = f'{year:04d}-{month:02d}-{monthrange(year, month)[1]:02d}'
    for p in prices:
        if p['series'] != market_id: continue
        pf, pd = p['frequency'], p['period']
        if not market_start[:7] <= pd[:7] <= market_end[:7]: continue
        if pf == 'daily' and not market_start <= pd <= market_end: continue
        if pf == 'monthly' and frequency != 'monthly': continue
        rate = 1 if p['currency'] == 'TWD' else fx.get((filters.get('fx_source') or 'cbc', pf, pd))
        period = pd if pf == 'monthly' else period_key(pd, frequency)
        if rate is None: gaps.append(pd); continue
        value = p['value']*rate/(1000 if p['unit'] == 'tonne' else 1)
        market_buckets[period].append((value, p))
    if market_buckets:
        sample = next(iter(market_buckets.values()))[0][1]
        series['market'] = {'id': 'market', 'kind': 'market', 'label': sample['label'], 'source': sample['source'], 'metal': market_metal(sample), 'contract': sample.get('contract', ''), 'region': sample.get('region', ''), 'url': sample.get('url', ''), 'points': [{'period': k, 'value': sum(v for v, _ in values)/len(values), 'count': len(values), 'first_observation': min(p['period'] for _, p in values), 'last_observation': max(p['period'] for _, p in values), 'ids': []} for k, values in sorted(market_buckets.items())]}
    all_series = list(series.values())
    common = set.intersection(*(set(p['period'] for p in s['points'] if p['value'] > 0) for s in all_series)) if all_series else set()
    base = min(common) if common else None
    for s in all_series:
        baseline = next((p['value'] for p in s['points'] if p['period'] == base), None)
        for p in s['points']: p['index'] = p['value']/baseline*100 if baseline and baseline > 0 else None
    review_counts = {status: sum(r.get('review_status') == status for r in selected) for status in ['needs_review', 'included', 'duplicate', 'customer_supplied']}
    categories = {}
    for row in selected:
        issue = row.get('primary_issue')
        if row.get('review_status') == 'needs_review' and issue:
            entry = categories.setdefault(issue['code'], dict(code=issue['code'], label=issue['label'], count=0))
            entry['count'] += 1
    return {'series': all_series, 'observations': selected, 'baseline': base, 'fx_gaps': sorted(set(gaps)), 'market_series': market_id, 'metal': metal, 'price_basis': price_basis,
            'filter_options': {'quantity_units': sorted({r['unit'] for r in option_rows if r.get('unit')}), 'tempers': sorted({r['temper'] for r in option_rows if r.get('temper') and r['temper'].strip()})},
            'filter_counts': {'missing_piece_weight': missing_piece_weight},
            'review': dict(all=len(selected), **review_counts, categories=list(categories.values())),
            'counts': {'selected': len(selected), 'eligible': sum(r['eligible'] for r in selected), 'excluded': sum(not r['eligible'] for r in selected)}, 'frequency': frequency}


def csv_output(headers, rows):
    out = io.StringIO(newline=''); writer = csv.writer(out); writer.writerow(headers)
    for row in rows:
        writer.writerow(["'"+v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v for v in row])
    return ('\ufeff'+out.getvalue()).encode()
