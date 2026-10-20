"""Browser RPC for the original ledger rules. No HTTP server or remote documents."""
import io
import json
import mimetypes
from pathlib import Path
import shutil
import sqlite3
import zipfile
from urllib.parse import urlsplit, parse_qs, unquote
from server import Store, csv_bytes, re_identifier, SerialLock, BrowserJobs, ClosingConnection
from domain import search_materials, parse_ocr
from taxation import draft_context
from document_organization import guard_material, suggestion, OrganizationConflict
import tax_store
from analysis import QUOTE_COLUMNS, csv_output
from market_data import MARKET_COLUMNS, FX_COLUMNS, parse_worldbank, parse_cbc
from steel_data import parse_steel

store = None

def init_store(directory='/demo-data'):
    global store
    store = Store(directory)
    store.executor.shutdown(wait=True)
    store.executor = BrowserJobs()
    store.analysis.update_lock = SerialLock()
    with store.connect() as db:
        return bool(db.execute("SELECT 1 FROM settings WHERE key='demo:seed-v1'").fetchone())

def reset_store():
    directory=str(store.directory)
    for p in store.directory.iterdir():
        shutil.rmtree(p) if p.is_dir() else p.unlink()
    return init_store(directory)

def snapshot_request(path, body_json='{}'):
    """Small database rollback plus only files a request can overwrite."""
    with store.connect() as db, sqlite3.connect(':memory:', factory=ClosingConnection) as target:
        db.backup(target); database=target.serialize()
    files=[str(p.relative_to(store.directory)) for p in store.directory.rglob('*') if p.is_file()]
    replaced={}
    if path=='/internal/preview':
        body=json.loads(body_json);name='files/'+body['id']+'/page-'+str(body['page'])+'.jpg'
        if (store.directory/name).is_file():replaced[name]=(store.directory/name).read_bytes()
    if path=='/internal/restore':replaced={name:(store.directory/name).read_bytes() for name in files if name!='ledger.sqlite3'}
    return dict(database=database,files=files,replaced=replaced)

def rollback_request(snapshot):
    snapshot=snapshot.to_py() if hasattr(snapshot,'to_py') else snapshot
    for p in store.directory.rglob('*'):
        if p.is_file() and str(p.relative_to(store.directory)) not in snapshot['files']:p.unlink()
    (store.directory/'ledger.sqlite3').write_bytes(bytes(snapshot['database']))
    for name,data in snapshot['replaced'].items():
        p=store.directory/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(bytes(data))

def seed_one(spec_json, original, pages):
    spec = json.loads(spec_json)
    identifier = store.import_bytes(spec['name'], bytes(original), submit=False)['id']
    folder = store.directory/'files'/identifier
    ocr = spec['ocr']
    for index, page in enumerate(ocr['pages']):
        (folder/page['preview']).write_bytes(bytes(pages[index]))
    draft = spec['draft']
    with store.connect() as db:
        db.execute("UPDATE documents SET status='pending',draft=?,ocr=?,created=? WHERE id=?", (json.dumps(draft,ensure_ascii=False), json.dumps(ocr,ensure_ascii=False), draft['meta']['date']+'T09:00:00+08:00',identifier))
    if spec.get('status') == 'done': store.confirm(identifier,draft)
    bucket = spec.get('bucket','materials')
    if bucket in ['review','trash']:
        doc_count = sum(r['document_id']==identifier for r in store.records())
        store.organize(identifier,dict(action='park',category=spec.get('category') or 'other',note=spec.get('note','虛構示範單據'),expected_version=0,acknowledge_records=True,expected_record_count=doc_count))
        if bucket == 'trash': store.organize(identifier,dict(action='trash',expected_version=1))
    return identifier

def finish_seed(spec_json):
    spec=json.loads(spec_json)
    for quote in spec.get('quotes',[]): store.analysis.add_quote(quote)
    if spec.get('market'): store.analysis.write_market('market',spec['market'])
    if spec.get('fx'): store.analysis.write_market('fx',spec['fx'])
    with store.connect() as db: db.execute("INSERT OR REPLACE INTO settings VALUES('demo:seed-v1','true')")

def file_versions():
    result={}
    for directory in ['files','quote-files']:
        for p in (store.directory/directory).rglob('*'):
            if p.is_file(): result['/'+p.relative_to(store.directory).as_posix()]=str(p.stat().st_mtime_ns)+':'+str(p.stat().st_size)
    return result

def binary(data,mime,name='download'):
    return dict(status=200,bytes=data,mime=mime,name=name)

