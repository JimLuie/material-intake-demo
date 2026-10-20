"""Document tax context and exact-cent allocation; never modifies source money."""
from decimal import Decimal, ROUND_HALF_UP, ROUND_FLOOR, localcontext
from billing import decimal_value, billing_quantity

CENT = Decimal('.01')
TOL = Decimal('.02000001')
TAX_FIELDS = ['transaction_type', 'tax_basis', 'tax_rate']

def dec(v):
    result = decimal_value(v)
    return result if result is not None and abs(result)<=Decimal("1e18") else None

def money(v):
    with localcontext() as ctx:
        ctx.prec = 60
        return v.quantize(CENT, rounding=ROUND_HALF_UP)

def settings(value=None):
    value = value or {}
    if not isinstance(value, dict): raise ValueError('稅務設定格式錯誤')
    result = dict(transaction_type=value.get('transaction_type', 'purchase'), tax_basis=value.get('tax_basis', 'unknown'), tax_rate=value.get('tax_rate', 5))
    if result['transaction_type'] not in ['purchase', 'customer_supplied']: raise ValueError('交易性質無效')
    if result['tax_basis'] not in ['unknown', 'included', 'pretax']: raise ValueError('單價稅別無效')
    rate = dec(result['tax_rate'])
    if rate is None or rate < 0 or rate > 100: raise ValueError('稅率須為 0–100%')
    result['tax_rate'] = float(rate)
    result['source'] = str(value.get('source') or 'unconfirmed')[:200]
    result['evidence'] = str(value.get('evidence') or '')[:2000]
    return result

def suggest(draft):
    meta = (draft or {}).get('meta', {})
    sup = meta.get('sup'); tax = dec(meta.get('tax'))
    out = settings()
    if sup == 'sk' and meta.get('tax') in [None, '']:
        out.update(tax_basis='included', source='company_rule', evidence='公司已確認：示範鋼材二廠此版型未列營業稅時，報價已含稅；合計與總計同額不再加稅。')
    elif sup in ['hh', 'zm'] and tax is not None:
        out.update(tax_basis='pretax', source='printed_tax', evidence='示範鋁材一廠／示範金屬四廠版型：原單另列營業稅，明細為未稅金額，右下總計含稅。')
    elif sup == 'zf':
        out.update(transaction_type='customer_supplied', source='company_rule', evidence='公司已確認此示範鋁業三廠範本為客供料；數量合計不代表金額。')
    return out

def draft_context(draft):
    if 'tax_settings' not in draft: draft['tax_settings'] = suggest(draft)
    return draft

def context(doc, preview=False):
    return settings((doc.get('draft') or {}).get('tax_settings') if preview else doc.get('tax_settings'))

def allocate(amounts, tax):
    """Largest-remainder cents. Ties use original line order, including zero lines."""
    amounts = [money(dec(v)) for v in amounts]; tax = money(dec(tax))
    if any(v < 0 for v in amounts) or tax < 0: raise ValueError('金額不可為負數')
    total = sum(amounts)
    if total == 0:
        if tax: raise ValueError('零元小計不能分攤非零稅額')
        return [Decimal('0.00') for _ in amounts]
    exact = [tax * a / total for a in amounts]
    base = [v.quantize(CENT, rounding=ROUND_FLOOR) for v in exact]
    cents = int((tax-sum(base))/CENT)
    order = sorted(range(len(base)), key=lambda i: (-(exact[i]-base[i]), i))
    for i in order[:cents]: base[i] += CENT
    return base

