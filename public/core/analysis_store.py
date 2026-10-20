"""Analysis persistence is separate from the intake ledger and its export layout."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import re
from pathlib import Path
import uuid

from analysis import (DEFAULT_DENSITIES, DEFAULT_DENSITY_SOURCES, GRADE_METALS, DENSITY_URL, QUOTE_COLUMNS, observations, build_analysis, market_metal,
                      validate_note, validate_quote, quote_csv_preview, fingerprint, csv_output, num)
from market_data import MARKET_COLUMNS, FX_COLUMNS, csv_preview, fetch_worldbank, parse_cbc, download, CBC_URL
from steel_data import fetch_steel, SERIES as STEEL_SERIES


def now(): return datetime.now(timezone.utc).isoformat()


class AnalysisStore:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS analysis_notes(record_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS analysis_quotes(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS analysis_market(series TEXT NOT NULL, frequency TEXT NOT NULL, period TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(series,frequency,period));
            CREATE TABLE IF NOT EXISTS analysis_fx(source TEXT NOT NULL, frequency TEXT NOT NULL, period TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source,frequency,period));
            ''')
        self.update_lock = __import__('threading').Lock()

    def values(self, table):
        if table not in ['analysis_quotes', 'analysis_market', 'analysis_fx']: raise ValueError('無效資料來源')
        with self.store.connect() as db: return [json.loads(r[0]) for r in db.execute('SELECT data FROM '+table+' ORDER BY rowid DESC')]

    def settings(self):
        with self.store.connect() as db: saved = db.execute("SELECT value FROM settings WHERE key='analysis:settings'").fetchone()
        result = json.loads(saved[0]) if saved else {}
        # Merge lazily: upgrading never rewrites existing custom aluminium settings.
        result['densities'] = {**DEFAULT_DENSITIES, **result.get('densities', {})}
        legacy = result.get('density_source', DENSITY_URL)
        result['density_sources'] = {**DEFAULT_DENSITY_SOURCES, '6061': legacy, '7075': legacy, **result.get('density_sources', {})}
        result.setdefault('density_source', DENSITY_URL)
        return result

    def save_settings(self, data):
        if not isinstance(data, dict): raise ValueError('密度設定格式錯誤')
        densities = data.get('densities', {})
        if not isinstance(densities, dict) or not densities or not set(densities) <= set(DEFAULT_DENSITIES): raise ValueError('密度設定僅接受 S50C、6061 與 7075')
        for k, v in densities.items():
            if num(v) is None or not 1 <= num(v) <= 30: raise ValueError('密度請填 1–30 g/cm³')
        with self.store.lock:
            result = self.settings()
            sources = data.get('density_sources', {})
            if not isinstance(sources, dict) or not set(sources) <= set(DEFAULT_DENSITIES): raise ValueError('密度來源格式錯誤')
            if 'density_source' in data:
                result['density_source'] = str(data['density_source'])
                sources = {'6061': data['density_source'], '7075': data['density_source'], **sources}
            for grade, source in sources.items():
                if not isinstance(source, str) or not source.startswith('https://') or len(source) > 2000: raise ValueError('請填密度的 https 來源連結')
                result['density_sources'][grade] = source
            result['densities'].update({k: num(v) for k, v in densities.items()}); result['updated'] = now()
            with self.store.connect() as db: db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)', ('analysis:settings', json.dumps(result, ensure_ascii=False)))
        return result

    def market_prices(self):
        with self.store.connect() as db:
            overrides = {r[0].removeprefix('analysis:market-metal:'): r[1] for r in db.execute("SELECT key,value FROM settings WHERE key LIKE 'analysis:market-metal:%'")}
        rows = self.values('analysis_market')
        classes = {}
        for row in rows:
            if market_metal(row): classes.setdefault(row['series'], set()).add(market_metal(row))
        for row in rows:
            explicit = classes.get(row['series'], set())
            row['metal'] = overrides.get(row['series'], next(iter(explicit)) if len(explicit) == 1 else '')
        return rows

    def classify_market(self, series, metal):
        if metal not in ['aluminum', 'steel']: raise ValueError('請明確選擇鋁或鋼')
        with self.store.lock:
            if not any(r['series'] == series for r in self.values('analysis_market')): raise KeyError('找不到行情')
            if series == 'wb-aluminium' and metal != 'aluminum': raise ValueError('世界銀行鋁價的分類固定為鋁')
            if series in STEEL_SERIES and metal != 'steel': raise ValueError('SteelBenchmarker 鋼價的分類固定為鋼')
            with self.store.connect() as db: db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)', ('analysis:market-metal:'+series, metal))
        return {'series': series, 'metal': metal}

    def notes(self):
        with self.store.connect() as db: return {r['record_id']: {'fingerprint': r['fingerprint'], 'data': json.loads(r['data'])} for r in db.execute('SELECT * FROM analysis_notes')}

    def save_note(self, identifier, data):
        with self.store.lock:
            row = next((r for r in self.store.records() if r['id'] == identifier), None)
            if not row: raise KeyError('找不到來源材料')
            if data.get('fingerprint') != fingerprint(row): raise ValueError('原單已變動，請重新載入後核對補充資料')
            result = validate_note(data)
            with self.store.connect() as db:
                db.execute('INSERT OR REPLACE INTO analysis_notes VALUES(?,?,?)', (identifier, fingerprint(row), json.dumps(result, ensure_ascii=False)))
        return result

    def add_quote(self, data):
        row = validate_quote(data, self.store.suppliers())
        identifier = data.get('client_id') or uuid.uuid4().hex
        if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{32}', identifier): raise ValueError('報價請求代碼無效')
        with self.store.lock, self.store.connect() as db:
            previous = db.execute('SELECT data FROM analysis_quotes WHERE id=?', (identifier,)).fetchone()
            if previous:
                previous = json.loads(previous[0])
                if validate_quote(previous, self.store.suppliers()) != row: raise ValueError('這筆請求已保存為其他內容，請重新載入報價清單核對')
                return previous
            row.update(id=identifier, kind='quote', created=now(), void=False, attachments=[])
            db.execute('INSERT INTO analysis_quotes VALUES(?,?)', (row['id'], json.dumps(row, ensure_ascii=False)))
        return row

    def quote(self, identifier):
        with self.store.connect() as db: row = db.execute('SELECT data FROM analysis_quotes WHERE id=?', (identifier,)).fetchone()
        if not row: raise KeyError('找不到報價')
        return json.loads(row[0])

    def void_quote(self, identifier):
        with self.store.lock, self.store.connect() as db:
            row = self.quote(identifier); row['void'] = True; row['voided_at'] = now()
            db.execute('UPDATE analysis_quotes SET data=? WHERE id=?', (json.dumps(row, ensure_ascii=False), identifier))
        return row

    def attach_quote(self, identifier, name, content):
        name = Path(str(name).replace('\\', '/')).name[:160]
        ext = Path(name).suffix.lower()
        if ext not in {'.pdf', '.jpg', '.jpeg', '.png', '.heic', '.xlsx', '.csv'}: raise ValueError('報價附件支援 PDF、圖片、XLSX 或 CSV')
        if not content or len(content) > 50*1024*1024: raise ValueError('附件不可為空，最多 50 MB')
        with self.store.lock:
            row = self.quote(identifier)
            if row.get('void'): raise ValueError('已作廢報價不可新增附件')
            file_id = uuid.uuid4().hex+ext; folder = self.store.directory/'quote-files'/identifier
            folder.mkdir(parents=True, exist_ok=True); file = folder/file_id; file.write_bytes(content)
            row.setdefault('attachments', []).append({'name': name, 'file': file_id, 'url': f'/quote-files/{identifier}/{file_id}'})
            try:
                with self.store.connect() as db: db.execute('UPDATE analysis_quotes SET data=? WHERE id=?', (json.dumps(row, ensure_ascii=False), identifier))
            except Exception:
                file.unlink(); raise
        return row

    def import_preview(self, kind, content):
        if not isinstance(content, str) or len(content) > 4*1024*1024: raise ValueError('CSV 格式錯誤或超過 4 MB')
        if kind == 'quotes': return quote_csv_preview(content, self.store.suppliers(), self.values('analysis_quotes'))
        if kind not in ['market', 'fx']: raise ValueError('匯入類型無效')
        return csv_preview(kind, content, self.market_prices() if kind == 'market' else self.values('analysis_fx'))

    def import_csv(self, kind, content, replace=False):
        with self.store.lock:
            preview = self.import_preview(kind, content)
            if preview['errors']: raise ValueError('CSV 含錯誤，請修正全部錯誤後再匯入')
            rows = preview['rows']; inserted = 0
            if kind == 'quotes':
                with self.store.connect() as db:
                    for row in rows:
                        row.update(id=uuid.uuid4().hex, kind='quote', created=now(), void=False, attachments=[])
                        db.execute('INSERT INTO analysis_quotes VALUES(?,?)', (row['id'], json.dumps(row, ensure_ascii=False))); inserted += 1
            else: inserted = self.write_market(kind, rows, replace)
        return {'count': inserted, 'duplicates': preview['duplicates']}

    def write_market(self, kind, rows, replace=True):
        table, key = ('analysis_fx', 'source') if kind == 'fx' else ('analysis_market', 'series')
        changed = 0
        with self.store.lock, self.store.connect() as db:
            for row in rows:
                row = dict(row, updated=now())
                cursor = db.execute('INSERT OR '+('REPLACE' if replace else 'IGNORE')+' INTO '+table+' VALUES(?,?,?,?)', (row[key], row['frequency'], row['period'], json.dumps(row, ensure_ascii=False)))
                changed += cursor.rowcount
        return changed

    def update_market(self):
        if not self.update_lock.acquire(blocking=False): raise ValueError('行情正在更新，請稍候')
        try:
            results, errors = {}, []
            existing = self.values('analysis_market')
            full = not all(any(r['series'] == s and r.get('history_complete') for r in existing) for s in STEEL_SERIES)
            tasks = {'steel': lambda: fetch_steel(full), 'aluminium': fetch_worldbank, 'fx_monthly': lambda: parse_cbc(download(CBC_URL+'Month'), 'monthly'), 'fx_daily': lambda: parse_cbc(download(CBC_URL+'Day'), 'daily')}
            with ThreadPoolExecutor(max_workers=4) as pool:
                pending = {pool.submit(fn): key for key, fn in tasks.items()}
                for task in as_completed(pending):
                    key = pending[task]
                    try:
                        rows = task.result()
                        if key == 'steel':
                            # This marker is committed atomically with the validated full history.
                            rows = [dict(r, history_complete=True) for r in rows]
                        self.write_market('market' if key in ['aluminium', 'steel'] else 'fx', rows)
                        results[key] = {'count': len(rows), 'latest': max(r['period'] for r in rows)}
                        if key == 'steel':
                            results[key]['series'] = {s: {'count': sum(r['series']==s for r in rows), 'latest': max(r['period'] for r in rows if r['series']==s)} for s in STEEL_SERIES}
                    except Exception as e: errors.append(key+'：'+str(e))
            prices, rates = self.market_prices(), self.values('analysis_fx')
            reports = []
            for key, name, source in [('steel', '中國熱軋鋼材', STEEL_SERIES[0]), ('steel', '中國標準鋼板', STEEL_SERIES[1]),
                                      ('aluminium', '世界銀行鋁價', 'wb-aluminium'), ('fx_monthly', '央行月匯率', 'monthly'), ('fx_daily', '央行日匯率', 'daily')]:
                cached = [r for r in prices if r['series'] == source] if key in ['steel', 'aluminium'] else [r for r in rates if r['source']=='cbc' and r['frequency']==source]
                update = results.get(key, {})
                count = update.get('series', {}).get(source, {}).get('count', 0) if key=='steel' else update.get('count', 0)
                reports.append(dict(name=name, ok=key in results, count=count, cached_count=len(cached),
                                    latest=max((r['period'] for r in cached), default=None),
                                    error=next((e.split('：',1)[1] for e in errors if e.startswith(key+'：')), '')))
            return {'results': results, 'errors': errors, 'reports': reports, 'cached': True}
        finally: self.update_lock.release()

    def query(self, filters=None):
        filters = filters or {}
        with self.store.lock:
            state = self.store.state(include_analysis=False); settings = self.settings()
            documents = [d for d in state['documents'] if d.get('bucket', 'materials') == 'materials']
            obs = observations(state['records'], documents, self.values('analysis_quotes'), self.notes(), settings['densities'], filters.get('price_basis', 'material'))
            prices, fx = self.market_prices(), self.values('analysis_fx')
        result = build_analysis(obs, prices, fx, filters)
        # Frozen review queues must also see resolved rows that left the active chart filters.
        result['review_lookup'] = {r['id']: r for r in obs}
        definitions = {}
        for p in prices:
            if p['series'] not in definitions: definitions[p['series']] = dict(p, first=p['period'], last=p['period'])
            definition = definitions[p['series']]; definition['first'] = min(definition['first'], p['period']); definition['last'] = max(definition['last'], p['period'])
            definition['updated'] = max(definition.get('updated', ''), p.get('updated', ''))
        rate_defs = {}
        for r in fx:
            key = r['source']+'|'+r['frequency']
            rate_defs.setdefault(key, dict(source=r['source'], frequency=r['frequency'], first=r['period'], last=r['period']))
            rate_defs[key]['first'] = min(rate_defs[key]['first'], r['period']); rate_defs[key]['last'] = max(rate_defs[key]['last'], r['period'])
        confirmed = {d['id'] for d in documents if d['status'] == 'done' and d.get('ledger_active', 1)}
        result.update(settings=settings, sources=list(definitions.values()), fx_sources=list(rate_defs.values()),
            grades=sorted({r.get('grade') for r in obs if r.get('grade') in GRADE_METALS and (r['kind'] == 'quote' or r.get('document_id') in confirmed)}), grade_metals=GRADE_METALS,
            global_counts={'invoices': len(confirmed), 'records': len(state['records']), 'quotes': len(self.values('analysis_quotes'))})
        return result

    def document_summaries(self, records, documents):
        from analysis_quality import document_summaries
        return document_summaries(records, documents, self.notes(), self.settings()['densities'], self.store.suppliers())

    def record_summaries(self, records, documents):
        from analysis_quality import record_summaries
        return record_summaries(records, documents, self.notes(), self.settings()['densities'])

    def export(self, kind, filters=None):
        if kind == 'quotes':
            rows = []
            for q in self.values('analysis_quotes'):
                r = dict(q, supplier=self.store.suppliers().get(q['sup'], {}).get('name', q['sup']))
                r.update({'dim'+str(i+1): d for i, d in enumerate(q['dims'])})
                rows.append([r.get(k) for k in QUOTE_COLUMNS]+[q['id'], '已作廢' if q.get('void') else '未作廢'])
            return csv_output(QUOTE_COLUMNS+['id', 'status'], rows)
        result = self.query(filters)
        headers = ['來源', '日期', '供應商', '單號', '牌號', '調質', '形狀', '尺寸(mm)', '原數量', '數量單位', '重量(kg)', '重量來源', '未稅材料費(TWD)', '單價(TWD/kg)', '納入分析', '排除原因', '來源ID']
        return csv_output(headers+['價格口徑', '稅別狀態', '原單單價換算(TWD/kg)', '交易性質', '單價稅別', '稅率(%)', '原單單價(TWD)', '原單明細金額(TWD)', '分攤稅額(TWD)', '含稅成交金額(TWD)', '含稅成交公斤價(TWD/kg)'], [[r['kind'], r['date'], self.store.suppliers().get(r['sup'], {}).get('name', r['sup']), r.get('doc'), r.get('grade'), r['temper'], r.get('shape', 'rect'), ' × '.join(map(str, r.get('dims', []))), r.get('qty'), r.get('unit'), r['weight'], r['weight_source'], r['material_cost'], r['unit_kg'], r['eligible'], r['reason'], r['id'], r['price_basis'], r['tax_status'], r['original_unit_kg'], r.get('transaction_type'), r.get('tax_basis'), r.get('tax_rate'), r.get('price'), r.get('amount'), r.get('allocated_tax'), r.get('gross_amount'), r.get('gross_unit_kg')] for r in result['observations']])
