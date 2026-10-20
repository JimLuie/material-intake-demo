"""Read-only document quality summaries using the same observations as the charts."""
from collections import defaultdict
from analysis import observations, num, GRADE_METALS
from domain import default_units, validate_draft


def record_summaries(records, documents, notes, densities, price_basis="gross"):
    """Check saved ledger rows, never substitute a draft at the same position."""
    docs = {d['id']: d for d in documents}
    result = {}
    for row in observations(records, documents, [], notes, densities, price_basis):
        doc = docs.get(row.get('document_id'))
        if not doc:
            status, reason = 'unchecked', '無來源單據，無法檢查'
        elif doc['status'] != 'done':
            status, reason = 'pending', '原單待重新確認'
        elif row.get('duplicate_of'):
            status, reason = 'duplicate', '重複已合併，不重複納入分析'
        elif row.get('transaction_type') == 'customer_supplied':
            status, reason = 'customer_supplied', '客供料，無購料價格'
        elif row['eligible']:
            status, reason = 'usable', ''
        elif row.get('grade') and row['grade'] not in GRADE_METALS:
            status, reason = 'unsupported', row['reason']
        else:
            status, reason = 'needs_review', row['reason']
        result[row['id']] = dict(price_basis=price_basis, status=status,
            eligible=status == 'usable', reason=reason, transaction_type=row.get('transaction_type'), tax_basis=row.get('tax_basis'), tax_rate=row.get('tax_rate'), allocated_tax=row.get('allocated_tax'), gross_amount=row.get('gross_amount') if status!='pending' else None, gross_unit_kg=row.get('gross_unit_kg') if status!='pending' else None, tax_estimated=row.get('tax_estimated'), estimated_tax=row.get('estimated_tax'), primary_issue=row['primary_issue'],
            issues=row['issues'], duplicate_of=row.get('duplicate_of'),
            tax_unconfirmed=row['tax_basis'] == 'unknown' and row.get('transaction_type')!='customer_supplied',
            theoretical_weight=row['weight_source'] == 'theoretical' and bool(row['weight'] and row['weight'] > 0))
    return result


def preview_rows(doc, suppliers):
    draft = default_units(doc.get('draft') or {'meta': {}, 'items': []})
    meta = draft.get('meta', {}); rows = []
    for position, item in enumerate(draft.get('items', [])):
        try:
            row = validate_draft(dict(draft, items=[item]), suppliers)[0]
        except (ValueError, TypeError, OverflowError):
            # Preserve invalid values for diagnostics; one bad line must not hide other lines.
            row = dict(item, sup=meta.get('sup'), date=meta.get('date'), doc=meta.get('doc'),
                       grade=str(item.get('grade') or '').strip().upper(),
                       subtotal=meta.get('subtotal'), tax=meta.get('tax'), document_total=meta.get('total'))
            factor = {'mm': 1, 'cm': 10, 'inch': 25.4}.get(item.get('dim_unit'))
            dims = item.get('dims') if isinstance(item.get('dims'), list) else []
            row['dims'] = [round(num(d)*factor, 6) if num(d) is not None and factor else None for d in dims]
            issues = []
            def add(key, message, scope='item'): issues.append(dict(key=key, message=message, scope=scope, code=key))
            if meta.get('sup') not in suppliers: add('sup', '請確認供應商', 'meta')
            if not str(item.get('label') or '').strip(): add('label', '請填寫品名／材料名稱')
            if not factor: add('dim_unit', '請確認尺寸單位')
            if item.get('unit') not in ['件', '公斤', '支', '片', '張', '組', '公尺']: add('unit', '請確認數量單位')
            if item.get('pricing_basis', 'quantity') not in ['quantity', 'weight']: add('pricing_basis', '請確認計價依據')
            if num(item.get('qty')) is None or num(item.get('qty')) <= 0: add('qty', '數量必須是正數')
            for key, target in [('subtotal','subtotal'), ('tax','tax'), ('total','document_total')]:
                if meta.get(key) not in [None, ''] and (num(meta[key]) is None or num(meta[key]) < 0): add(key, '整單金額無效', 'meta')
            row['_input_issues'] = issues
        row.update(id=doc['id']+'-'+str(position), document_id=doc['id'], position=position)
        rows.append(row)
    return rows


def document_summaries(records, documents, notes, densities, suppliers, price_basis="gross"):
    previews = {d['id'] for d in documents if d['status'] == 'pending'}
    candidates = [r for r in records if r['document_id'] not in previews]
    for doc in documents:
        if doc['id'] in previews: candidates.extend(preview_rows(doc, suppliers))
    observed = observations(candidates, documents, [], notes, densities, price_basis, previews)
    groups = defaultdict(list)
    for row in observed: groups[row['document_id']].append(row)
    result = {}
    for doc in documents:
        rows = sorted(groups[doc['id']], key=lambda r: r['position']) if doc['status'] in ['pending', 'done'] else []; total = len(rows); usable = sum(r['eligible'] for r in rows)
        preview = doc['id'] in previews
        status = 'unchecked'
        if doc['status'] in ['pending', 'done']:
            if rows and all(r.get('duplicate_of') for r in rows): status = 'duplicate'
            elif rows and all(r.get('transaction_type')=='customer_supplied' for r in rows): status = 'customer_supplied'
            elif rows and all(r.get('grade') and r['grade'] not in GRADE_METALS for r in rows): status = 'unsupported'
            else: status = 'usable' if usable and usable == total else 'partial' if usable else 'needs_review'
        lines = []
        for row in rows:
            unique = {}
            for issue in row['issues']: unique.setdefault((issue['scope'], issue['key']), issue)
            issues = [dict(i, item=row['position'], page=row.get('page') or 1) for i in unique.values()]
            lines.append(dict(position=row['position'], page=row.get('page') or 1, eligible=row['eligible'],
                              transaction_type=row.get('transaction_type'), label=row.get('label') or '未列品名', grade=row.get('grade') or '', issues=issues,
                              tax_unconfirmed=row['tax_basis']=='unknown' and row.get('transaction_type')!='customer_supplied', theoretical_weight=row['weight_source']=='theoretical' and bool(row['weight'] and row['weight']>0),
                              duplicate_of=row.get('duplicate_of')))
        result[doc['id']] = dict(price_basis=price_basis, preview=preview, status=status, usable=usable,
                                total=total, lines=lines, issues=[i for line in lines for i in line['issues']],
                                tax_unconfirmed=sum(line['tax_unconfirmed'] for line in lines),
                                theoretical_weight=sum(line['theoretical_weight'] for line in lines))
    return result
