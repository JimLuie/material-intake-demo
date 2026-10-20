"""Public PDF fixtures plus shared chart/queue eligibility and snapshot regressions."""
import copy
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from analysis import DEFAULT_DENSITIES, observations, build_analysis, fingerprint
from analysis_quality import document_summaries as _document_summaries, preview_rows

def document_summaries(*args): return _document_summaries(*args, price_basis="original")
from steel_data import parse_steel, pdf_pages, fetch_steel, SERIES, HISTORY_URL, RECENT_URL
from market_data import check_origin, csv_preview
from server import Handler, csv_bytes
import test_analysis as fixtures

FIXTURE=json.loads((Path(__file__).parent/'fixtures/steelbenchmarker-china.json').read_text())


def steel_row(identifier='a', **changes):
    return fixtures.row(identifier, **dict(dict(grade='S50C', label='S50C', material_amount=None, subtotal=None, tax=None, document_total=None), **changes))


def summaries(rows, docs=None, notes=None):
    docs=docs or [dict(id=r['document_id'], status='done') for r in rows]
    return document_summaries(rows, docs, notes or {}, DEFAULT_DENSITIES, {'hh':{'name':'Test'}})


class SteelSourceTests(unittest.TestCase):
    def test_real_full_history_and_recent_exact_price_columns_dates_units(self):
        full=parse_steel(FIXTURE['history'],HISTORY_URL); recent=parse_steel(FIXTURE['recent'],RECENT_URL)
        self.assertEqual(len(full),980);self.assertEqual(len(recent),80)
        lookup={(r['series'],r['period']):r for r in full+recent}
        for period,hrb,plate in [('2006-04-10',402,380),('2025-06-09',376,408),('2025-06-23',375,404),('2026-05-11',441,452),('2026-05-25',434,451),('2026-10-12',422,454)]:
            for series,price in zip(SERIES,[hrb,plate]):
                r=lookup[series,period];self.assertEqual(r['value'],price)
                self.assertEqual((r['metal'],r['region'],r['currency'],r['unit'],r['frequency']),('steel','China','USD','tonne','daily'))
        self.assertEqual(len(lookup),984)
        self.assertNotIn((SERIES[0],'2026-10-14'),lookup) # Publication date is not observation date.

    def test_other_countries_graphs_deltas_never_become_china_prices(self):
        page=copy.deepcopy(FIXTURE['recent'][0]);page['text']=page['text'].replace('China\n','USA\n').replace('Metric Tonne','Net Ton')
        self.assertEqual(parse_steel([page]+FIXTURE['recent'],RECENT_URL),parse_steel(FIXTURE['recent'],RECENT_URL))
        with self.assertRaises(ValueError):parse_steel([page],RECENT_URL)

    def test_changed_units_columns_percentage_positions_fail_closed(self):
        for old,new in [('Metric Tonne','Net Ton'),('Ex-works','FOB mill'),('CRC','OTHER'),('401 5 1.3%','401 1.3% 5')]:
            pages=copy.deepcopy(FIXTURE['recent']);pages[0]['text']=pages[0]['text'].replace(old,new)
            with self.subTest(old=old), self.assertRaises(ValueError):parse_steel(pages,RECENT_URL)

    def test_wrapped_rows_missing_prices_and_conflicting_duplicates(self):
        page=dict(number=1,text='China\nEx-works\nDollars per Metric Tonne\nHRB CRC Plate Rebar\nPrice Chng Chng\n12-Oct-26 422 -4 -0.9% 500 -2 -0.4%\n454 -5 -1.1% 409 -3 -0.7%\n26-Oct-26 na - - 500 -2 -0.4% 450 -4 -0.9% 400 -9 -2.2%\nNotes:')
        rows=parse_steel([page],RECENT_URL);self.assertEqual(len(rows),3)
        conflict=dict(page,text=page['text'].replace('422 -4','423 -4'))
        with self.assertRaises(ValueError):parse_steel([page,conflict],RECENT_URL)

    def test_full_history_then_recent_replaces_same_date_only(self):
        with patch('market_data.download',side_effect=[b'full',b'recent']) as dl,patch('steel_data.pdf_pages',side_effect=[FIXTURE['history'],FIXTURE['recent']]):
            rows=fetch_steel(True);self.assertEqual(len(rows),984);self.assertEqual(dl.call_count,2)
            self.assertEqual(next(r['url'] for r in rows if r['period']=='2026-09-14'),RECENT_URL)

    def test_recent_official_www_mirror_only_on_download_failure(self):
        with patch('market_data.download',side_effect=[OSError('dns'),b'pdf']) as dl,patch('steel_data.pdf_pages',return_value=FIXTURE['recent']):
            rows=fetch_steel(False);self.assertEqual(dl.call_args_list[-1].args[0],'https://www.steelbenchmarker.com/history.pdf')
            self.assertTrue(all(r['url'].startswith('https://www.steelbenchmarker.com/') for r in rows))

    def test_origin_and_reserved_import_codes(self):
        for url in [HISTORY_URL,RECENT_URL]:check_origin(url)
        for url in ['http://steelbenchmarker.com/history.pdf','https://evil.example/x','https://steelbenchmarker.com:444/x']:
            with self.assertRaises(ValueError):check_origin(url)
        content='series,label,source,contract,frequency,period,value,currency,unit\nsb-china-hrb,x,x,x,daily,2026-10-12,422,USD,tonne\n'
        self.assertTrue(csv_preview('market',content,[])['errors'])

    def test_sparse_monthly_mean_same_day_fx_no_interpolation_and_default_hrb(self):
        prices=parse_steel(FIXTURE['recent'],RECENT_URL)
        rates=[dict(source='cbc',frequency='daily',period=d,value=v) for d,v in [('2025-06-09',30),('2025-06-23',32)]]
        r=build_analysis([],prices,rates,dict(metal='steel',start='2025-06-01',end='2025-07-31'))
        self.assertEqual(r['market_series'],SERIES[0]);p=r['series'][0]['points'][0]
        self.assertEqual((p['period'],p['count']),('2025-06',2));self.assertAlmostEqual(p['value'],(376*30+375*32)/2000)
        self.assertEqual(len(r['series'][0]['points']),1);self.assertIn('2025-07-14',r['fx_gaps'])
        r=build_analysis([],prices,rates,dict(metal='steel',market=SERIES[1],start='2025-06-01',end='2025-06-30'))
        self.assertEqual(r['market_series'],SERIES[1]);self.assertAlmostEqual(r['series'][0]['points'][0]['value'],(408*30+404*32)/2000)
        r=build_analysis([],prices,rates[:1],dict(metal='steel',start='2025-06-01',end='2025-06-30'))
        self.assertEqual(r['series'][0]['points'][0]['count'],1);self.assertIn('2025-06-23',r['fx_gaps'])

    def test_full_history_does_not_expand_default_procurement_window(self):
        row=steel_row(date='2025-06-10');obs=observations([row],[dict(id='a',status='done')],[],{},DEFAULT_DENSITIES,'original')
        prices=parse_steel(FIXTURE['history'],HISTORY_URL)
        rates=[dict(source='cbc',frequency='daily',period=r['period'],value=30) for r in prices]
        r=build_analysis(obs,prices,rates,dict(metal='steel',price_basis='original'))
        self.assertEqual({p['period'] for s in r['series'] for p in s['points']},{'2025-06'})
        self.assertEqual(r['baseline'],'2025-06')


