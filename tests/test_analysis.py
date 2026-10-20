import copy
import io
import json
import math
import sqlite3
import tempfile
import threading
import unittest
import zipfile
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from analysis import (theoretical_weight, observations, build_analysis, DEFAULT_DENSITIES, fingerprint,
                      material_cost, validate_quote, quote_csv_preview, QUOTE_COLUMNS, csv_output)
from market_data import parse_worldbank, parse_cbc, csv_preview, MARKET_COLUMNS, FX_COLUMNS
from server import Store, Handler, ThreadingHTTPServer, csv_bytes
from test_system import draft


def row(identifier='a', **changes):
    result = dict(id=identifier+'-0', document_id=identifier, position=0, sup='hh', doc='N'+identifier, date='2026-01-10', grade='6061', label='6061',
                  shape='rect', dims=[10, 20, 100], qty=10, unit='件', price=10, amount=100, material_amount=100, processing_fee=None, weight_kg=None,
                  pricing_basis='quantity', subtotal=100, tax=5, document_total=105, temper='')
    result.update(changes); return result


def observe(rows, notes=None, quotes=None, statuses=None):
    return observations(rows, [{'id': r['document_id'], 'status': (statuses or {}).get(r['document_id'], 'done')} for r in rows], quotes or [], notes or {}, DEFAULT_DENSITIES)


