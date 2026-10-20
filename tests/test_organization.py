from contextlib import closing
"""Organization uses disposable data; no real document is moved by these tests."""
import copy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import zipfile

from server import Store, Handler, csv_bytes
from domain import search_materials, parse_ocr
from document_organization import migrate, suggestion, OrganizationConflict
import test_analysis as fixtures


class OrganizationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(self.tmp.name)
        self.id=self.create('first.jpg',confirm=True)
        self.before=copy.deepcopy(self.store.records())
        self.export=csv_bytes(self.before,self.store.suppliers())

    def tearDown(self):
        self.store.executor.shutdown();self.tmp.cleanup()

    def create(self,name,confirm=False):
        identifier=self.store.import_bytes(name,name.encode(),submit=False)['id']
        with self.store.connect() as db:db.execute("UPDATE documents SET status='pending' WHERE id=?",(identifier,))
        draft=fixtures.draft();draft['items'][0]['grade']='S50C';draft['items'][0]['label']='S50C'
        if confirm:self.store.confirm(identifier,draft)
        else:self.store.save_draft(identifier,draft)
        return identifier

    def move(self,action,identifier=None,**extra):
        identifier=identifier or self.id;doc=self.store.document(identifier)
        return self.store.organize(identifier,dict(action=action,expected_version=doc['organization_version'],**extra))

    def park(self,**extra):
        return self.move('park',acknowledge_records=True,expected_record_count=1,**extra)

    def test_confirmed_move_requires_explicit_impact_and_retains_every_original(self):
        with self.assertRaises(OrganizationConflict):self.move('park')
        with self.assertRaises(OrganizationConflict):self.move('park',acknowledge_records=True,expected_record_count=2)
        draft=self.store.document(self.id)['draft'];self.park(category='consumables',note='測試備註')
        self.assertEqual(self.store.records(),[])
        self.assertEqual(self.store.records(True),self.before)
        doc=self.store.document(self.id);self.assertEqual(doc['draft'],draft);self.assertEqual(doc['status'],'done')
        self.assertEqual(doc['organization']['note'],'測試備註')
        self.assertEqual((Path(self.tmp.name)/'files'/self.id/'original.jpg').read_bytes(),b'first.jpg')

    def test_active_filter_covers_table_catalog_search_analysis_export_and_counts(self):
        before=self.store.analysis.query({'price_basis':'original'})
        self.assertEqual(len(before['observations']),1)
        self.park();state=self.store.state()
        self.assertEqual(state['records'],[]);self.assertEqual(state['materials']['grades'],[])
        self.assertEqual(search_materials(self.store.records(),'')['total'],0)
        self.assertEqual(self.store.analysis.query({'price_basis':'original'})['observations'],[])
        self.assertEqual(csv_bytes(self.store.records(),self.store.suppliers()).count(b'\n'),1)
        self.assertEqual(state['organization_counts'],{'materials':0,'review':1,'trash':0})
        doc=state['documents'][0];self.assertEqual(doc['analysis_summary']['status'],'not_applicable')
        self.assertEqual(doc['record_count'],1);self.assertEqual(doc['retained_records'],self.before)

    def test_return_is_pending_and_old_records_only_reappear_after_whole_confirmation(self):
        draft=self.store.document(self.id)['draft'];draft['review_progress']={'completed':True,'items':['yes']}
        self.store.save_draft(self.id,draft);self.park()
        doc=self.move('material');self.assertEqual(doc['status'],'pending');self.assertEqual(doc['ledger_active'],0)
        self.assertNotIn('review_progress',doc['draft']);self.assertEqual(self.store.records(),[])
        self.store.save_draft(self.id,doc['draft'],doc['organization_version']);self.assertEqual(self.store.records(),[])
        self.store.confirm(self.id,doc['draft'],doc['organization_version'])
        self.assertEqual(csv_bytes(self.store.records(),self.store.suppliers()),self.export)

    def test_trash_restore_origin_category_and_idempotent_moves(self):
        self.park(category='tools',note='保留')
        first=self.move('trash');again=self.move('trash')
        self.assertEqual(again['organization_version'],first['organization_version'])
        self.assertEqual(again['organization']['restore'],{'bucket':'review','category':'tools'})
        restored=self.move('restore');self.assertEqual(restored['bucket'],'review');self.assertEqual(restored['category'],'tools')
        self.assertEqual(restored['organization']['note'],'保留');self.assertNotIn('restore',restored['organization'])
        self.move('material');self.store.confirm(self.id,self.store.document(self.id)['draft'])
        self.move('trash',acknowledge_records=True,expected_record_count=1)
        restored=self.move('restore');self.assertEqual(restored['bucket'],'materials');self.assertEqual(restored['status'],'pending')
        self.assertEqual(self.store.records(),[])

    def test_pool_metadata_saves_without_material_validation_and_preserves_manual_category(self):
        id=self.create('invalid.jpg');draft=self.store.document(id)['draft'];draft['items'][0].update(dims=['','',''],qty='',label='')
        self.store.save_draft(id,draft);self.move('park',id,category='consumables')
        self.move('metadata',id,category='other',note='不必填尺寸')
        migrate(self.store);doc=self.store.document(id)
        self.assertEqual(doc['category'],'other');self.assertTrue(doc['organization']['manual'])
        self.assertEqual(doc['draft']['items'][0]['qty'],'')
        with self.assertRaises(ValueError):self.move('metadata',id,category='unknown')

    def test_queue_running_cannot_move_and_stale_save_confirm_retry_never_restore(self):
        pending=self.store.import_bytes('queued.jpg',b'queued',submit=False)['id']
        for status in ['queued','extracting']:
            with self.store.connect() as db:db.execute('UPDATE documents SET status=? WHERE id=?',(status,pending))
            with self.assertRaises(OrganizationConflict):self.move('park',pending)
        draft=self.store.document(self.id)['draft'];self.park()
        for operation in [lambda:self.store.save_draft(self.id,draft,0),lambda:self.store.confirm(self.id,draft,0),lambda:self.store.retry(self.id,True,0)]:
            with self.assertRaises(OrganizationConflict):operation()
        self.move('material')
        for operation in [lambda:self.store.save_draft(self.id,draft,0),lambda:self.store.confirm(self.id,draft,0),lambda:self.store.retry(self.id,True,0)]:
            with self.assertRaises(OrganizationConflict):operation()
        self.assertEqual(self.store.records(),[])

    def test_duplicate_upload_reports_pool_or_trash_without_creating_or_restoring(self):
        for action in ['park','trash']:
            if action=='park':self.park()
            else:self.move(action)
            result=self.store.import_bytes('renamed.jpg',b'first.jpg',submit=False)
            self.assertTrue(result['duplicate']);self.assertEqual(result['bucket'],'review' if action=='park' else 'trash')
            self.assertEqual(len(self.store.state()['documents']),1)

    def test_duplicate_canonical_is_recomputed_using_only_active_material_sources(self):
        second=self.create('second.jpg',confirm=True)
        obs=self.store.analysis.query({'price_basis':'original'})['observations']
        self.assertEqual(sum(bool(r.get('duplicate_of')) for r in obs),1)
        canonical=next(r['document_id'] for r in obs if not r.get('duplicate_of'))
        self.move('park',canonical,acknowledge_records=True,expected_record_count=1)
        obs=self.store.analysis.query({'price_basis':'original'})['observations']
        self.assertEqual(len(obs),1);self.assertFalse(obs[0].get('duplicate_of'));self.assertTrue(obs[0]['eligible'])

    def test_migration_is_repeatable_backfills_saved_ocr_and_never_modifies_old_fields(self):
        with self.store.connect() as db:
            ocr={'pages':[{'number':1,'preview':'page-1.jpg','lines':[{'text':'品名規格','y':.2},{'text':'W.D AL710 鋁清洗劑 5G','y':.3}]}]}
            db.execute("UPDATE documents SET organization='{}',ocr=? WHERE id=?",(json.dumps(ocr),self.id))
            before=[tuple(r) for r in db.execute('SELECT id,sha,name,extension,status,created,draft,ocr,error,bucket,category,ledger_active FROM documents')]
        migrate(self.store);migrate(self.store)
        doc=self.store.document(self.id);self.assertEqual(doc['organization']['suggestion']['category'],'consumables')
        with self.store.connect() as db:self.assertEqual([tuple(r) for r in db.execute('SELECT id,sha,name,extension,status,created,draft,ocr,error,bucket,category,ledger_active FROM documents')],before)
        self.assertEqual(self.store.records(),self.before)

    def test_backup_contains_all_locations_originals_and_inactive_records(self):
        self.park();self.move('trash')
        with zipfile.ZipFile(io.BytesIO(self.store.backup())) as archive:
            self.assertIn('data/files/'+self.id+'/original.jpg',archive.namelist())
            path=Path(self.tmp.name)/'snapshot.sqlite3';path.write_bytes(archive.read('data/ledger.sqlite3'))
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM records').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT bucket,ledger_active FROM documents').fetchone(),('trash',0))


