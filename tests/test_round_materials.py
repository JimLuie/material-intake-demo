import copy
import csv
import io
import json
import math
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from domain import parse_ocr, parse_query, search_materials, validate_draft, default_units, SUPPLIERS
from server import Store, csv_bytes

FIXTURES = Path(__file__).parent/'fixtures'


def parsed(vendor):
    return parse_ocr(json.loads((FIXTURES/(vendor+'.json')).read_text()))


def record(identifier, supplier, dims, grade='', shape='round', date='2026-01-01'):
    return {'id': identifier, 'sup': supplier, 'dims': dims, 'grade': grade,
            'shape': shape, 'date': date, 'doc': 'ROUND'}


class RoundParsingTests(unittest.TestCase):
    def test_zhifu_real_ocr_and_quantity_footer(self):
        result = parsed('zf')
        self.assertEqual(result['meta'], {'sup':'zf','date':'2026-01-15','doc':'02601155103','subtotal':None,'tax':None,'total':None,'note':''})
        self.assertEqual(len(result['items']), 1)
        item = result['items'][0]
        for key, value in {'part_no':'DEMO-P301','dims':[66,124],'qty':192,'grade':'','price':None,'amount':None,'shape':'round','unit':'件','dim_unit':'mm'}.items():
            self.assertEqual(item[key], value, key)
        saved = validate_draft(result,SUPPLIERS)[0]
        self.assertIsNone(saved['total'])
        self.assertIsNone(saved['document_total'])

    def test_zongming_two_rows_and_totals(self):
        result = parsed('zm')
        self.assertEqual(result['meta']['doc'],'2601196104')
        self.assertEqual(result['meta']['date'],'2026-01-19')
        self.assertEqual([result['meta'][k] for k in ['subtotal','tax','total']],[10169.5,508,10677.5])
        self.assertEqual([(i['qty'],i['price'],i['amount']) for i in result['items']],[(101,59.5,6009.5),(52,80,4160)])
        self.assertEqual([i['dims'] for i in result['items']],[[98,39],[44,135]]);self.assertEqual([i['grade'] for i in result['items']],['6061','7075'])
        self.assertEqual(len(validate_draft(result,SUPPLIERS)),2)

    def test_multiple_pages_preserve_separate_rows(self):
        ocr=json.loads((FIXTURES/'zm.json').read_text())
        second=copy.deepcopy(ocr['pages'][0]);second['number']=2;ocr['pages'].append(second)
        result=parse_ocr(ocr)
        self.assertEqual([i['page'] for i in result['items']],[1,1,2,2])

    def test_product_code_does_not_supply_material_grade(self):
        data=parsed('zf');data['items'][0]['label']='7075-PART 圓條70';data['items'][0]['grade']=''
        self.assertEqual(validate_draft(data,SUPPLIERS)[0]['grade'],'')
        ocr=json.loads((FIXTURES/'zf.json').read_text())
        for line in ocr['pages'][0]['lines']:
            if '客供料 圓條' in line['text']:line['text']='7075-PART 圓條70'
        self.assertEqual(parse_ocr(ocr)['items'][0]['grade'],'')

    def test_explicit_ocr_units_and_grade_preserved(self):
        ocr=json.loads((FIXTURES/'zf.json').read_text())
        for line in ocr['pages'][0]['lines']:
            if '規格' in line['text']:line['text']='規格(cm)'
            if '客供料 圓條' in line['text']:line['text']='7075 圓條70'
            if line['text']=='PCS':line['text']='KG'
        item=parse_ocr(ocr)['items'][0]
        self.assertEqual((item['dim_unit'],item['unit'],item['grade']),('cm','公斤','7075'))
        steel=json.loads((FIXTURES/'sk.json').read_text())
        for line in steel['pages'][0]['lines']:
            if any(k in line['text'] for k in ['厚度','寬度','長度']):line['text']=line['text'].replace('mm','cm')+'(cm)'
        self.assertEqual(parse_ocr(steel)['items'][0]['dim_unit'],'cm')

    def test_defaults_do_not_overwrite_explicit_units(self):
        data={'items':[{'dim_unit':'','unit':''},{'dim_unit':'cm','unit':'公斤'},{'dim_unit':'inch','unit':'PCS'}]}
        result=default_units(data)
        self.assertEqual([(i['dim_unit'],i['unit']) for i in result['items']],[('mm','件'),('cm','公斤'),('inch','件')])
        self.assertEqual(data['items'][0]['unit'],'')

    def test_null_blank_and_zero_are_distinct(self):
        for empty in [None,'','  ']:
            data=parsed('zf');data['items'][0].update(price=empty,amount=empty)
            row=validate_draft(data,SUPPLIERS)[0]
            self.assertIsNone(row['price']);self.assertIsNone(row['amount'])
        data['items'][0].update(price=0,amount=0)
        row=validate_draft(data,SUPPLIERS)[0]
        self.assertEqual((row['price'],row['amount']),(0,0))

    def test_round_validation_and_conversion(self):
        data=parsed('zf');data['items'][0].update(dims=[7,10.7],dim_unit='cm')
        self.assertEqual(validate_draft(data,SUPPLIERS)[0]['dims'],[70,107])
        for key,value in [('dims',[70,70,107]),('dims',[0,107]),('dims',[70,-1]),('shape','unknown'),('price','NaN'),('amount',-1),('unit','unknown')]:
            bad=copy.deepcopy(data);bad['items'][0][key]=value
            with self.assertRaises(ValueError,msg=key):validate_draft(bad,SUPPLIERS)