class AnalysisMathTests(unittest.TestCase):
    def test_rect_round_total_mass_and_no_dim_permutation(self):
        self.assertAlmostEqual(theoretical_weight(row(), DEFAULT_DENSITIES), .542)
        self.assertAlmostEqual(theoretical_weight(row(shape='round', dims=[70, 107], qty=240, grade='7075'), DEFAULT_DENSITIES), math.pi*70**2*107/4*240*2.8/1e6)
        self.assertNotEqual(theoretical_weight(row(shape='round', dims=[70, 107]), DEFAULT_DENSITIES), theoretical_weight(row(shape='round', dims=[107, 70]), DEFAULT_DENSITIES))
        for changes in [dict(grade=''), dict(grade='UNKNOWN'), dict(qty=0), dict(qty=1.5), dict(unit='組'), dict(dims=[10, 0, 20]), dict(dims=[10, 20])]:
            self.assertIsNone(theoretical_weight(row(**changes), DEFAULT_DENSITIES))

    def test_actual_and_theoretical_are_never_merged(self):
        observed = observe([row('a', weight_kg=1), row('b')]); r = build_analysis(observed, [], [], {})
        self.assertEqual(len(r['series']), 2)
        self.assertEqual({s['weight_source'] for s in r['series']}, {'actual', 'theoretical'})
        self.assertEqual(next(r for r in observed if r['id']=='a-0')['weight'], 1)

    def test_cost_excludes_processing_and_tax_without_guessing(self):
        r = row(price=125, qty=7, weight_kg=8.4, pricing_basis='weight', material_amount=1050, processing_fee=490, amount=1540)
        self.assertEqual(material_cost(r, {}, 'pretax'), (1050, ''))
        r['material_amount'] = None
        self.assertEqual(material_cost(r, {}, 'pretax'), (1050, ''))
        r['processing_fee'] = None
        self.assertIsNone(material_cost(r, {}, 'pretax')[0])
        self.assertIsNone(material_cost(row(), {}, 'unknown')[0])
        self.assertAlmostEqual(material_cost(row(price=10.5, amount=105, material_amount=105), {'tax_basis':'included', 'tax_rate':5}, 'unknown')[0], 100)
        self.assertIsNone(material_cost(row(price=11), {}, 'pretax')[0])

    def test_missing_zero_material_and_verified_sidecar(self):
        for amount,price in [(0,0),(None,None)]:
            r=observe([row(amount=amount, price=price, material_amount=amount, subtotal=amount, tax=0, document_total=amount)])[0]
            self.assertEqual(r['eligible'], amount == 0)
            self.assertEqual(r['material_cost'], amount)
        r=row(); r['material_amount']=None
        self.assertEqual(material_cost(r, {'fee_zero':True}, 'pretax')[0], 100)
        self.assertEqual(material_cost(r, {'material_cost':0}, 'unknown')[0], 0)

    def test_drafts_material_unknown_and_duplicate_whole_invoice(self):
        a=row(); b=row('b', doc=a['doc'], raw='different OCR text'); rows=[a,b,row('c',grade=''),row('d')]
        output=observe(rows,statuses={'d':'pending'})
        self.assertEqual(sum(r['eligible'] for r in output),1)
        canonical=next(r for r in output if r['eligible']);self.assertEqual(set(canonical['source_ids']),{'a','b'})
        self.assertTrue(any('重複' in r['reason'] for r in output))
        # Equal rows within one invoice are real lines and must not be dropped.
        a2=dict(a,id='a-1',position=1); same=observe([a,a2])
        self.assertEqual(len(same),2); self.assertFalse(any('重複' in r['reason'] for r in same))

    def test_note_invalidates_when_source_changes(self):
        r=row(); n={r['id']:{'fingerprint':fingerprint(r),'data':{'temper':'T6','material_cost':100}}}
        self.assertTrue(observe([r],n)[0]['eligible'])
        r['qty']=11
        o=observe([r],n)[0];self.assertTrue(o['stale']);self.assertFalse(o['eligible']);self.assertEqual(o['temper'],'')

    def test_fixed_spec_does_not_rotate_or_adjust_size_quantity_temper(self):
        rows=[row(),row('b',dims=[20,10,100]),row('c',qty=11),row('d',shape='round',dims=[10,100])]
        notes={r['id']:{'fingerprint':fingerprint(r),'data':{'temper':'T6','material_cost':100}} for r in rows}
        observed=observe(rows,notes)
        fixed=dict(grade='6061',temper='T6',shape='rect',dims=[10,20,100],qty=10,unit='件')
        r=build_analysis(observed,[],[],{'fixed':fixed})
        self.assertEqual([o['id'] for o in r['observations']],['a-0'])
        self.assertEqual(build_analysis(observed,[],[],{'fixed':dict(fixed,temper='T651')})['observations'],[])

    def test_mix_changes_raw_average_while_fixed_price_unchanged(self):
        rows=[]
        for month,large,small in [('01',900,100),('02',100,900)]:
            for spec,kg,unit in [('large',large,100),('small',small,140)]:
                rows.append(row(month+spec,date='2026-'+month+'-15',grade='6061',weight_kg=kg,price=unit,qty=kg,unit='公斤',material_amount=kg*unit,amount=kg*unit,subtotal=kg*unit,tax=0,document_total=kg*unit))
        values=build_analysis(observe(rows),[],[],{})['series'][0]['points']
        self.assertEqual([p['value'] for p in values],[104,136])

    def test_market_fx_units_gaps_frequency_and_common_baseline(self):
        prices=[dict(series='s',metal='aluminum',label='daily aluminium',source='test',period=d,frequency='daily',currency='USD',unit='tonne',value=v) for d,v in [('2026-01-10',2000),('2026-01-11',3000),('2026-02-10',4000)]]
        fx=[dict(source='cbc',period=d,frequency='daily',value=30) for d in ['2026-01-10','2026-02-10']]
        observed=observe([row(weight_kg=1)])
        r=build_analysis(observed,prices,fx,{})
        market=next(s for s in r['series'] if s['kind']=='market')
        self.assertEqual([p['value'] for p in market['points']],[60,120]);self.assertEqual(r['fx_gaps'],['2026-01-11']);self.assertEqual(r['baseline'],'2026-01')
        self.assertEqual(market['points'][0]['index'],100)
        monthly=[dict(prices[0],frequency='monthly',period='2026-01')]
        self.assertFalse(any(s['kind']=='market' for s in build_analysis(observed,monthly,fx,{'frequency':'daily'})['series']))
        # A future rate cannot fill yesterday's missing FX; monthly requires monthly FX.
        self.assertEqual(build_analysis([],monthly,fx,{})['series'],[])

    def test_zero_cannot_be_index_base_and_grades_and_kinds_separate(self):
        rows=observe([row(price=0,amount=0,material_amount=0,subtotal=0,tax=0,document_total=0)])
        result=build_analysis(rows,[],[],{});self.assertIsNone(result['baseline']);self.assertEqual(result['series'][0]['points'][0]['value'],0)
        quote=dict(row('q'),kind='quote',tax_basis='pretax',temper='T6',fee_zero=True)
        observed=observations([row()], [{'id':'a','status':'done'}], [quote], {}, DEFAULT_DENSITIES)
        self.assertEqual(len(build_analysis(observed,[],[],{'kind':'quote'})['observations']),1)