def restore_backup(content):
    raw=bytes(content)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names=z.namelist()
        if 'data/ledger.sqlite3' not in names: raise ValueError('備份缺少資料庫')
        if sum(i.file_size for i in z.infolist()) > 500*1024*1024: raise ValueError('解壓縮備份超過 500 MB')
        for name in names:
            path=Path(name)
            if path.is_absolute() or '..' in path.parts: raise ValueError('備份路徑不正確')
            if name.startswith('data/') and not (name=='data/ledger.sqlite3' or name.startswith(('data/files/','data/quote-files/'))):
                raise ValueError('備份含有不支援的檔案')
        # Validate in a separate directory before replacing anything.
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            candidate=Path(temp)/'ledger.sqlite3';candidate.write_bytes(z.read('data/ledger.sqlite3'))
            with sqlite3.connect(candidate, factory=ClosingConnection) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok': raise ValueError('備份資料庫損壞')
                if not db.execute("SELECT 1 FROM settings WHERE key='demo:seed-v1'").fetchone(): raise ValueError('請使用此 Demo 匯出的備份')
                for table in ['documents','records','analysis_notes','analysis_quotes','analysis_market','analysis_fx']:
                    db.execute('SELECT COUNT(*) FROM '+table).fetchone()
            for child in list(store.directory.iterdir()):
                if child.is_dir(): shutil.rmtree(child)
                else: child.unlink()
            for name in names:
                if not name.startswith('data/') or name.endswith('/'): continue
                dest=store.directory/Path(name).relative_to('data');dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(z.read(name))
    init_store(str(store.directory))
    return {'ok':True}