class RoundSearchTests(unittest.TestCase):
    def test_query_formats_and_dimension_order(self):
        for query in ['Ø180×19','圓條180x19','圓棒180*19','ø180x19','Φ180x19']:
            q=parse_query(query)
            self.assertEqual(q['dims'],[180,19]);self.assertEqual(q['shape'],'round');self.assertEqual(q['error'],'')
        for query in ['70x107','Ø70x107x20','Ø70']:
            self.assertTrue(parse_query(query)['error'])

    def test_supplier_name_does_not_imply_material_and_new_document_numbers_work(self):
        row=record('a','zf',[70,107]);row['doc']='02601155103'
        self.assertEqual(search_materials([row],'示範鋁業三廠 Ø70×107')['total'],1)
        self.assertEqual(search_materials([row],'02601155103')['total'],1)
        row['doc']='2601196104'
        self.assertEqual(search_materials([row],'2601196104')['total'],1)

    def test_round_does_not_rotate_or_mix_shapes(self):
        rows=[record('ok','zf',[180,19]),record('reversed','zf',[19,180]),record('short','zf',[181,18]),record('rect','zf',[180,180,19],shape='rect')]
        res=search_materials(rows,'Ø180×19')
        self.assertEqual([m['r']['id'] for m in res['groups'][0]['items']],['ok'])
        res=search_materials(rows,'19x180x180')
        self.assertEqual([m['r']['id'] for m in res['groups'][0]['items']],['rect'])

    def test_three_per_supplier_and_volume_ranking(self):
        rows=[record(str(i),supplier,dims) for supplier in ['zf','zm'] for i,dims in enumerate([[80,108],[71,107],[70,120],[70,107],[70,106]])]
        rows.append(record('none','hh',[1,1]))
        res=search_materials(rows,'Ø70×107')
        self.assertEqual(len(res['groups']),2)
        for group in res['groups']:
            self.assertEqual([m['r']['dims'] for m in group['items']],[[70,107],[71,107],[70,120]])
            self.assertEqual(group['count'],4)
            self.assertAlmostEqual(group['items'][1]['util'],70**2/71**2)

    def test_unknown_material_excluded_when_grade_or_family_requested(self):
        rows=[record('empty','zf',[70,107]),record('known','zf',[70,107],grade='7075')]
        self.assertEqual(search_materials(rows,'Ø70×107')['total'],2)
        for query in ['Ø70×107 7075鋁','Ø70×107 鋁']:
            self.assertEqual([m['r']['id'] for m in search_materials(rows,query)['groups'][0]['items']],['known'])

    def test_allowance_and_date_tie_break(self):
        rows=[record('a','zf',[71,108]),record('b','zf',[71,108],date='2026-02-01'),record('too-short','zf',[71,107])]
        res=search_materials(rows,'Ø70×107',.5)
        self.assertEqual(res['need'],[71,108])
        self.assertEqual([m['r']['id'] for m in res['groups'][0]['items']],['b','a'])


class RoundPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.store=Store(self.temp.name)
        self.identifier=self.store.import_bytes('test.jpg',b'fixture',submit=False)['id']
        with self.store.connect() as db:db.execute("UPDATE documents SET status='pending' WHERE id=?",(self.identifier,))

    def tearDown(self):
        self.store.executor.shutdown(wait=True);self.temp.cleanup()

    def test_blank_material_prices_persist_and_export_without_column_shift(self):
        data=parsed('zf');self.store.confirm(self.identifier,data)
        second=Store(self.temp.name)
        try:
            row=second.records()[0]
            self.assertEqual(row['grade'],'');self.assertIsNone(row['price']);self.assertIsNone(row['amount'])
            table=list(csv.DictReader(io.StringIO(csv_bytes(second.records(),second.suppliers()).decode('utf-8-sig'))))
            self.assertEqual(table[0]['牌號'],'');self.assertEqual(table[0]['單價(TWD)'],'')
            self.assertEqual(table[0]['數量'],'192.0');self.assertEqual(table[0]['形狀'],'圓條')
            self.assertEqual(table[0]['尺寸1(mm)'],'');self.assertEqual(table[0]['尺寸3(mm)'],'')
            self.assertEqual((table[0]['直徑(mm)'],table[0]['長度(mm)']),('66.0','124.0'))
            self.assertNotIn(None,table[0])
        finally:second.executor.shutdown(wait=True)

    def test_old_pending_defaults_upgrade_once_and_confirmed_is_untouched(self):
        pending=parsed('zf');pending['items'][0].update(dim_unit='',unit='',note='人工備註')
        confirmed=self.store.import_bytes('confirmed.jpg',b'confirmed',submit=False)['id']
        with self.store.connect() as db:
            db.execute("DELETE FROM settings WHERE key='upgrade:units-v2'")
            db.execute('UPDATE documents SET draft=? WHERE id=?',(json.dumps(pending),self.identifier))
            db.execute("UPDATE documents SET status='done',draft=? WHERE id=?",(json.dumps(pending),confirmed))
        self.store.upgrade_units()
        item=self.store.document(self.identifier)['draft']['items'][0]
        self.assertEqual((item['dim_unit'],item['unit'],item['note']),('mm','件','人工備註'))
        self.assertEqual(self.store.document(confirmed)['draft']['items'][0]['unit'],'')
        backup=Path(self.temp.name)/'upgrade-backups/before-units-v2.sqlite3'
        with sqlite3.connect(backup) as db:
            old=json.loads(db.execute('SELECT draft FROM documents WHERE id=?',(self.identifier,)).fetchone()[0])
            self.assertEqual(old['items'][0]['unit'],'')
        snapshot=self.store.document(self.identifier)['draft'];self.store.upgrade_units()
        self.assertEqual(self.store.document(self.identifier)['draft'],snapshot)

    def test_retry_requires_confirmation_and_preserves_confirmed_rows(self):
        with self.assertRaises(ValueError):self.store.retry(self.identifier)
        with patch.object(self.store.executor,'submit') as submit:
            self.store.retry(self.identifier,replace=True)
            self.assertEqual(self.store.document(self.identifier)['status'],'queued')
            submit.assert_called_once()
        with self.store.connect() as db:db.execute("UPDATE documents SET status='pending' WHERE id=?",(self.identifier,))
        self.store.confirm(self.identifier,parsed('zf'))
        with self.assertRaises(ValueError):self.store.retry(self.identifier,True)
        self.assertEqual(len(self.store.records()),1)


if __name__=='__main__':unittest.main()