def gross_document(rows, cfg):
    """Reconcile the entire invoice before allocating, independent of chart filters."""
    cfg = settings(cfg); rows = sorted(rows, key=lambda r: r.get('position', 0))
    out = {r['id']: dict(allocated_tax=None, gross_amount=None, estimated_tax=None, tax_issues=[]) for r in rows}
    if not rows: return out
    def problem(key, message):
        for v in out.values(): v['tax_issues'].append(dict(key=key, message=message, scope='tax' if key in ['tax_basis','tax_rate'] else 'item' if key=='amount' else 'meta', code='tax_reconciliation'))
    if cfg['transaction_type'] == 'customer_supplied': return out
    if cfg['tax_basis'] == 'unknown': problem('tax_basis', '單價稅別待確認'); return out
    amounts = [dec(r.get('amount')) for r in rows]
    if any(v is None or v < 0 for v in amounts): problem('amount', '整張有明細金額未列或無效，請逐筆核對'); return out
    amounts = [money(v) for v in amounts]; subtotal = sum(amounts)
    first = rows[0]; printed_sub, tax, total = [dec(first.get(k)) for k in ['subtotal', 'tax', 'document_total']]
    for key, v in [('subtotal', printed_sub), ('tax', tax), ('total', total)]:
        raw = first.get('document_total' if key == 'total' else key)
        if raw not in [None, ''] and (v is None or v < 0): problem(key, '整單金額無效，請核對原單')
    if cfg['tax_basis'] == 'included':
        expected = subtotal
        if printed_sub is not None and money(printed_sub) != subtotal: problem('subtotal', '明細合計與原單小計不符，請核對原單')
        if total is None: problem('total', '缺少整單含稅總計，無法勾稽')
        elif money(total) != expected: problem('total', '已含稅明細合計與整單含稅總計不符；不得再次加稅')
        taxes = [None for _ in amounts]
        estimated = (subtotal-subtotal/(1+dec(cfg['tax_rate'])/100)).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
        if tax is not None and abs(tax-estimated) > Decimal('1'): problem('tax', '原單營業稅與內含稅拆算矛盾，請核對稅別或稅率')
        gross = amounts
    else:
        estimated = (subtotal*dec(cfg['tax_rate'])/100).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
        if printed_sub is not None and money(printed_sub) != subtotal: problem('subtotal', '明細未稅合計與原單小計不符，請核對原單')
        # An explicitly confirmed tax context authorizes a calculation, not a write to the original tax field.
        applied_tax = money(tax) if tax is not None else estimated
        expected = subtotal+applied_tax
        if total is None: problem('total', '缺少整單含稅總計，無法勾稽')
        elif money(total) != expected: problem('total', '未稅明細合計＋營業稅與整單含稅總計不符')
        try: taxes = allocate(amounts, applied_tax)
        except ValueError as e: problem('tax', str(e)); taxes = [None for _ in amounts]
        gross = [a+t if t is not None else None for a,t in zip(amounts, taxes)]
    for r, g, t in zip(rows, gross, taxes):
        v = out[r['id']]; v['estimated_tax'] = float(estimated)
        v['tax_estimated'] = tax is None
        if not v['tax_issues']:
            v.update(gross_amount=float(g) if g is not None else None, allocated_tax=float(t) if t is not None else None)
    return out

def gross_price_issues(row):
    """A missing unit price is allowed; an explicit contradictory price is not."""
    issues = []
    def add(key, message): issues.append(dict(key=key, message=message, scope='item', code=key))
    for key in ['price', 'material_amount', 'processing_fee', 'amount']:
        raw = row.get(key); v = dec(raw)
        if raw not in [None, ''] and (v is None or v < 0): add(key, '原單金額或加工費無效，請核對原單')
    price, qty, amount, fee, material = [dec(v) for v in [row.get('price'), billing_quantity(row), row.get('amount'), row.get('processing_fee'), row.get('material_amount')]]
    if price is not None and price >= 0:
        if qty is None or qty <= 0: add('weight_kg' if row.get('pricing_basis')=='weight' else 'qty', '單價已列，計價數量未列或無效')
        else:
            expected = money(price*qty)
            if material is not None and abs(expected-material) > TOL: add('material_amount', '單價 × 計價數量與原單材料費不符，請核對原單')
            if amount is not None and abs(expected+(fee or 0)-amount) > TOL: add('amount', '單價 × 計價數量＋已列加工費與明細金額不符，請核對原單')
    if material is not None and amount is not None and fee is not None and abs(material+fee-amount)>TOL: add('amount', '材料費＋加工費與明細金額不符')
    return issues