class SuggestionTests(unittest.TestCase):
    def test_cleaner_and_tools_use_product_evidence_never_single_metal_word(self):
        s=suggestion({},dict(items=[{'label':'W.D AL710 鋁清洗劑 5G'}]))
        self.assertEqual(s['category'],'consumables');self.assertFalse(s['mixed']);self.assertEqual(s['evidence'][0]['term'],'清洗劑')
        self.assertEqual(suggestion({},dict(items=[{'label':'鎢鋼銑刀'}]))['category'],'tools')

    def test_missing_grade_unknown_vendor_error_and_round_do_not_suggest_other(self):
        for draft in [dict(meta={'sup':'new'},items=[]),dict(items=[{'label':'圓條185*22L','grade':''}]),dict(items=[],warnings=['辨識失敗'])]:
            self.assertEqual(suggestion({},draft)['evidence'],[])
        for fixture in ['hh','sk','zf','zm']:
            ocr=json.loads((Path(__file__).parent/'fixtures'/f'{fixture}.json').read_text())
            self.assertEqual(suggestion(ocr,parse_ocr(ocr))['evidence'],[])

    def test_mixed_items_warn_and_header_company_does_not_classify(self):
        s=suggestion({},dict(items=[{'label':'S50C'},{'label':'清洗劑'}]));self.assertTrue(s['mixed'])
        ocr={'pages':[{'lines':[{'text':'清洗劑有限公司','y':.05},{'text':'品名規格','y':.2},{'text':'圓條185*22L','y':.3}]}]}
        self.assertEqual(suggestion(ocr,dict(items=[]))['evidence'],[])




if __name__=='__main__':unittest.main()
