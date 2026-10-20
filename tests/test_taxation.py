import copy,csv,io,json,tempfile,threading,unittest
from decimal import Decimal
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from server import Store,Handler,ThreadingHTTPServer,csv_bytes
from domain import parse_ocr,validate_draft,SUPPLIERS
from analysis import observations,DEFAULT_DENSITIES
from taxation import settings,suggest,allocate,gross_document,gross_price_issues
from tax_store import preview,apply,correction_preview,TaxConflict,migrate

FIX=Path(__file__).parent/'fixtures'
def row(i=0,**kw):
    return dict(dict(id=f'a-{i}',document_id='a',position=i,kind='invoice',sup='sk',label='S50C',grade='S50C',shape='rect',dims=[10,20,100],qty=10,unit='件',date='2025-10-17',doc='TAX',price=10,amount=100,weight_kg=2,processing_fee=None,material_amount=None,subtotal=100,tax=None,document_total=100),**kw)
def cfg(**kw):return settings(dict(dict(transaction_type='purchase',tax_basis='included',tax_rate=5,source='manual_review'),**kw))
def observed(rows=None,setting=None,basis='gross'):
    rows=rows or [row()];doc=dict(id='a',status='done',tax_settings=setting or cfg())
    return observations(rows,[doc],[],{},DEFAULT_DENSITIES,basis)