def perform(method,path,body,headers,content):
    url=urlsplit(path);p=unquote(url.path);q=parse_qs(url.query);a=store.analysis
    arg=lambda key,default='':q.get(key,[default])[0]
    if p=='/api/state':
        result=store.state();result['storage']='此瀏覽器';result['_file_versions']=file_versions();return result
    if p=='/api/health': return dict(ok=True,app='material-demo',ocr_ready=True,version=1)
    if p=='/api/search':
        mode=arg('mode','text');filters={k:q[k][0] for k in ['shape','dims','grade','metal','missing_grade'] if k in q} if mode=='structured' else None
        if mode not in ['text','structured'] or (mode=='structured' and arg('q')): raise ValueError('查詢模式無效')
        return search_materials(store.records(),arg('q'),arg('allow',0),filters=filters)
    if p=='/api/upload' and method=='POST': return store.import_bytes(arg('name','upload.jpg'),bytes(content))
    if p=='/api/suppliers' and method=='POST': return dict(id=store.add_supplier(body.get('name','')),suppliers=store.suppliers())
    if p=='/api/documents/tax-preview': return tax_store.preview(store)
    if p=='/api/documents/tax-apply' and method=='POST': return tax_store.apply(store,body)
    if p.startswith('/api/documents/'):
        parts=p.strip('/').split('/');identifier,action=parts[2:4]
        version=int(headers.get('X-MaterialDemo-Document-Version','0'));cv=int(headers.get('X-MaterialDemo-Content-Version','0'))
        if action=='recognition-preview':return tax_store.correction_preview(store,identifier)
        if method!='POST':raise KeyError('找不到操作')
        if action=='organize':return dict(ok=True,document=store.organize(identifier,body))
        if action=='draft':
            summary=store.save_draft(identifier,body,version,cv);return dict(ok=True,analysis_summary=summary,content_version=summary['content_version'])
        if action=='confirm':return dict(ok=True,count=store.confirm(identifier,body,version,cv),content_version=store.document(identifier)['content_version'])
        if action=='retry':store.retry(identifier,body.get('replace',False),version,cv);return dict(ok=True)
    if p=='/api/analysis':
        filters=json.loads(arg('filter','{}'))
        if 'price_basis' in q:filters['price_basis']=arg('price_basis')
        return a.query(filters)
    if p=='/api/quotes':return a.add_quote(body) if method=='POST' else dict(quotes=a.values('analysis_quotes'))
    if p=='/api/analysis/settings' and method=='POST':return a.save_settings(body)
    if p in ['/api/analysis/preview','/api/analysis/import'] and method=='POST':
        return a.import_preview(body.get('kind'),body.get('content')) if p.endswith('/preview') else a.import_csv(body.get('kind'),body.get('content'),body.get('replace') is True)
    if p.startswith('/api/analysis/notes/') and method=='POST':return a.save_note(p.split('/')[-1],body)
    if p.startswith('/api/analysis/market-sources/') and method=='POST':return a.classify_market(p.split('/')[-1],body.get('metal'))
    if p.startswith('/api/quotes/') and method=='POST':
        parts=p.split('/');identifier,action=parts[3:5]
        if action=='void':return a.void_quote(identifier)
        if action=='attachment':return a.attach_quote(identifier,arg('name','attachment.pdf'),bytes(content))
    if p=='/api/backup':return binary(store.backup(),'application/zip','material-demo-backup.zip')
    if p=='/api/export.csv':return binary(csv_bytes(store.state()['records'],store.suppliers()),'text/csv;charset=utf-8','material-demo-materials.csv')
    if p=='/api/analysis/export.csv':return binary(a.export(arg('kind','analysis'),json.loads(arg('filter','{}'))),'text/csv;charset=utf-8','material-demo-analysis.csv')
    if p=='/api/analysis/template':
        kind=arg('kind','quotes');columns={'quotes':QUOTE_COLUMNS,'market':MARKET_COLUMNS,'fx':FX_COLUMNS}.get(kind)
        if not columns:raise ValueError('範本類型無效')
        return binary(csv_output(columns,[]),'text/csv;charset=utf-8','material-demo-'+kind+'-template.csv')
    if p.startswith(('/files/','/quote-files/')):
        parts=p.strip('/').split('/')
        if len(parts)!=3 or not re_identifier(parts[1]) or Path(parts[2]).name!=parts[2]:raise KeyError('找不到檔案')
        if parts[0]=='files':
            doc=store.document(parts[1]);allowed={'original'+doc['extension']}|{page['preview'] if 'preview' in page else 'page-'+str(page['number'])+'.jpg' for page in doc['pages']}
            if parts[2] not in allowed:raise KeyError('找不到檔案')
        else:
            quote=a.quote(parts[1])
            if not any(f['file']==parts[2] for f in quote['attachments']):raise KeyError('找不到附件')
        file=store.directory/p.lstrip('/');return binary(file.read_bytes(),mimetypes.guess_type(file.name)[0] or 'application/octet-stream',file.name)
    if p=='/internal/ocr-start':
        identifier=body['id'];doc=store.document(identifier);guard_material(doc)
        if doc['status'] not in ['queued','extracting']:raise OrganizationConflict('此單據已不在辨識佇列')
        with store.connect() as db:db.execute("UPDATE documents SET status='extracting',error='' WHERE id=?",(identifier,))
        return dict(ok=True)
    if p=='/internal/ocr-result':
        identifier=body['id'];doc=store.document(identifier);guard_material(doc)
        if doc['status'] not in ['queued','extracting']:raise OrganizationConflict('單據狀態已變更')
        if body.get('error'):
            with store.connect() as db:db.execute("UPDATE documents SET status='error',error=? WHERE id=?",(body['error'][:1200],identifier))
        else:
            ocr=body['ocr'];draft=draft_context(parse_ocr(ocr));organization=doc['organization'];organization['suggestion']=suggestion(ocr,draft)
            prior=(doc.get('draft') or {}).get('tax_settings',doc.get('tax_settings',{}))
            if prior.get('source') in ['manual_review','manual_batch']:draft['tax_settings']=prior
            with store.connect() as db:db.execute("UPDATE documents SET status='pending',ocr=?,draft=?,organization=?,error='',content_version=content_version+1 WHERE id=?",(json.dumps(ocr,ensure_ascii=False),json.dumps(draft,ensure_ascii=False),json.dumps(organization,ensure_ascii=False),identifier))
        return dict(ok=True)
    if p=='/internal/preview':
        if not re_identifier(body['id']) or not 1<=int(body['page'])<=20:raise ValueError('頁次錯誤')
        file=store.directory/'files'/body['id']/('page-'+str(int(body['page']))+'.jpg');file.write_bytes(bytes(content));return dict(ok=True)
    if p=='/internal/market':
        source=body['source']
        if source=='steel':
            merged={}
            for batch in body.get('batches',[body]):
                for row in parse_steel(batch['pages'],batch['url']):merged[(row['series'],row['period'])]=row
            rows=list(merged.values())
            if body.get('full'):rows=[dict(row,history_complete=True) for row in rows]
            kind='market'
        elif source=='aluminium':rows=parse_worldbank(bytes(content),body['url']);kind='market'
        elif source in ['fx_daily','fx_monthly']:rows=parse_cbc(bytes(content),'daily' if source=='fx_daily' else 'monthly');kind='fx'
        else:raise ValueError('未知行情來源')
        a.write_market(kind,rows);return dict(count=len(rows),latest=max(r['period'] for r in rows))
    if p=='/internal/market-state':return dict(market=a.values('analysis_market'),fx=a.values('analysis_fx'))
    if p=='/internal/restore':return restore_backup(content)
    raise KeyError('找不到操作')

def dispatch(method,path,body_json='{}',headers_json='{}',content=None):
    try:
        result=perform(method,path,json.loads(body_json or '{}'),json.loads(headers_json or '{}'),content)
        return result if isinstance(result,dict) and 'bytes' in result else dict(status=200,data=result)
    except OrganizationConflict as e:return dict(status=409,data=dict(error=str(e)))
    except (ValueError,TypeError,zipfile.BadZipFile,sqlite3.DatabaseError) as e:return dict(status=400,data=dict(error=str(e)))
    except (KeyError,FileNotFoundError) as e:return dict(status=404,data=dict(error=str(e)))

def pending_jobs():
    with store.connect() as db:return [r[0] for r in db.execute("SELECT id FROM documents WHERE status IN ('queued','extracting') AND bucket='materials'")]
