"""Versioned document tax settings; batch updates never rewrite original records."""
import json
from taxation import settings, suggest, gross_document, gross_price_issues, TAX_FIELDS
from document_organization import guard_material, OrganizationConflict

class TaxConflict(OrganizationConflict): pass

def migrate(store):
    with store.connect() as db:
        cols = {r[1] for r in db.execute('PRAGMA table_info(documents)')}
        for key, spec in [('tax_context', "TEXT NOT NULL DEFAULT '{}'"), ('content_version', 'INTEGER NOT NULL DEFAULT 0')]:
            if key not in cols: db.execute(f'ALTER TABLE documents ADD COLUMN {key} {spec}')

def guard(row, version):
    if version is not None and (isinstance(version, bool) or int(version) != row['content_version']):
        raise TaxConflict('單據或稅務設定已有較新版本，未保存本頁內容；請重新載入並比對目前修改。')

def rows_for(draft, identifier):
    meta = draft.get('meta', {})
    return [dict(item, id=identifier+'-'+str(i), position=i, subtotal=meta.get('subtotal'), tax=meta.get('tax'), document_total=meta.get('total')) for i,item in enumerate(draft.get('items', []))]

def correction_preview(store, identifier):
    from domain import parse_ocr
    with store.connect() as db:
        row = db.execute('SELECT * FROM documents WHERE id=?', (identifier,)).fetchone()
        if not row: raise KeyError('找不到單據')
        guard_material(row)
        old = json.loads(row['draft'] or '{}'); parsed = parse_ocr(json.loads(row['ocr'] or '{}')) if row['ocr'] else None
    differences = []
    if parsed:
        for i, item in enumerate(parsed.get('items', [])):
            previous = (old.get('items') or [])[i] if i<len(old.get('items', [])) else {}
            for key in ['label', 'grade', 'part_no', 'shape', 'dims', 'qty', 'unit', 'price', 'amount', 'weight_kg', 'processing_fee', 'material_amount', 'pricing_basis']:
                if previous.get(key) != item.get(key): differences.append(dict(item=i, key=key, old=previous.get(key), new=item.get(key)))
        for key in ['sup', 'date', 'doc', 'subtotal', 'tax', 'total']:
            if old.get('meta', {}).get(key) != parsed.get('meta', {}).get(key): differences.append(dict(item=None, key=key, old=old.get('meta', {}).get(key), new=parsed.get('meta', {}).get(key)))
    return dict(id=identifier, version=row['content_version'], differences=differences, candidate=parsed, message='僅使用保存的 OCR 重新解析；不寫入原單。候選可能仍有誤，需對照原圖並確認整張。')

def preview(store):
    result = []
    with store.lock, store.connect() as db:
        for raw in db.execute("SELECT * FROM documents WHERE bucket='materials' AND draft IS NOT NULL ORDER BY created DESC"):
            row = dict(raw); draft = json.loads(row['draft']); saved = json.loads(row['tax_context']); proposed = settings(saved) if saved else suggest(draft)
            # Reconcile confirmed originals, not a newer draft against old material positions.
            records = [dict(json.loads(r['data']), id=r['id'], position=r['position']) for r in db.execute('SELECT * FROM records WHERE document_id=? ORDER BY position', (row['id'],))] if row['status']=='done' else rows_for(draft,row['id'])
            converted = gross_document(records, proposed); conflicts = []
            for r in records:
                if proposed['transaction_type']!='customer_supplied': conflicts += [i['message'] for i in gross_price_issues(r)]
                conflicts += [i['message'] for i in converted[r['id']]['tax_issues']]
            if row['status']!='done': conflicts.append('單據尚未確認；請在核對頁保存稅務設定並完成整張核對')
            known = proposed['source']!='unconfirmed'
            result.append(dict(id=row['id'], name=row['name'], doc=draft.get('meta',{}).get('doc',''), sup=draft.get('meta',{}).get('sup',''), version=row['content_version'], organization_version=row['organization_version'], status=row['status'], original=dict(settings=saved, subtotal=draft.get('meta',{}).get('subtotal'), tax=draft.get('meta',{}).get('tax'), total=draft.get('meta',{}).get('total')), suggested=proposed, conflicts=list(dict.fromkeys(conflicts)), selectable=row['status']=='done', selected=row['status']=='done' and not saved and known and not conflicts, converted=list(converted.values()), correction_count=len(correction_preview(store,row['id'])['differences'])))
    return {'documents':result, 'message':'預覽不會寫入。批次僅保存勾選單據的交易性質、稅別與稅率；原單金額及草稿不變。'}

def apply(store, data):
    selections=data.get('documents') if isinstance(data,dict) else None
    if not isinstance(selections,list) or not 1<=len(selections)<=500: raise ValueError('請勾選 1–500 張單據')
    ids=[r.get('id') for r in selections if isinstance(r,dict)]
    if len(ids)!=len(selections) or len(set(ids))!=len(ids): raise ValueError('單據選擇重複或格式錯誤')
    with store.lock,store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        changes=[]
        for selected in selections:
            raw=db.execute('SELECT * FROM documents WHERE id=?',(selected['id'],)).fetchone()
            if not raw: raise KeyError('找不到單據')
            if 'version' not in selected or 'organization_version' not in selected: raise ValueError('缺少單據版本，請重新預覽')
            guard_material(raw,selected['organization_version']);guard(raw,selected['version'])
            if raw['status']!='done': raise TaxConflict('單據已進入待確認，請逐張核對，不套用舊預覽')
            cfg=settings(selected.get('settings'));cfg['source']='manual_batch';cfg['evidence']=str(selected.get('settings',{}).get('evidence') or '使用者於稅別預覽勾選確認')[:2000]
            changes.append((json.dumps(cfg,ensure_ascii=False),selected['id']))
        for cfg,identifier in changes:
            db.execute('UPDATE documents SET tax_context=?,content_version=content_version+1 WHERE id=?',(cfg,identifier))
    return {'ok':True,'count':len(changes)}