class QualityMathTests(unittest.TestCase):
    def test_partial_multiline_exactly_matches_chart_and_keeps_positions(self):
        rows=[steel_row('a',id='a-0',position=0),steel_row('a',id='a-1',position=1,amount=1)]
        before=copy.deepcopy(rows);summary=summaries(rows)['a'];obs=observations(rows,[dict(id='a',status='done')],[],{},DEFAULT_DENSITIES,'original')
        self.assertEqual((summary['status'],summary['usable'],summary['total']),('partial',1,2))
        self.assertEqual(summary['usable'],sum(r['eligible'] for r in obs))
        self.assertEqual(summary['issues'][0]['key'],'amount');self.assertEqual(summary['issues'][0]['item'],1)
        self.assertEqual(rows,before);self.assertEqual(summary['tax_unconfirmed'],2)

    def test_missing_grade_unsupported_duplicate_and_unchecked(self):
        rows=[steel_row('a',grade=''),steel_row('b',grade='SKD11'),steel_row('c'),steel_row('d',doc='Nc')]
        s=summaries(rows);self.assertEqual(s['a']['status'],'needs_review');self.assertEqual(s['b']['status'],'unsupported')
        self.assertEqual(s['d']['status'],'duplicate')
        s=summaries(rows,[dict(id=r['document_id'],status='error') for r in rows]);self.assertTrue(all(v['status']=='unchecked' and v['usable']==0 for v in s.values()))

    def test_zero_money_blank_fee_and_weight_pricing_share_original_rules(self):
        for fee in [None,0]:
            s=summaries([steel_row(price=0,amount=0,processing_fee=fee)])['a'];self.assertEqual(s['status'],'usable')
        row=steel_row(qty=7,weight_kg=8.4,pricing_basis='weight',price=125,material_amount=1050,processing_fee=490,amount=1540)
        s=summaries([row])['a'];self.assertEqual(s['status'],'usable');self.assertEqual(s['theoretical_weight'],0)
        for change in [dict(weight_kg=0),dict(processing_fee=-1),dict(price=None),dict(amount=1541),dict(qty=0)]:
            self.assertEqual(summaries([dict(row,**change)])['a']['status'],'needs_review')

    def test_stale_supplement_excluded_and_locatable(self):
        row=steel_row();s=summaries([row],notes={row['id']:dict(fingerprint='old',data={'weight_kg':1})})['a']
        self.assertEqual(s['status'],'needs_review');self.assertTrue(any(i['code']=='stale_supplement' for i in s['issues']))

    def test_preview_units_invalid_line_and_no_curve_until_confirmed(self):
        draft=fixtures.draft();draft['items'][0].update(grade='S50C',shape='rect',dims=[1,2,10],dim_unit='cm',qty=10,price=10,amount=100,material_amount=None,weight_kg=None,processing_fee=None)
        draft['meta'].update(subtotal=None,tax=None,total=None)
        draft['items'].append(dict(draft['items'][0],grade='',dims=[0,2,10],price=''))
        doc=dict(id='a',status='pending',draft=draft);before=copy.deepcopy(doc)
        s=document_summaries([], [doc], {},DEFAULT_DENSITIES, {'hh':{}})['a']
        self.assertTrue(s['preview']);self.assertEqual((s['usable'],s['total']),(1,2));self.assertEqual(preview_rows(doc,{'hh':{}})[0]['dims'],[10,20,100])
        self.assertTrue(any(i['key']=='grade' for i in s['lines'][1]['issues']));self.assertEqual(doc,before)
        obs=observations(preview_rows(doc,{'hh':{}}),[doc],[],{},DEFAULT_DENSITIES,'original');self.assertFalse(any(r['eligible'] for r in obs))


