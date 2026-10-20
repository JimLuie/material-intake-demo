"""Document location is independent of recognition, confirmation and material validity."""
import json
import re

BUCKETS = {'materials': '材料區', 'review': '待分類池', 'trash': '垃圾桶'}
CATEGORIES = {'': '尚未分類', 'tools': '刀具', 'consumables': '耗材', 'other': '其他'}


class OrganizationConflict(ValueError):
    pass


def is_material(doc):
    return doc.get('bucket', 'materials') == 'materials'


def suggestion(ocr, draft):
    """Only literal product evidence; missing fields/vendor are never evidence."""
    draft = draft or {}
    texts = [str(i.get('label', '')) for i in draft.get('items', [])]
    # Saved OCR is also useful when the material parser intentionally found no rows.
    pages = (ocr or {}).get('pages', [])
    for page in pages:
        lines = page.get('lines', [])
        headers = [line.get('y', 0) for line in lines if isinstance(line, dict) and re.search(r'品\s*名|材\s*質|產\s*品\s*名', line.get('text', ''))]
        start = min(headers) if headers else .18
        values = [str(line.get('text', '')) if isinstance(line, dict) else str(line) for line in lines
                  if not isinstance(line, dict) or 'y' not in line or start <= line['y'] <= .72]
        texts.extend(value for value in values if not re.search(r'公司|興業社|地址|電話|TEL|FAX|備註|注意|保固', value, re.I))
    if not pages:
        raw = str(draft.get('text', draft.get('raw', '')))
        header = re.search(r'品\s*名|材\s*質|產\s*品\s*名', raw)
        if header:
            texts.append(raw[header.end():].split('以下空白')[0].split('備註')[0])
    evidence = []
    patterns = {
        'consumables': r'清洗劑|清潔劑|切削液|切削油|潤滑油|冷卻液|擦拭布|砂紙|研磨液|防鏽油',
        'tools': r'銑刀|鑽頭|刀片|絲攻|鉸刀|車刀|鎢鋼刀',
    }
    for category, pattern in patterns.items():
        for text in texts:
            for match in re.finditer(pattern, text):
                term = match.group()
                if not any(e['term'] == term for e in evidence):
                    evidence.append({'category': category, 'term': term,
                                     'text': text[max(0, match.start()-24):match.end()+32].strip()[:100]})
    # Grade and geometry must appear in product rows, not in address/phone/stock boilerplate.
    material = any(re.search(r'\b(?:S50C|SKD11|SKD61|6061|7075)\b|圓條\s*[ØøΦφ\d]|(?:鋁板|鋼板|鋁棒|鋼棒)\s*\d', text, re.I)
                   for text in texts)
    cats = {e['category'] for e in evidence}
    mixed = bool(evidence) and (material or len(cats) > 1)
    return {'category': next(iter(cats)) if len(cats) == 1 else '',
            'evidence': evidence, 'mixed': mixed}


def migrate(store):
    with store.lock, store.connect() as db:
        columns = {r['name'] for r in db.execute('PRAGMA table_info(documents)')}
        for name, declaration in {
            'bucket': "TEXT NOT NULL DEFAULT 'materials'",
            'category': "TEXT NOT NULL DEFAULT ''",
            'ledger_active': 'INTEGER NOT NULL DEFAULT 1',
            'organization': "TEXT NOT NULL DEFAULT '{}'",
            'organization_version': 'INTEGER NOT NULL DEFAULT 0',
        }.items():
            if name not in columns:
                db.execute(f'ALTER TABLE documents ADD COLUMN {name} {declaration}')
        # Backfill suggestions only; do not touch old drafts, status, amount or location.
        for row in db.execute("SELECT id,ocr,draft,organization FROM documents").fetchall():
            meta = json.loads(row['organization'])
            if 'suggestion' not in meta:
                meta['suggestion'] = suggestion(json.loads(row['ocr'] or '{}'), json.loads(row['draft'] or '{}'))
                db.execute('UPDATE documents SET organization=? WHERE id=?', (json.dumps(meta, ensure_ascii=False), row['id']))


