"""Synthetic end-to-end coverage for the browser bridge, on disposable data only."""
import copy,io,json,sys,tempfile,unittest,zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'public/core'))
import browser_bridge as bridge
from domain import parse_ocr,validate_draft,SUPPLIERS
from billing import estimate_amount
from document_organization import OrganizationConflict
ROOT=Path(__file__).resolve().parents[1]
SEED=json.loads((ROOT/'public/demo-seed.json').read_text())

class DemoTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.temp=tempfile.TemporaryDirectory();bridge.init_store(cls.temp.name)
  for spec in SEED['documents']:
   bridge.seed_one(json.dumps(spec),(ROOT/'public'/spec['original'].lstrip('/')).read_bytes(),[(ROOT/'public'/p['url'].lstrip('/')).read_bytes() for p in spec['pages']])
  bridge.finish_seed(json.dumps(SEED));cls.backup=bridge.store.backup()
 @classmethod
 def tearDownClass(cls):bridge.store.executor.shutdown();cls.temp.cleanup()
 def setUp(self):bridge.restore_backup(self.backup)
 def request(self,path,method='GET',data=None,headers=None,content=None):return bridge.dispatch(method,path,json.dumps(data or {}),json.dumps(headers or {}),content)
 def test_seed_is_complete_and_every_virtual_original_matches_ocr_and_fields(self):
  state=self.request('/api/state')['data'];self.assertEqual(len(state['documents']),31);self.assertEqual(len(state['records']),42);self.assertEqual(state['organization_counts'],{'materials':28,'review':2,'trash':1})
  for spec in SEED['documents']:
   if spec.get('bucket','materials')!='materials':continue
   parsed=parse_ocr(spec['ocr']);self.assertEqual(parsed['meta']['sup'],spec['draft']['meta']['sup']);self.assertEqual(parsed['meta']['date'],spec['draft']['meta']['date']);self.assertEqual(len(parsed['items']),len(spec['draft']['items']))
   for actual,expected in zip(parsed['items'],spec['draft']['items']):
    for key in ['dims','qty','price','amount']:self.assertEqual(actual.get(key),expected.get(key),(spec['name'],key))
 def test_search_and_csv_only_include_active_confirmed_records(self):
  state=self.request('/api/state')['data'];row=state['records'][0];shape=row['shape'];dims=','.join(map(str,row['dims']))
  result=self.request('/api/search?mode=structured&shape='+shape+'&dims='+dims)['data'];self.assertGreater(result['total'],0)
  export=self.request('/api/export.csv');self.assertTrue(export['bytes'].startswith(b'\xef\xbb\xbf'));self.assertEqual(export['bytes'].count(b'\n'),43)
 def test_edit_only_changes_ledger_after_whole_confirmation_and_stale_version_is_rejected(self):
  state=self.request('/api/state')['data'];doc=next(d for d in state['documents'] if d['status']=='done');draft=copy.deepcopy(doc['draft']);draft['items'][0]['note']='虛構修改驗收';before=copy.deepcopy(bridge.store.records())
  headers={'X-MaterialDemo-Document-Version':str(doc['organization_version']),'X-MaterialDemo-Content-Version':str(doc['content_version'])}
  saved=self.request('/api/documents/'+doc['id']+'/draft','POST',draft,headers);self.assertEqual(saved['status'],200);self.assertEqual(bridge.store.records(),before)
  self.assertEqual(self.request('/api/documents/'+doc['id']+'/draft','POST',draft,headers)['status'],409)
  headers['X-MaterialDemo-Content-Version']=str(saved['data']['content_version']);self.assertEqual(self.request('/api/documents/'+doc['id']+'/confirm','POST',draft,headers)['status'],200)
  self.assertIn('虛構修改驗收',[r['note'] for r in bridge.store.records()])
 def test_storage_failure_rollback_restores_database_and_removes_new_original(self):
  snapshot=bridge.snapshot_request('/api/upload');before=self.request('/api/state')['data'];r=self.request('/api/upload?name=disposable.png','POST',content=b'synthetic-disposable-file');self.assertEqual(r['status'],200)
  identifier=r['data']['id'];self.assertTrue((bridge.store.directory/'files'/identifier/'original.png').is_file());bridge.rollback_request(snapshot)
  self.assertEqual(len(bridge.store.state()['documents']),len(before['documents']));self.assertFalse((bridge.store.directory/'files'/identifier/'original.png').exists())
 def test_pool_trash_restore_preserve_original_and_remove_records_until_reconfirmed(self):
  doc=next(d for d in bridge.store.state()['documents'] if d['status']=='done');identifier=doc['id'];count=doc['record_count'];source=(bridge.store.directory/'files'/identifier/('original'+doc['extension'])).read_bytes()
  result=self.request('/api/documents/'+identifier+'/organize','POST',{'action':'park','category':'other','note':'虛構分類','expected_version':0,'acknowledge_records':True,'expected_record_count':count});self.assertEqual(result['status'],200)
  self.assertFalse(any(r['document_id']==identifier for r in bridge.store.records()));self.assertEqual((bridge.store.directory/'files'/identifier/('original'+doc['extension'])).read_bytes(),source)
  self.assertEqual(self.request('/api/documents/'+identifier+'/organize','POST',{'action':'trash','expected_version':1})['status'],200)
  self.assertEqual(self.request('/api/documents/'+identifier+'/organize','POST',{'action':'restore','expected_version':2})['data']['document']['bucket'],'review')
 def test_backup_restore_is_complete_and_rejects_traversal_before_modification(self):
  before=len(bridge.store.state()['documents']);f=io.BytesIO()
  with zipfile.ZipFile(f,'w') as z:z.writestr('data/ledger.sqlite3',b'fake');z.writestr('data/../../outside',b'invalid')
  self.assertEqual(self.request('/internal/restore','POST',content=f.getvalue())['status'],400);self.assertEqual(len(bridge.store.state()['documents']),before)
  bridge.restore_backup(self.backup);self.assertEqual(len(bridge.store.records()),42)
 def test_ocr_completion_and_retry_use_real_result_and_version_guard(self):
  image=(ROOT/'public/assets/slip-a.jpg').read_bytes();uploaded=self.request('/api/upload?name=ocr-test.jpg','POST',content=image)['data'];identifier=uploaded['id']
  self.assertEqual(self.request('/internal/ocr-start','POST',{'id':identifier})['status'],200)
  ocr=json.loads((ROOT/'tests/fixtures/hh.json').read_text());self.assertEqual(self.request('/internal/ocr-result','POST',{'id':identifier,'ocr':ocr})['status'],200)
  doc=bridge.store.document(identifier);self.assertEqual(doc['status'],'pending');self.assertEqual(doc['draft']['items'][0]['dims'],[12,28,94]);self.assertFalse(any(r['document_id']==identifier for r in bridge.store.records()))
  self.assertEqual(self.request('/api/documents/'+identifier+'/retry','POST',{'replace':True},{'X-MaterialDemo-Content-Version':str(doc['content_version'])})['status'],200)
 def test_financial_analysis_export_and_zero_vs_unlisted_are_preserved(self):
  result=self.request('/api/analysis?price_basis=gross')['data'];self.assertEqual(result['price_basis'],'gross');self.assertEqual(result['global_counts']['records'],42)
  self.assertTrue(self.request('/api/analysis/export.csv')['bytes']);self.assertTrue(self.request('/api/analysis/template?kind=quotes')['bytes'])
  items=[i for d in SEED['documents'] for i in d['draft']['items']];self.assertTrue(any(i.get('processing_fee') is None for i in items));self.assertTrue(any(i.get('processing_fee')==0 for i in items))
  for i in items:
   if i.get('price') is not None:self.assertAlmostEqual(estimate_amount(i),i['amount'],places=2)

if __name__=='__main__':unittest.main()