class ImportAdapterTests(unittest.TestCase):
    def test_quote_preview_is_atomic_duplicate_aware_and_does_not_infer_grade(self):
        suppliers={'hh':{'name':'示範鋁材一廠','short':'示範鋁材一廠'}}
        content=csv_output(QUOTE_COLUMNS,[['hh','2026-01-10','','Q','','','rect',10,20,100,10,'件','quantity',10,'',100,0,100,'pretax','',True,'']]).decode('utf-8-sig')
        preview=quote_csv_preview(content,suppliers,[]);self.assertEqual(preview['errors'],[]);self.assertEqual(preview['rows'][0]['grade'],'')
        q=dict(preview['rows'][0],kind='quote',id='x',created='today',void=False,attachments=[])
        again=quote_csv_preview(content,suppliers,[q]);self.assertEqual(again['duplicates'],1);self.assertEqual(again['rows'],[])
        for update in [dict(weight_kg=-1),dict(tax_basis='included',tax_rate=''),dict(processing_fee=-1),dict(qty=0)]:
            with self.assertRaises(ValueError):validate_quote(dict(q,**update),suppliers)

    def test_csv_sources_do_not_mix_contract_currency_frequency_or_units(self):
        good=['lme-cash','LME cash','manual','cash','daily','2026-01-10',2000,'USD','tonne','https://example.org']
        content=csv_output(MARKET_COLUMNS,[good,good]).decode('utf-8-sig')
        self.assertEqual(len(csv_preview('market',content,[])['errors']),1)
        for i,value in [(4,'weekly'),(8,'short-ton'),(7,'EUR'),(0,'wb-test')]:
            values=list(good);values[i]=value
            self.assertTrue(csv_preview('market',csv_output(MARKET_COLUMNS,[values]).decode(),[])['errors'])
        existing=csv_preview('market',csv_output(MARKET_COLUMNS,[good]).decode(),[])['rows']
        changed=list(good);changed[3]='three month'
        self.assertTrue(csv_preview('market',csv_output(MARKET_COLUMNS,[changed]).decode(),existing)['errors'])

    def test_cbc_strict_dates_monthly_and_daily(self):
        self.assertEqual(parse_cbc('[{"西元年月":"202601","NTD_USD":"31.5"}]','monthly')[0]['period'],'2026-01')
        self.assertEqual(parse_cbc('[{"日期":"20260105","NTD_USD":"31.5"}]','daily')[0]['period'],'2026-01-05')
        with self.assertRaises(ValueError):parse_cbc('[{"日期":"20260230","NTD_USD":"31.5"}]','daily')

    def test_worldbank_uses_named_sheet_and_aluminium_column(self):
        output=io.BytesIO()
        with zipfile.ZipFile(output,'w') as z:
            z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Monthly Prices" r:id="rId2"/></sheets></workbook>')
            z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>')
            z.writestr('xl/worksheets/sheet2.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="B4" t="inlineStr"><is><t>Aluminum</t></is></c></row><row><c r="B6" t="inlineStr"><is><t>($/mt)</t></is></c></row><row><c r="A7" t="inlineStr"><is><t>2026M01</t></is></c><c r="B7"><v>2000</v></c><c r="C7"><v>9999</v></c></row></sheetData></worksheet>')
        rows=parse_worldbank(output.getvalue(),'https://example.org');self.assertEqual(rows[0]['value'],2000);self.assertEqual(rows[0]['unit'],'tonne')


class AnalysisPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.store=Store(self.temp.name);self.a=self.store.analysis
        self.doc=self.store.import_bytes('test.jpg',b'fake-test-only',submit=False)['id']
        with self.store.connect() as db:db.execute("UPDATE documents SET status='pending' WHERE id=?",(self.doc,))
        self.store.confirm(self.doc,draft());self.original=self.store.records();self.export=csv_bytes(self.original,self.store.suppliers())
    def tearDown(self):self.store.executor.shutdown(wait=True);self.temp.cleanup()

    def test_notes_settings_import_do_not_rewrite_ledger_and_backup_includes_attachments(self):
        r=self.original[0];self.a.save_note(r['id'],dict(fingerprint=fingerprint(r),material_cost=36000,temper='T6'))
        q=self.a.add_quote(dict(row('q'),sup='hh',date='2026-01-10',tax_basis='pretax'))
        q=self.a.attach_quote(q['id'],'報價.pdf',b'%PDF-test')
        self.a.save_settings({'densities':{'6061':2.7,'7075':2.81}})
        with zipfile.ZipFile(io.BytesIO(self.store.backup())) as z:
            self.assertIn('data/quote-files/'+q['id']+'/'+q['attachments'][0]['file'],z.namelist())
            path=self.store.directory/'snapshot.sqlite3';path.write_bytes(z.read('data/ledger.sqlite3'))
            with sqlite3.connect(path) as db:self.assertEqual(db.execute('SELECT count(*) FROM analysis_notes').fetchone()[0],1)
        self.assertEqual(self.store.records(),self.original);self.assertEqual(csv_bytes(self.store.records(),self.store.suppliers()),self.export)
        with self.assertRaises(ValueError):self.a.save_note(r['id'],dict(fingerprint='stale',material_cost=1))
        self.a.void_quote(q['id']);self.assertFalse(next(r for r in self.a.query({'kind':'quote'})['observations'] if r['id']==q['id'])['eligible'])

    def test_import_duplicate_replay_and_no_partial_write(self):
        data=csv_output(MARKET_COLUMNS,[['daily','daily','manual','cash','daily','2026-01-10',2000,'USD','tonne','']]).decode()
        self.assertEqual(self.a.import_csv('market',data)['count'],1);self.assertEqual(self.a.import_csv('market',data)['count'],0)
        changed=data.replace('2000','2100');self.a.import_csv('market',changed,True);self.assertEqual(self.a.values('analysis_market')[0]['value'],2100)
        with self.assertRaises(ValueError):self.a.import_csv('market',data.replace('daily,2026','weekly,2026'))
        self.assertEqual(len(self.a.values('analysis_market')),1)

    def test_quote_request_replay_blank_zero_and_export_round_trip(self):
        data=dict(row('q'),date='2026-01-10',sup='hh',tax_basis='pretax',client_id='1'*32,price=None,amount=None,material_amount=None,processing_fee=None)
        quote=self.a.add_quote(data);self.assertEqual(self.a.add_quote(data)['id'],quote['id']);self.assertEqual(len(self.a.values('analysis_quotes')),1)
        with self.assertRaises(ValueError):self.a.add_quote(dict(data,price=99))
        zero=self.a.add_quote(dict(data,client_id='2'*32,price=0,material_amount=0,amount=0,processing_fee=0))
        self.assertIsNone(quote['price']);self.assertEqual(zero['processing_fee'],0)
        preview=self.a.import_preview('quotes',self.a.export('quotes').decode())
        self.assertEqual(preview['errors'],[]);self.assertEqual(preview['duplicates'],2)
        priced=self.a.add_quote(dict(data,client_id='3'*32,price=12,grade='7075'))
        observed=next(r for r in self.a.query({'kind':'quote'})['observations'] if r['id']==priced['id'])
        self.assertTrue(observed['eligible']);self.assertEqual(observed['material_cost'],120)

    def test_duplicate_line_items_with_conflicting_footer_count_once(self):
        a=row('a');b=row('b',doc=a['doc'],tax=91)
        observed=observe([a,b]);self.assertEqual(sum(r['eligible'] for r in observed),1)
        self.assertEqual(next(r for r in observed if r['eligible'])['document_id'],'a')
        self.assertEqual(set(next(r for r in observed if r['eligible'])['source_ids']),{'a','b'})

    def test_update_failure_retains_cache_and_successful_sources_commit(self):
        self.a.write_market('market',[dict(series='old',frequency='monthly',period='2026-01',value=100,currency='TWD',unit='kg',label='old',source='old',contract='cash')])
        with patch('analysis_store.fetch_worldbank',side_effect=OSError('offline')),patch('analysis_store.download',side_effect=OSError('offline')),patch('analysis_store.fetch_steel',side_effect=OSError('offline')):
            result=self.a.update_market();self.assertEqual(len(result['errors']),4);self.assertEqual(len(self.a.values('analysis_market')),1)



if __name__=='__main__':unittest.main()