def guard_material(row, version=None):
    if not row:
        raise KeyError('找不到單據')
    if row['bucket'] != 'materials':
        raise OrganizationConflict('單據已移至'+BUCKETS[row['bucket']]+'，本頁不能保存或確認；請至目前所在區域查看。')
    if version is not None and row['organization_version'] != version:
        raise OrganizationConflict('單據整理位置已變更，本頁版本已過期；請重新開啟單據，避免覆蓋目前草稿。')


def organize(store, identifier, data):
    if not isinstance(data, dict):
        raise ValueError('整理操作格式錯誤')
    action = data.get('action')
    if action not in ['park', 'material', 'trash', 'restore', 'metadata']:
        raise ValueError('不支援的整理操作')
    with store.lock, store.connect() as db:
        row = db.execute('SELECT * FROM documents WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise KeyError('找不到單據')
        if row['status'] in ['queued', 'extracting']:
            raise OrganizationConflict('單據仍在排隊或辨識中，請等辨識完成後再整理。')
        meta = json.loads(row['organization'])
        bucket, category, active = row['bucket'], row['category'], row['ledger_active']
        version = data.get('expected_version')
        if isinstance(version, bool) or not isinstance(version, int):
            raise ValueError('缺少單據整理版本，請重新整理頁面')
        # Repeating a completed move must be a no-op, especially for trash restore info.
        same = (action == 'trash' and bucket == 'trash') or (action == 'park' and bucket == 'review') or (action == 'material' and bucket == 'materials')
        if same:
            return store.public_document(row)
        if version != row['organization_version']:
            raise OrganizationConflict('單據已被其他頁面整理，請更新清單後重試；目前內容未覆蓋。')
        target = {'park': 'review', 'material': 'materials', 'trash': 'trash'}.get(action, bucket)
        if action == 'restore':
            if bucket != 'trash':
                raise OrganizationConflict('此單據不在垃圾桶，無須還原')
            restore = meta.get('restore', {})
            target = restore.get('bucket', 'review')
            if target not in ['materials', 'review']:
                target = 'review'
            category = restore.get('category', '')
        if action == 'metadata' and bucket != 'review':
            raise OrganizationConflict('請在待分類池編輯類別與備註')
        if action == 'park' and bucket == 'trash':
            raise OrganizationConflict('請先從垃圾桶還原')
        if action == 'material' and bucket == 'trash':
            raise OrganizationConflict('請先從垃圾桶還原')
        if action in ['park', 'metadata']:
            category = data.get('category', category)
            note = data.get('note', meta.get('note', ''))
            if category not in CATEGORIES or not isinstance(note, str) or len(note) > 2000:
                raise ValueError('類別或備註格式不正確（備註最多 2000 字）')
            meta.update(manual=True, note=note)
        affected = db.execute('SELECT COUNT(*) FROM records WHERE document_id=?', (identifier,)).fetchone()[0] if active and bucket == 'materials' else 0
        if affected and target != 'materials':
            if data.get('acknowledge_records') is not True or data.get('expected_record_count') != affected:
                raise OrganizationConflict(f'此單據有 {affected} 筆有效材料，移出後將退出總表、查詢、分析及匯出；請確認影響筆數後操作。')
        if action == 'trash':
            meta['restore'] = {'bucket': bucket, 'category': category}
        elif action == 'restore':
            meta.pop('restore', None)
        draft = json.loads(row['draft']) if row['draft'] else None
        status = row['status']
        if target != bucket:
            active = 0
            if target == 'materials':
                status = 'pending'
                if draft is not None:
                    draft.pop('review_progress', None)
        db.execute('UPDATE documents SET bucket=?,category=?,ledger_active=?,organization=?,organization_version=organization_version+1,status=?,draft=? WHERE id=?',
                   (target, category, active, json.dumps(meta, ensure_ascii=False), status,
                    json.dumps(draft, ensure_ascii=False) if draft is not None else None, identifier))
    return store.document(identifier)
