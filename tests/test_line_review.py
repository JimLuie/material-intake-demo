"""Saved ledger diagnostics and atomic, draft-backed line review progress."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from analysis import DEFAULT_DENSITIES, observations, fingerprint
from analysis_quality import record_summaries as _record_summaries

def record_summaries(*args): return _record_summaries(*args, price_basis="original")
from server import Store, csv_bytes
import test_analysis as fixtures


class RecordAnalysisTests(unittest.TestCase):
    def rows(self):
        return [fixtures.row('a', id='a-0', position=0, grade='S50C'),
                fixtures.row('a', id='a-1', position=1, grade='S50C', amount=1)]

    def test_individual_lines_match_chart_not_document_aggregate(self):
        rows=self.rows(); docs=[dict(id='a', status='done')]; original=copy.deepcopy(rows)
        summaries=record_summaries(rows,docs,{},DEFAULT_DENSITIES)
        obs=observations(rows,docs,[],{},DEFAULT_DENSITIES,'original')
        self.assertEqual(summaries['a-0']['status'],'usable')
        self.assertEqual(summaries['a-1']['status'],'needs_review')
        for row in obs:
            self.assertEqual(summaries[row['id']]['eligible'],row['eligible'])
            self.assertEqual(summaries[row['id']]['issues'],row['issues'])
        self.assertEqual(rows,original)

    def test_pending_never_substitutes_reordered_preview(self):
        rows=self.rows(); draft=fixtures.draft(); draft['items'][0]['grade']='7075'
        summaries=record_summaries(rows,[dict(id='a',status='pending',draft=draft)],{},DEFAULT_DENSITIES)
        self.assertTrue(all(s['status']=='pending' and not s['eligible'] for s in summaries.values()))
        self.assertEqual(summaries['a-0']['reason'],'原單待重新確認')

    def test_blank_material_unsupported_duplicates_and_missing_source(self):
        for grade,status in [('', 'needs_review'),('SKD11','unsupported')]:
            row=fixtures.row('a',grade=grade)
            self.assertEqual(record_summaries([row],[dict(id='a',status='done')],{},DEFAULT_DENSITIES)[row['id']]['status'],status)
        rows=[fixtures.row('a',grade='S50C',doc='SAME'),fixtures.row('b',grade='S50C',doc='SAME')]
        docs=[dict(id='a',status='done',created='1'),dict(id='b',status='done',created='2')]
        self.assertEqual(record_summaries(rows,docs,{},DEFAULT_DENSITIES)[rows[1]['id']]['status'],'duplicate')
        self.assertEqual(record_summaries(rows[:1],[],{},DEFAULT_DENSITIES)[rows[0]['id']]['status'],'unchecked')

    def test_zero_blank_fee_weight_pricing_and_stale_supplement(self):
        for fee in [None,0]:
            row=fixtures.row('a',grade='S50C',price=0,amount=0,material_amount=0,processing_fee=fee,subtotal=None,tax=None,document_total=None)
            s=record_summaries([row],[dict(id='a',status='done')],{},DEFAULT_DENSITIES)[row['id']]
            self.assertEqual(s['status'],'usable');self.assertTrue(s['theoretical_weight']);self.assertTrue(s['tax_unconfirmed'])
        row=fixtures.row('a',grade='S50C',qty=7,weight_kg=8.4,pricing_basis='weight',price=125,material_amount=1050,processing_fee=490,amount=1540)
        s=record_summaries([row],[dict(id='a',status='done')],{},DEFAULT_DENSITIES)[row['id']]
        self.assertEqual(s['status'],'usable');self.assertFalse(s['theoretical_weight'])
        s=record_summaries([row],[dict(id='a',status='done')],{row['id']:dict(fingerprint='old',data={'weight_kg':1})},DEFAULT_DENSITIES)[row['id']]
        self.assertEqual(s['primary_issue']['code'],'stale_supplement')


class ReviewPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name))
        self.id=self.store.import_bytes('review.jpg',b'isolated-review',submit=False)['id']
        with self.store.connect() as db: db.execute("UPDATE documents SET status='pending' WHERE id=?",(self.id,))
        self.draft=fixtures.draft()
        self.draft['items']=[copy.deepcopy(self.draft['items'][0]) for _ in range(3)]
        self.draft['meta'].update(subtotal=None,tax=None,total=None)
        self.store.confirm(self.id,self.draft)
        self.before=self.store.records()
        self.export=csv_bytes(self.before,self.store.suppliers())

    def tearDown(self):
        self.store.executor.shutdown();self.tmp.cleanup()

    def test_progress_round_trip_does_not_update_ledger_until_whole_confirm(self):
        draft=copy.deepcopy(self.draft)
        for position in range(3):
            draft['items'][position]['price']=0
            draft['items'][position]['amount']=0
            draft['review_progress']=dict(version=1,completed=False,meta='snapshot',items=['checked']*(position+1)+[None]*(2-position))
            self.store.save_draft(self.id,draft)
            loaded=self.store.document(self.id)
            self.assertEqual(loaded['draft']['review_progress'],draft['review_progress'])
            self.assertEqual(loaded['status'],'pending')
            self.assertEqual(self.store.records(),self.before)
            self.assertEqual(csv_bytes(self.store.records(),self.store.suppliers()),self.export)
        self.assertEqual(self.store.confirm(self.id,draft),3)
        self.assertTrue(self.store.document(self.id)['draft']['review_progress']['completed'])
        self.assertEqual([r['price'] for r in self.store.records()],[0,0,0])
        self.assertFalse(any('review_progress' in r for r in self.store.records()))

    def test_state_appends_readonly_summary_but_internal_records_and_exports_unchanged(self):
        with self.store.connect() as db: before=db.execute('SELECT * FROM records').fetchall()
        state=self.store.state()
        self.assertEqual(len(state['records']),3)
        self.assertTrue(all(r['analysis_summary']['price_basis']=='gross' for r in state['records']))
        self.assertTrue(all('analysis_summary' not in r for r in self.store.state(include_analysis=False)['records']))
        import csv,io
        csv_before=list(csv.reader(io.StringIO(self.export.decode('utf-8-sig'))));after=list(csv.reader(io.StringIO(csv_bytes(state['records'],self.store.suppliers()).decode('utf-8-sig'))))
        self.assertEqual([r[:26] for r in csv_before],[r[:26] for r in after])
        with self.store.connect() as db: self.assertEqual(db.execute('SELECT * FROM records').fetchall(),before)

    def test_failed_whole_validation_keeps_original_records(self):
        draft=copy.deepcopy(self.draft);draft['items'][2]['qty']=0
        draft['review_progress']=dict(version=1,completed=False,items=['a','b','c'])
        self.store.save_draft(self.id,draft)
        with self.assertRaises(ValueError): self.store.confirm(self.id,draft)
        self.assertEqual(self.store.records(),self.before)
        self.assertFalse(self.store.document(self.id)['draft']['review_progress']['completed'])


if __name__=='__main__':unittest.main()