class QualityPersistenceTests(unittest.TestCase):
    setUp=fixtures.AnalysisPersistenceTests.setUp
    tearDown=fixtures.AnalysisPersistenceTests.tearDown
    def test_state_is_readonly_matches_chart_and_does_not_recurse(self):
        with self.store.connect() as db:before=list(map(tuple,db.execute('SELECT * FROM documents')))
        state=self.store.state();s=state['documents'][0]['analysis_summary']
        r=self.a.query({'price_basis':'original'});self.assertEqual(s['usable'],r['counts']['eligible'])
        self.assertEqual(csv_bytes(self.store.records(),self.store.suppliers()),self.export)
        with self.store.connect() as db:self.assertEqual(before,list(map(tuple,db.execute('SELECT * FROM documents'))))

    def test_draft_save_returns_preview_for_committed_values_and_stale_note(self):
        row=self.original[0];self.a.save_note(row['id'],dict(fingerprint=fingerprint(row),weight_kg=1))
        draft=fixtures.draft();draft['items'][0]['price']=13
        s=self.store.save_draft(self.doc,draft);self.assertTrue(s['preview']);self.assertEqual(s['status'],'needs_review')
        self.assertTrue(any(i['code']=='stale_supplement' for i in s['issues']))
        self.assertEqual(self.store.records(),self.original)
        self.assertEqual(self.store.state()['documents'][0]['analysis_summary'],s)

    def test_full_update_marker_recent_replay_and_failure_preserve_cache(self):
        rows=parse_steel(FIXTURE['history'],HISTORY_URL)+parse_steel(FIXTURE['recent'],RECENT_URL)
        with patch('analysis_store.fetch_steel',return_value=rows) as steel,patch('analysis_store.fetch_worldbank',side_effect=OSError('offline')),patch('analysis_store.download',side_effect=OSError('offline')):
            result=self.a.update_market();steel.assert_called_once_with(True)
            self.assertEqual(result['results']['steel']['latest'],'2026-10-12');self.assertEqual(len(result['errors']),3)
        before=self.a.values('analysis_market');self.assertEqual(len(before),984)
        with patch('analysis_store.fetch_steel',return_value=parse_steel(FIXTURE['recent'],RECENT_URL)) as steel,patch('analysis_store.fetch_worldbank',side_effect=OSError('offline')),patch('analysis_store.download',side_effect=OSError('offline')):
            self.a.update_market();steel.assert_called_once_with(False)
        self.assertEqual(len(self.a.values('analysis_market')),984)
        before=self.a.values('analysis_market')
        with patch('analysis_store.fetch_steel',side_effect=ValueError('changed columns')),patch('analysis_store.fetch_worldbank',return_value=[dict(series='wb-aluminium',frequency='monthly',period='2026-09',value=2000,currency='USD',unit='tonne')]),patch('analysis_store.download',side_effect=OSError('offline')):
            result=self.a.update_market();self.assertIn('aluminium',result['results']);self.assertTrue(any(e.startswith('steel：') for e in result['errors']))
        self.assertEqual([r for r in self.a.values('analysis_market') if r['series'] in SERIES],before)
        self.assertEqual(self.store.records(),self.original)
        with self.assertRaises(ValueError):self.a.classify_market(SERIES[0],'aluminum')



if __name__=='__main__':unittest.main()
