#!/usr/bin/env python3
"""Single-Mac, offline material ledger. Python standard library + Apple Vision."""
import argparse
import csv
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from domain import SUPPLIERS, parse_ocr, search_materials, validate_draft, default_units, material_catalog
from billing import billing_unit, billing_quantity
from analysis_store import AnalysisStore
import tax_store
from taxation import settings as tax_settings, draft_context, context as tax_context
from analysis import QUOTE_COLUMNS, csv_output
from market_data import MARKET_COLUMNS, FX_COLUMNS
from document_organization import migrate, organize, guard_material, is_material, suggestion, OrganizationConflict

ROOT = Path(__file__).resolve().parent
MAX_FILE = 50 * 1024 * 1024
EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".pdf"}

class SerialLock:
    """The browser worker runs one request at a time; no Python threads exist."""
    def __init__(self): self.busy = False
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def acquire(self, blocking=True):
        if self.busy: return False
        self.busy = True
        return True
    def release(self): self.busy = False

class BrowserJobs:
    def __init__(self, **kwargs): self.jobs = []
    def submit(self, fn, identifier): self.jobs.append(identifier)
    def shutdown(self, **kwargs): pass

class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try: return super().__exit__(*args)
        finally: self.close()


class Store:
    def __init__(self, directory, ocr=None):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / "files").mkdir(exist_ok=True)
        self.db_path = self.directory / "ledger.sqlite3"
        self.ocr = Path(ocr or ROOT / ".build/recognize")
        self.executor = BrowserJobs() if sys.platform == 'emscripten' else ThreadPoolExecutor(max_workers=1, thread_name_prefix="local-ocr")
        self.lock = SerialLock() if sys.platform == 'emscripten' else threading.RLock()
        with self.connect() as db:
            db.executescript("""
            PRAGMA journal_mode=DELETE;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS documents(
              id TEXT PRIMARY KEY, sha TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
              extension TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL,
              draft TEXT, ocr TEXT, error TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS records(
              id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
              position INTEGER NOT NULL, data TEXT NOT NULL,
              UNIQUE(document_id,position));
            PRAGMA user_version=1;
            """)
            for key, supplier in SUPPLIERS.items():
                db.execute("INSERT OR IGNORE INTO settings VALUES(?,?)", ("supplier:"+key, json.dumps(supplier, ensure_ascii=False)))
        self.upgrade_units()
        migrate(self)
        tax_store.migrate(self)
        self.analysis = AnalysisStore(self)

    def upgrade_units(self):
        with self.lock, self.connect() as db:
            if db.execute("SELECT 1 FROM settings WHERE key='upgrade:units-v2'").fetchone():
                return
            pending = db.execute("SELECT id,draft FROM documents WHERE status='pending' AND draft IS NOT NULL").fetchall()
            if pending:
                backup = self.directory/'upgrade-backups'/'before-units-v2.sqlite3'
                backup.parent.mkdir(exist_ok=True)
                if not backup.exists():
                    with sqlite3.connect(backup, factory=ClosingConnection) as target:
                        db.backup(target)
            for row in pending:
                draft = default_units(json.loads(row['draft']))
                draft['warnings'] = [w for w in draft.get('warnings', []) if '不會自行推定' not in w and '未讀到尺寸單位' not in w]
                note = '請逐筆核對原圖；未註明尺寸單位預設 mm、計價單位預設件；材質與金額未列則留白。'
                if note not in draft['warnings']:
                    draft['warnings'].append(note)
                db.execute("UPDATE documents SET draft=? WHERE id=?", (json.dumps(draft, ensure_ascii=False), row['id']))
            db.execute("INSERT INTO settings VALUES('upgrade:units-v2','true')")

    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=15, factory=ClosingConnection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def suppliers(self):
        with self.connect() as db:
            return {r["key"].split(":", 1)[1]: json.loads(r["value"]) for r in db.execute("SELECT * FROM settings WHERE key LIKE 'supplier:%'")}

    def add_supplier(self, name):
        name = str(name).strip()
        if not 2 <= len(name) <= 100:
            raise ValueError("供應商名稱需為 2–100 字")
        with self.lock, self.connect() as db:
            for key, supplier in self.suppliers().items():
                if supplier["name"] == name:
                    return key
            key = "s"+uuid.uuid4().hex[:10]
            db.execute("INSERT INTO settings VALUES(?,?)", ("supplier:"+key, json.dumps({"name": name, "short": name}, ensure_ascii=False)))
            return key

    def records(self, include_inactive=False):
        with self.connect() as db:
            condition = '' if include_inactive else " WHERE d.bucket='materials' AND d.ledger_active=1"
            sql = 'SELECT r.* FROM records r JOIN documents d ON d.id=r.document_id'+condition+' ORDER BY r.rowid DESC'
            return [dict(json.loads(r["data"]), id=r["id"], document_id=r["document_id"], position=r["position"]) for r in db.execute(sql)]

    def document(self, identifier):
        with self.connect() as db:
            row = db.execute("SELECT * FROM documents WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise KeyError("找不到單據")
        return self.public_document(row)

    def public_document(self, row):
        result = dict(row)
        result["draft"] = json.loads(result["draft"]) if result["draft"] else None
        result['organization'] = json.loads(result['organization'])
        result['tax_settings'] = json.loads(result.pop('tax_context'))
        if result['draft']:
            if result['status']=='done' and result['tax_settings']: result['draft']['tax_settings'] = tax_settings(result['tax_settings'])
            else: result['draft'].setdefault('tax_settings', tax_settings(result['tax_settings']))
        ocr = json.loads(result.pop("ocr")) if row["ocr"] else {}
        result['ocr_text'] = '\n\n'.join('\n'.join(str(line.get('text', '')) for line in page.get('lines', [])) for page in ocr.get('pages', []))
        result["pages"] = [{"number": p["number"], "url": f'/files/{row["id"]}/{p["preview"]}'} for p in ocr.get("pages", [])]
        result["engine"] = ocr.get("engine", "瀏覽器 OCR")
        result["original_url"] = f'/files/{row["id"]}/original{row["extension"]}'
        result.pop("sha")
        return result

    def organize(self, identifier, data):
        return organize(self, identifier, data)

    def state(self, include_analysis=True):
        with self.lock:
            return self._state(include_analysis)

    def _state(self, include_analysis):
        with self.connect() as db:
            docs = [self.public_document(r) for r in db.execute("SELECT * FROM documents ORDER BY created DESC")]
            counts = dict(db.execute('SELECT document_id,COUNT(*) FROM records GROUP BY document_id').fetchall())
        inactive = self.records(include_inactive=True)
        for doc in docs:
            doc['record_count'] = counts.get(doc['id'], 0)
            if not is_material(doc):
                doc['retained_records'] = [r for r in inactive if r['document_id'] == doc['id']]
        records = self.records()
        if include_analysis:
            material_docs = [d for d in docs if is_material(d)]
            summaries = self.analysis.document_summaries(records, material_docs)
            for doc in docs: doc['analysis_summary'] = dict(summaries.get(doc['id'], {'status': 'not_applicable', 'lines': [], 'total': 0, 'usable': 0, 'price_basis': 'gross'}), content_version=doc['content_version'])
            row_summaries = self.analysis.record_summaries(records, docs)
            records = [dict(row, analysis_summary=row_summaries[row['id']]) for row in records]
        return {"suppliers": self.suppliers(), "records": records, "documents": docs,
                "materials": material_catalog(records), "storage": str(self.directory),
                "organization_counts": {bucket: sum(d['bucket'] == bucket for d in docs) for bucket in ['materials', 'review', 'trash']}}

    def import_bytes(self, name, content, submit=True):
        name = Path(name.replace("\\", "/")).name[:200]
        ext = Path(name).suffix.lower()
        if ext not in EXTENSIONS:
            raise ValueError("支援 JPG、PNG、HEIC、WebP、TIFF 或 PDF")
        if not content or len(content) > MAX_FILE:
            raise ValueError("檔案不可為空，且每份最多 50 MB")
        digest = hashlib.sha256(content).hexdigest()
        with self.lock, self.connect() as db:
            previous = db.execute("SELECT id,bucket FROM documents WHERE sha=?", (digest,)).fetchone()
            if previous:
                return {"id": previous["id"], "duplicate": True, 'bucket': previous['bucket']}
            identifier = uuid.uuid4().hex
            folder = self.directory / "files" / identifier
            folder.mkdir()
            try:
                (folder / ("original"+ext)).write_bytes(content)
                db.execute("INSERT INTO documents(id,sha,name,extension,status,created) VALUES(?,?,?,?,?,?)",
                           (identifier, digest, name, ext, "queued", datetime.now().astimezone().isoformat()))
            except Exception:
                shutil.rmtree(folder)
                raise
        if submit:
            self.executor.submit(self.process, identifier)
        return {"id": identifier, "duplicate": False}

    def process(self, identifier):
        try:
            doc = self.document(identifier)
            if doc["status"] == "done" or not is_material(doc):
                return
            with self.lock, self.connect() as db:
                guard_material(db.execute('SELECT * FROM documents WHERE id=?', (identifier,)).fetchone())
                db.execute("UPDATE documents SET status='extracting',error='' WHERE id=?", (identifier,))
            folder = self.directory / "files" / identifier
            if not self.ocr.is_file():
                raise RuntimeError("找不到本機辨識程式，請重新執行「啟動材料進料帳.command」完成編譯")
            run = subprocess.run([str(self.ocr), str(folder/("original"+doc["extension"])), str(folder)], capture_output=True, timeout=300)
            if run.returncode:
                raise RuntimeError(run.stderr.decode("utf-8", errors="replace")[-1200:] or "圖片無法辨識，請換用清晰圖片")
            ocr = json.loads(run.stdout)
            draft = draft_context(parse_ocr(ocr))
            with self.lock, self.connect() as db:
                current = db.execute('SELECT * FROM documents WHERE id=?', (identifier,)).fetchone()
                guard_material(current)
                organization = json.loads(current['organization'])
                organization['suggestion'] = suggestion(ocr, draft)
                saved_tax = json.loads(current['tax_context'])
                prior_tax = json.loads(current['draft'] or '{}').get('tax_settings', {})
                if prior_tax.get('source') in ['manual_review', 'manual_batch']: saved_tax = prior_tax
                if saved_tax: draft['tax_settings'] = saved_tax
                db.execute("UPDATE documents SET status='pending',ocr=?,draft=?,organization=?,error='',content_version=content_version+1 WHERE id=?",
                           (json.dumps(ocr, ensure_ascii=False), json.dumps(draft, ensure_ascii=False), json.dumps(organization, ensure_ascii=False), identifier))
        except Exception as error:
            with self.lock, self.connect() as db:
                db.execute("UPDATE documents SET status='error',error=? WHERE id=? AND bucket='materials'", (str(error), identifier))

    def resume(self):
        with self.connect() as db:
            ids = [r[0] for r in db.execute("SELECT id FROM documents WHERE bucket='materials' AND status IN ('queued','extracting')")]
        for identifier in ids:
            self.executor.submit(self.process, identifier)

    def save_draft(self, identifier, draft, version=None, content_version=None):
        with self.lock:
            return self._save_draft(identifier, draft, version, content_version)

    def _save_draft(self, identifier, draft, version=None, content_version=None):
        if not isinstance(draft, dict) or not isinstance(draft.get("meta"), dict) or not isinstance(draft.get("items"), list):
            raise ValueError("單據格式錯誤")
        draft = default_units(draft)
        with self.lock, self.connect() as db:
            doc = db.execute("SELECT * FROM documents WHERE id=?", (identifier,)).fetchone()
            guard_material(doc, version)
            tax_store.guard(doc, content_version)
            if doc['status'] not in ["pending", "done", "error"]:
                raise ValueError("辨識尚未完成")
            if 'tax_settings' in draft: draft['tax_settings'] = tax_settings(draft['tax_settings'])
            # Keep confirmed records until the whole edited document is explicitly confirmed again.
            db.execute("UPDATE documents SET draft=?,status='pending',content_version=content_version+1 WHERE id=?", (json.dumps(draft, ensure_ascii=False), identifier))
        # The caller serializes saves; this summary is calculated from the committed snapshot.
        with self.lock:
            state = self.state()
            doc = next(d for d in state['documents'] if d['id'] == identifier)
            return dict(doc['analysis_summary'], content_version=doc['content_version'])

    def confirm(self, identifier, draft, version=None, content_version=None):
        draft = default_units(draft)
        rows = validate_draft(draft, self.suppliers())
        if isinstance(draft.get('review_progress'), dict):
            draft['review_progress']['completed'] = True
        with self.lock, self.connect() as db:
            doc = db.execute("SELECT * FROM documents WHERE id=?", (identifier,)).fetchone()
            guard_material(doc, version)
            tax_store.guard(doc, content_version)
            if doc['status'] not in ["pending", "done", "error"]:
                raise ValueError("辨識尚未完成")
            cfg = tax_settings(draft.get('tax_settings') or json.loads(doc['tax_context']))
            cfg['source'] = 'manual_review'
            draft['tax_settings'] = cfg
            db.execute("DELETE FROM records WHERE document_id=?", (identifier,))
            for pos, row in enumerate(rows):
                db.execute("INSERT INTO records VALUES(?,?,?,?)", (f"{identifier}-{pos}", identifier, pos, json.dumps(row, ensure_ascii=False)))
            db.execute("UPDATE documents SET draft=?,tax_context=?,status='done',ledger_active=1,error='',content_version=content_version+1 WHERE id=?", (json.dumps(draft, ensure_ascii=False), json.dumps(cfg,ensure_ascii=False), identifier))
        return len(rows)

    def retry(self, identifier, replace=False, version=None, content_version=None):
        with self.lock, self.connect() as db:
            doc = db.execute('SELECT * FROM documents WHERE id=?', (identifier,)).fetchone()
            guard_material(doc, version)
            tax_store.guard(doc, content_version)
            if doc['status'] not in ['error', 'pending']:
                raise ValueError('僅待確認或失敗的單據可重新辨識')
            if doc['status'] == 'pending' and replace is not True:
                raise ValueError('重新辨識會取代目前草稿，請先確認')
            db.execute("UPDATE documents SET status='queued',error='',content_version=content_version+1 WHERE id=?", (identifier,))
        self.executor.submit(self.process, identifier)

    def backup(self):
        # Consistent SQLite snapshot, including in-flight WAL transactions; no OCR writes during file enumeration.
        with self.lock, tempfile.TemporaryDirectory() as folder:
            snapshot = Path(folder)/"ledger.sqlite3"
            with self.connect() as db, sqlite3.connect(snapshot, factory=ClosingConnection) as target:
                db.backup(target)
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.write(snapshot, "data/ledger.sqlite3")
                for directory in ['files', 'quote-files']:
                    for source in sorted((self.directory/directory).rglob("*")):
                        if source.is_file():
                            archive.write(source, "data/"+source.relative_to(self.directory).as_posix())
                archive.writestr("還原說明.txt", "在材料進料帳 Demo 左下角按「還原」，選擇此 ZIP。還原只會取代目前瀏覽器的 Demo 資料。請先保存現有備份。\n")
            return output.getvalue()


def tax_export_values(row):
    s = row.get('analysis_summary', {})
    return [s.get('transaction_type'), s.get('tax_basis'), s.get('tax_rate'), s.get('allocated_tax'), s.get('gross_amount'), s.get('gross_unit_kg')]


def csv_bytes(rows, suppliers):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["供應商", "日期", "單號", "料號", "材料種類", "牌號", "尺寸1(mm)", "尺寸2(mm)", "尺寸3(mm)", "數量", "計價單位", "單價(TWD)", "明細金額(TWD)", "整單小計", "整單稅額", "整單總計", "備註", "形狀", "直徑(mm)", "長度(mm)", "數量單位", "重量(kg)", "計價依據", "計價數量", "材料費(TWD)", "加工費(TWD)", "交易性質", "單價稅別", "稅率(%)", "分攤稅額(TWD)", "含稅成交金額(TWD)", "含稅成交公斤價(TWD/kg)"])
    def safe(value):
        return "'"+value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value
    for r in rows:
        is_round = r.get('shape') == 'round'
        dims = ['', '', ''] if is_round else r['dims']
        writer.writerow([safe(v) for v in [suppliers[r["sup"]]["name"], r["date"], r["doc"], r["part_no"], r["label"], r["grade"], *dims, r["qty"], billing_unit(r), r["price"], r["amount"], r["subtotal"], r["tax"], r["document_total"], r["note"], '圓條' if is_round else '長方體', r['dims'][0] if is_round else '', r['dims'][1] if is_round else '', r['unit'], r.get('weight_kg'), '按重量' if r.get('pricing_basis')=='weight' else '按數量', billing_quantity(r), r.get('material_amount'), r.get('processing_fee'), *tax_export_values(r)]])
    return ("\ufeff"+output.getvalue()).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "MaterialDemoLocal/1.0"

    def log_message(self, format, *args):
        if not args or "GET /api/state " not in str(args[0]):
            super().log_message(format, *args)

    @property
    def store(self):
        return self.server.store

    def respond(self, body, code=200, mime="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; script-src 'self'; object-src 'self'; frame-src 'self'; connect-src 'self'; frame-ancestors 'none'")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def check_local(self):
        host = self.headers.get("Host", "").split(":")[0]
        if host not in ["127.0.0.1", "localhost"]:
            raise PermissionError("僅允許本機連線")
        origin = self.headers.get("Origin")
        if origin and origin not in [f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"]:
            raise PermissionError("不允許跨網站存取")

    def read_body(self, max_size=MAX_FILE):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > max_size:
            raise ValueError("檔案或資料大小超過限制")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError("檔案傳輸未完成")
        return body

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        try:
            self.check_local()
            parsed = urlsplit(self.path)
            path, query = unquote(parsed.path), parse_qs(parsed.query)
            if method == "POST" and self.headers.get("X-MaterialDemo-Local") != "1":
                raise PermissionError("請從本機進料帳頁面操作")
            if path in ['/api/analysis', '/api/quotes', '/api/market'] or path.startswith(('/api/analysis/', '/api/quotes/', '/api/market/', '/quote-files/')):
                return self.analysis_dispatch(method, path, query)
            if method == "GET" and path == "/api/state":
                return self.respond(self.store.state())
            if method == "GET" and path == "/api/search":
                raw, mode = query.get('q', [''])[0], query.get('mode', ['text'])[0]
                fields = ['shape', 'dims', 'grade', 'metal', 'missing_grade']
                if mode not in ['text', 'structured'] or (mode == 'structured' and raw) or (mode == 'text' and any(k in query for k in fields)):
                    raise ValueError('文字查詢與尺寸欄位查詢請分開使用')
                filters = {k: query[k][0] for k in fields if k in query} if mode == 'structured' else None
                return self.respond(search_materials(self.store.records(), raw, query.get('allow', [0])[0], filters=filters))
            if method == "GET" and path == "/api/health":
                return self.respond({"ok": True, "app": "material-demo-local", "ocr_ready": self.store.ocr.is_file(), "version": 10})
            if method == "GET" and path == "/api/backup":
                return self.respond(self.store.backup(), mime="application/zip", headers={"Content-Disposition": 'attachment; filename="material-demo-backup.zip"'})
            if method == "GET" and path == "/api/export.csv":
                return self.respond(csv_bytes(self.store.state()["records"], self.store.suppliers()), mime="text/csv; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="material-demo-materials.csv"'})
            if method == "POST" and path == "/api/upload":
                return self.respond(self.store.import_bytes(query.get("name", ["upload.jpg"])[0], self.read_body()), 202)
            if method == "POST" and path == "/api/suppliers":
                data = json.loads(self.read_body(10000))
                return self.respond({"id": self.store.add_supplier(data.get("name", "")), "suppliers": self.store.suppliers()})
            if method == 'GET' and path == '/api/documents/tax-preview':
                return self.respond(tax_store.preview(self.store))
            if method == 'POST' and path == '/api/documents/tax-apply':
                return self.respond(tax_store.apply(self.store, json.loads(self.read_body(2*1024*1024))))
            if method == 'GET' and path.startswith('/api/documents/') and path.endswith('/recognition-preview'):
                return self.respond(tax_store.correction_preview(self.store, path.split('/')[3]))
            if method == "POST" and path.startswith("/api/documents/"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    raise KeyError("找不到操作")
                identifier, action = parts[2:]
                data = json.loads(self.read_body(2*1024*1024))
                version = int(self.headers.get('X-MaterialDemo-Document-Version', '0'))
                content_version = int(self.headers.get('X-MaterialDemo-Content-Version', '0'))
                if action == 'organize':
                    return self.respond({'ok': True, 'document': self.store.organize(identifier, data)})
                if action == "draft":
                    summary = self.store.save_draft(identifier, data, version, content_version)
                    return self.respond({"ok": True, "analysis_summary": summary, "content_version": summary["content_version"]})
                if action == "confirm":
                    with self.store.lock:
                        count = self.store.confirm(identifier, data, version, content_version)
                        current_version = self.store.document(identifier)["content_version"]
                    return self.respond({"ok": True, "count": count, "content_version": current_version})
                if action == "retry":
                    self.store.retry(identifier, data.get('replace', False), version, content_version)
                    return self.respond({"ok": True})
            if method == "GET" and path.startswith("/files/"):
                parts = path.split("/")
                if len(parts) != 4 or not re_identifier(parts[2]):
                    raise KeyError("找不到檔案")
                doc = self.store.document(parts[2])
                permitted = {"original"+doc["extension"]} | {f'page-{p["number"]}.jpg' for p in doc["pages"]}
                if parts[3] not in permitted:
                    raise KeyError("找不到檔案")
                file = self.store.directory/"files"/parts[2]/parts[3]
                return self.respond(file.read_bytes(), mime=mimetypes.guess_type(file.name)[0] or "application/octet-stream")
            if method == "GET" and not path.startswith("/api/"):
                file = (ROOT/"static"/(path.lstrip("/") or "index.html")).resolve()
                if not file.is_relative_to(ROOT/"static") or not file.is_file():
                    raise KeyError("找不到頁面")
                return self.respond(file.read_bytes(), mime=mimetypes.guess_type(file.name)[0] or "application/octet-stream")
            raise KeyError("找不到操作")
        except PermissionError as error:
            self.respond({"error": str(error)}, 403)
        except (KeyError, FileNotFoundError) as error:
            self.respond({"error": str(error)}, 404)
        except OrganizationConflict as error:
            self.respond({'error': str(error)}, 409)
        except (ValueError, TypeError) as error:
            self.respond({"error": str(error)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print(f"伺服器錯誤：{error}", file=sys.stderr)
            self.respond({"error": "本機資料處理失敗，請查看啟動視窗的訊息"}, 500)

    def analysis_dispatch(self, method, path, query):
        analysis = self.store.analysis
        if method == 'GET' and path == '/api/analysis':
            filters = json.loads(query.get('filter', ['{}'])[0])
            if not isinstance(filters, dict): raise ValueError('分析條件格式錯誤')
            if 'price_basis' in query: filters['price_basis'] = query['price_basis'][0]
            return self.respond(analysis.query(filters))
        if method == 'GET' and path == '/api/quotes':
            return self.respond({'quotes': analysis.values('analysis_quotes')})
        if method == 'GET' and path == '/api/analysis/template':
            kind = query.get('kind', ['quotes'])[0]
            columns = {'quotes': QUOTE_COLUMNS, 'market': MARKET_COLUMNS, 'fx': FX_COLUMNS}.get(kind)
            if not columns: raise ValueError('範本類型錯誤')
            return self.respond(csv_output(columns, []), mime='text/csv; charset=utf-8', headers={'Content-Disposition': 'attachment; filename="material-demo-'+kind+'-template.csv"'})
        if method == 'GET' and path == '/api/analysis/export.csv':
            kind = query.get('kind', ['analysis'])[0]
            if kind not in ['analysis', 'quotes']: raise ValueError('匯出類型錯誤')
            filters = json.loads(query.get('filter', ['{}'])[0])
            if not isinstance(filters, dict): raise ValueError('分析條件格式錯誤')
            return self.respond(analysis.export(kind, filters), mime='text/csv; charset=utf-8', headers={'Content-Disposition': 'attachment; filename="material-demo-'+kind+'.csv"'})
        if method == 'POST' and path == '/api/quotes':
            return self.respond(analysis.add_quote(json.loads(self.read_body(100000))), 201)
        if method == 'POST' and path == '/api/market/update':
            self.read_body(1000)
            return self.respond(analysis.update_market())
        if method == 'POST' and path in ['/api/analysis/preview', '/api/analysis/import']:
            data = json.loads(self.read_body(5*1024*1024))
            if path.endswith('/preview'): return self.respond(analysis.import_preview(data.get('kind'), data.get('content')))
            return self.respond(analysis.import_csv(data.get('kind'), data.get('content'), data.get('replace') is True))
        if method == 'POST' and path == '/api/analysis/settings':
            return self.respond(analysis.save_settings(json.loads(self.read_body(10000))))
        if method == 'POST' and path.startswith('/api/analysis/market-sources/'):
            return self.respond(analysis.classify_market(path.split('/')[-1], json.loads(self.read_body(10000)).get('metal')))
        if method == 'POST' and path.startswith('/api/analysis/notes/'):
            identifier = path.split('/')[-1]
            return self.respond(analysis.save_note(identifier, json.loads(self.read_body(10000))))
        if method == 'POST' and path.startswith('/api/quotes/'):
            parts = path.strip('/').split('/')
            if len(parts) != 4 or not re_identifier(parts[2]): raise KeyError('找不到報價')
            if parts[3] == 'void':
                self.read_body(1000)
                return self.respond(analysis.void_quote(parts[2]))
            if parts[3] == 'attachment':
                return self.respond(analysis.attach_quote(parts[2], query.get('name', ['attachment.pdf'])[0], self.read_body()))
        if method == 'GET' and path.startswith('/quote-files/'):
            parts = path.strip('/').split('/')
            if len(parts) != 3 or not re_identifier(parts[1]): raise KeyError('找不到附件')
            quote = analysis.quote(parts[1])
            file = next((f for f in quote.get('attachments', []) if f['file'] == parts[2]), None)
            if not file: raise KeyError('找不到附件')
            return self.respond((self.store.directory/'quote-files'/parts[1]/file['file']).read_bytes(), mime='application/octet-stream', headers={'Content-Disposition': "attachment; filename*=UTF-8''"+__import__('urllib.parse', fromlist=['quote']).quote(file['name'])})
        raise KeyError('找不到分析操作')


def re_identifier(value):
    return len(value) == 32 and all(c in "0123456789abcdef" for c in value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--data-dir", default=str(ROOT/"data"))
    parser.add_argument("--import-files", nargs="*")
    args = parser.parse_args()
    store = Store(args.data_dir)
    if args.import_files:
        for path in args.import_files:
            file = Path(path)
            imported = store.import_bytes(file.name, file.read_bytes())
            print(f'{file.name}: {imported["id"]}', flush=True)
        store.executor.shutdown(wait=True)
        return
    store.resume()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.store = store
    print(f"材料進料帳：http://127.0.0.1:{args.port}\n資料位置：{store.directory}\n按 Control+C 關閉。", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在安全關閉…", flush=True)
    finally:
        httpd.server_close()
        store.executor.shutdown(wait=True)


if __name__ == "__main__":
    main()