class TaxMathTests(unittest.TestCase):
    def test_hh_split_header_is_10_and_10000_not_dimensions(self):
        d=parse_ocr(json.loads((FIX/'hh-split-header.json').read_text()));r=d['items'][0]
        self.assertEqual((r['dims'],r['qty'],r['price'],r['amount']),([12,28,94],152,18.75,2850))
        self.assertEqual((d['meta']['tax'],d['meta']['total']),(260,5457.8));self.assertEqual(d['tax_settings']['tax_basis'],'pretax')
    def test_missing_price_header_never_uses_dimensions_as_price(self):
        o=json.loads((FIX/'hh-split-header.json').read_text());o['pages'][0]['lines']=[l for l in o['pages'][0]['lines'] if l['text'] not in ['單','價','金','額']]
        r=parse_ocr(o)['items'][0];self.assertIsNone(r['price']);self.assertIsNone(r['amount']);self.assertEqual(r['dims'],[12,28,94])
    def test_company_rules_do_not_leak_to_unknown_suppliers(self):
        self.assertEqual(suggest({'meta':{'sup':'sk','tax':None}})['tax_basis'],'included')
        self.assertEqual(suggest({'meta':{'sup':'hh','tax':500}})['tax_basis'],'pretax')
        self.assertEqual(suggest({'meta':{'sup':'new','tax':None}})['tax_basis'],'unknown')
        self.assertEqual(suggest({'meta':{'sup':'zf'}})['transaction_type'],'customer_supplied')
    def test_largest_remainder_ties_zero_and_exact_sum(self):
        self.assertEqual(allocate([1,1,1],'.02'),[Decimal('.01'),Decimal('.01'),Decimal('0')])
        self.assertEqual(allocate([0,1,2],'.01'),[Decimal('0'),Decimal('0'),Decimal('.01')])
        self.assertEqual(sum(allocate([125,275],20)),20)
        self.assertEqual(allocate([0,0],0),[0,0])
        with self.assertRaises(ValueError):allocate([0,0],1)
    def test_synthetic_allocation_matches_total(self):
        rows=[row(0,amount=125,subtotal=400,tax=20,document_total=420),row(1,amount=275,subtotal=400,tax=20,document_total=420)]
        r=gross_document(rows,cfg(tax_basis='pretax'));self.assertEqual(sum(Decimal(str(v['gross_amount'])) for v in r.values()),420)
        self.assertEqual([r[f'a-{i}']['allocated_tax'] for i in range(2)],[6.25,13.75])
    def test_document_total_must_match_allocated_cents_exactly(self):
        r=observed([row(document_total=100.01)])[0]
        self.assertFalse(r['eligible']);self.assertIn('含稅總計',r['reason'])
    def test_shengkai_included5720_not_taxed_again(self):
        r=observed([row(qty=26,price=220,amount=5720,subtotal=None,document_total=5720)])[0]
        self.assertTrue(r['eligible']);self.assertEqual(r['analysis_cost'],5720);self.assertIsNone(r['tax']);self.assertIsNone(r['allocated_tax']);self.assertTrue(r['tax_estimated'])
    def test_harvard_10000_plus500(self):
        r=observed([row(qty=1000,price=10,amount=10000,subtotal=10000,tax=500,document_total=10500)],cfg(tax_basis='pretax'))[0]
        self.assertTrue(r['eligible']);self.assertEqual((r['allocated_tax'],r['gross_amount'],r['unit_kg']),(500,10500,5250))
    def test_processing_fee_is_included_exactly_once(self):
        r=observed([row(qty=7,weight_kg=8.4,pricing_basis='weight',price=125,material_amount=1050,processing_fee=490,amount=1540,subtotal=None,document_total=1540)])[0]
        self.assertTrue(r['eligible']);self.assertEqual(r['gross_amount'],1540);self.assertAlmostEqual(r['unit_kg'],1540/8.4)
        self.assertEqual(r['qty'],7);self.assertEqual(r['original_unit_kg'],125)
    def test_blank_price_allowed_but_conflicting_price_excluded(self):
        self.assertTrue(observed([row(price=None)])[0]['eligible'])
        r=observed([row(price=24)])[0];self.assertFalse(r['eligible']);self.assertIsNone(r['gross_unit_kg']);self.assertIn('單價',r['reason'])
    def test_blank_and_actual_zero_fee_and_price_preserved(self):
        for fee in [None,0]:
            raw=row(price=0,amount=0,subtotal=0,document_total=0,processing_fee=fee);before=copy.deepcopy(raw);r=observed([raw])[0]
            self.assertTrue(r['eligible']);self.assertEqual(r['unit_kg'],0);self.assertEqual(r['processing_fee'],fee);self.assertEqual(raw,before)
    def test_missing_amount_cannot_borrow_footer_or_other_lines(self):
        rows=[row(0,price=None,amount=None),row(1,amount=100)]
        self.assertTrue(all(not r['eligible'] for r in observed(rows)))
        self.assertIsNone(rows[0]['amount'])
    def test_total_conflict_unknown_tax_invalid_weight_and_negative_fee(self):
        for change in [dict(document_total=101),dict(weight_kg=0),dict(processing_fee=-1),dict(amount=-1)]:self.assertFalse(observed([row(**change)])[0]['eligible'])
        self.assertFalse(observed(setting=cfg(tax_basis='unknown'))[0]['eligible'])
    def test_printed_tax_wins_and_missing_tax_calculates_without_writing(self):
        raw=row(amount=110,price=11,subtotal=110,tax=6,document_total=116);r=observed([raw],cfg(tax_basis='pretax'))[0]
        self.assertEqual(r['allocated_tax'],6);self.assertFalse(r['tax_estimated'])
        raw['tax']=None;r=observed([raw],cfg(tax_basis='pretax'))[0];self.assertTrue(r['eligible']);self.assertEqual(r['estimated_tax'],6);self.assertIsNone(raw['tax'])
    def test_customer_supplied_not_zero_or_missing_price_problem(self):
        r=observed([row(grade='',qty=240,price=None,amount=None,document_total=None)],cfg(transaction_type='customer_supplied'))[0]
        self.assertFalse(r['eligible']);self.assertEqual(r['review_status'],'customer_supplied');self.assertEqual(r['issues'],[]);self.assertIsNone(r['unit_kg'])
    def test_strict_material_does_not_assume_blank_fee_zero(self):
        self.assertFalse(observed(basis='material')[0]['eligible'])
        self.assertTrue(observed([row(material_amount=100)],basis='material')[0]['eligible'])
        self.assertTrue(observed(basis='original')[0]['eligible'])
    def test_invalid_settings_are_rejected(self):
        for bad in [dict(tax_rate=''),dict(tax_rate=-1),dict(tax_rate='NaN'),dict(tax_basis='no'),dict(transaction_type='other')]:
            with self.assertRaises(ValueError):cfg(**bad)

class TaxPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name));self.id=self.store.import_bytes('original.jpg',b'isolated-tax-original',submit=False)['id']
        self.ocr=json.loads((FIX/'hh-split-header.json').read_text());self.draft=parse_ocr(self.ocr);self.draft['items'][0].update(price=24,amount=52)
        with self.store.connect() as db:db.execute("UPDATE documents SET status='pending',ocr=? WHERE id=?",(json.dumps(self.ocr),self.id))
        self.store.confirm(self.id,self.draft);self.original=self.store.records()
    def tearDown(self):self.store.executor.shutdown();self.tmp.cleanup()
    def raw(self):
        with self.store.connect() as db:return [tuple(r) for r in db.execute('SELECT * FROM records')],db.execute('SELECT draft FROM documents WHERE id=?',(self.id,)).fetchone()[0]
    def test_preview_and_candidate_are_readonly_and_conflicts_not_selected(self):
        before=self.raw();r=preview(self.store)['documents'][0];self.assertFalse(r['selected']);self.assertTrue(r['conflicts']);self.assertEqual(r['suggested']['tax_basis'],'pretax')
        c=correction_preview(self.store,self.id);self.assertIn(dict(item=0,key='price',old=24.0,new=18.75),c['differences']);self.assertEqual(self.raw(),before)
    def test_batch_only_settings_changes_and_stale_saves_are_rejected(self):
        before=self.raw();d=self.store.document(self.id);version=d['content_version']
        selection=dict(id=self.id,version=version,organization_version=0,settings=cfg(tax_basis='pretax'))
        self.assertEqual(apply(self.store,dict(documents=[selection]))['count'],1);self.assertEqual(self.raw(),before)
        self.assertEqual(self.store.document(self.id)['tax_settings']['source'],'manual_batch')
        with self.assertRaises(TaxConflict):apply(self.store,dict(documents=[selection]))
        with self.assertRaises(TaxConflict):self.store.save_draft(self.id,self.draft,0,version)
        with self.assertRaises(TaxConflict):self.store.confirm(self.id,self.draft,0,version)
        self.assertEqual(self.store.records(),self.original)
    def test_individual_candidate_confirmation_is_only_time_money_changes(self):
        d=self.store.document(self.id);candidate=correction_preview(self.store,self.id)['candidate'];candidate['tax_settings']=cfg(tax_basis='pretax')
        summary=self.store.save_draft(self.id,candidate,0,d['content_version']);self.assertEqual(self.store.records(),self.original)
        self.assertEqual(summary['usable'],2);self.store.confirm(self.id,candidate,0,summary['content_version'])
        r=next(r for r in self.store.state()['records'] if r['position']==0);self.assertEqual((r['price'],r['amount']),(18.75,2850));self.assertAlmostEqual(r['analysis_summary']['gross_amount'],2992.56)
        self.assertEqual(self.store.analysis.query({'price_basis':'gross'})['counts']['eligible'],2)
    def test_manual_tax_in_a_pending_draft_survives_recognition(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        current=self.store.document(self.id);draft=copy.deepcopy(current['draft']);draft['tax_settings']=cfg(tax_basis='included',tax_rate=8)
        self.store.save_draft(self.id,draft,0,current['content_version'])
        with patch('server.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(self.ocr).encode(),stderr=b'')):
            self.store.process(self.id)
        reloaded=self.store.document(self.id);self.assertEqual(reloaded['draft']['tax_settings']['tax_basis'],'included');self.assertEqual(reloaded['draft']['tax_settings']['tax_rate'],8)
        self.assertEqual(self.store.records(),self.original)
    def test_older_draft_revision_cannot_overwrite_new_tax_edits(self):
        d=self.store.document(self.id);draft=copy.deepcopy(d['draft']);draft['tax_settings']=cfg(tax_rate=10)
        result=self.store.save_draft(self.id,draft,0,d['content_version'])
        with self.assertRaises(TaxConflict):self.store.save_draft(self.id,d['draft'],0,d['content_version'])
        self.assertEqual(self.store.document(self.id)['draft']['tax_settings']['tax_rate'],10)
        self.assertEqual(result['content_version'],d['content_version']+1)
    def test_migration_repeatable_and_original_attachments_untouched(self):
        before=self.raw();migrate(self.store);migrate(self.store);self.assertEqual(self.raw(),before)
        self.assertEqual((self.store.directory/'files'/self.id/'original.jpg').read_bytes(),b'isolated-tax-original')
    def test_batch_is_atomic_with_one_stale_selection(self):
        old=self.store.document(self.id)['content_version'];second=self.store.import_bytes('second.jpg',b'second-tax',submit=False)['id']
        with self.store.connect() as db:db.execute("UPDATE documents SET status='pending' WHERE id=?",(second,))
        self.store.confirm(second,self.draft)
        entries=[dict(id=self.id,version=old,organization_version=0,settings=cfg()),dict(id=second,version=0,organization_version=0,settings=cfg())]
        with self.assertRaises(TaxConflict):apply(self.store,dict(documents=entries))
        self.assertEqual(self.store.document(self.id)['content_version'],old)
    def test_export_preserves_legacy_prefix_and_appends_gross_columns(self):
        rows=self.store.state()['records'];export=list(csv.reader(io.StringIO(csv_bytes(rows,self.store.suppliers()).decode('utf-8-sig'))))
        self.assertEqual(len(export[0]),32);self.assertEqual(export[0][26:29],['交易性質','單價稅別','稅率(%)']);self.assertEqual(export[2][11:13],['24.0','52.0'])
        result=list(csv.reader(io.StringIO(self.store.analysis.export('analysis',{'price_basis':'gross'}).decode('utf-8-sig'))));self.assertEqual(result[0][-1],'含稅成交公斤價(TWD/kg)')

if __name__=='__main__':unittest.main()
