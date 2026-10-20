from contextlib import closing
import copy
import io
import itertools
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import zipfile

from domain import parse_ocr, search_materials, validate_draft, SUPPLIERS
from server import Store, Handler, ThreadingHTTPServer, csv_bytes

FIXTURES = Path(__file__).parent/"fixtures"


def draft(vendor="hh"):
    result = parse_ocr(json.loads((FIXTURES/(vendor+".json")).read_text()))
    result['items']=result['items'][:1]
    amount=result['items'][0].get('amount')
    if amount is not None:
        result['meta'].update(subtotal=amount,tax=143,total=amount+143)
    for item in result["items"]:
        item["dim_unit"] = "mm"
        item["unit"] = "件"
    return result


def material(identifier, supplier, dims, grade="7075", date="2026-01-01"):
    return {"id": identifier, "sup": supplier, "dims": dims, "grade": grade,
            "date": date, "doc": "D1", "price": 20, "unit": "件"}




class SearchTests(unittest.TestCase):
    def setUp(self):
        self.rows=[material('a1','hh',[8,17,81]),material('a2','hh',[10,20,100]),material('a3','hh',[9,18,85]),material('a4','hh',[12,20,100]),
                   material('b1','sk',[8,18,82]),material('b2','sk',[7,16,80]),material('c1','empty',[6,50,200]),material('wrong','sk',[7,16,80],grade='6061')]

    def test_three_per_supplier_and_no_empty_suppliers(self):
        result=search_materials(self.rows,'7x16x80 7075鋁')
        self.assertEqual([(g['sup'],len(g['items'])) for g in result['groups']],[('hh',3),('sk',2)])
        self.assertEqual([m['r']['id'] for m in result['groups'][0]['items']],['a1','a3','a2'])
        self.assertEqual(result['total'],6)

    def test_all_six_permutations(self):
        answers=[]
        for permutation in itertools.permutations([7,16,80]):
            result=search_materials(self.rows,'x'.join(map(str,permutation))+' 7075鋁')
            answers.append([[m['r']['id'] for m in g['items']] for g in result['groups']])
        self.assertTrue(all(a==answers[0] for a in answers))

    def test_exact_dimensions_allowed(self):
        result=search_materials(self.rows,'7×16×80 7075鋁')
        self.assertEqual(result['groups'][1]['items'][0]['r']['id'],'b2')

    def test_one_short_edge_excluded(self):
        result=search_materials([material('short','hh',[6,100,1000])],'7x16x80 7075')
        self.assertEqual(result['groups'],[])

    def test_allowance_applies_to_both_sides(self):
        result=search_materials(self.rows,'7x16x80 7075',.5)
        self.assertEqual(result['need'],[8,17,81])
        self.assertNotIn('b2',[m['r']['id'] for g in result['groups'] for m in g['items']])

    def test_unknown_grade_does_not_broaden_to_aluminum(self):
        self.assertEqual(search_materials(self.rows,'7x16x80 7050鋁')['groups'],[])

    def test_fullwidth_and_decimal(self):
        self.assertEqual(len(search_materials(self.rows,'７．０×１６×８０　７０７５鋁')['groups']),2)

    def test_incomplete_or_negative_dimensions(self):
        for q in ['7x16 7075','-7x16x80 7075','0x16x80 7075']:
            result=search_materials(self.rows,q)
            self.assertTrue(result['query']['error'])
            self.assertEqual(result['groups'],[])

    def test_tie_break_by_dimension_difference(self):
        rows=[material('A','hh',[8,20,100]),material('B','hh',[10,20,80])]
        result=search_materials(rows,'7x16x80 7075')
        self.assertEqual(result['groups'][0]['items'][0]['r']['id'],'B')

    def test_unknown_material_can_be_saved_and_searched(self):
        self.assertEqual(search_materials([material('x','hh',[8,17,81],'7050')],'7x16x80 7050鋁')['groups'][0]['items'][0]['r']['id'],'x')


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(self.temp.name)
        self.identifier=self.store.import_bytes('order.jpg',b'fake test file',submit=False)['id']
        with self.store.connect() as db:db.execute("UPDATE documents SET status='pending' WHERE id=?",(self.identifier,))

    def tearDown(self):
        self.store.executor.shutdown(wait=True)
        self.temp.cleanup()

    def test_deduplicate_even_renamed(self):
        result=self.store.import_bytes('renamed.jpg',b'fake test file',submit=False)
        self.assertTrue(result['duplicate']);self.assertEqual(result['id'],self.identifier)
        self.assertEqual(len(self.store.state()['documents']),1)

    def test_draft_not_in_search_until_confirmed(self):
        self.store.save_draft(self.identifier,draft())
        self.assertEqual(self.store.records(),[])
        self.store.confirm(self.identifier,draft())
        self.assertEqual(len(self.store.records()),1)

    def test_persist_across_store_restart(self):
        self.store.confirm(self.identifier,draft())
        second=Store(self.temp.name)
        try:
            self.assertEqual(second.records()[0]['amount'],2850)
            self.assertEqual(second.document(self.identifier)['status'],'done')
        finally:second.executor.shutdown(wait=True)

    def test_confirmation_idempotent_and_multiline(self):
        data=draft();data['items'].append(copy.deepcopy(data['items'][0]))
        self.store.confirm(self.identifier,data);self.store.confirm(self.identifier,data)
        self.assertEqual(len(self.store.records()),2)
        self.assertEqual(sum(r['total'] for r in self.store.records()),5700)
        self.assertTrue(all(r['document_total']==2993 for r in self.store.records()))

    def test_record_positions_are_exposed_without_changing_saved_json_or_exports(self):
        source = draft()
        source['items'].append(copy.deepcopy(source['items'][0]))
        self.store.confirm(self.identifier, source)
        rows = self.store.records()
        self.assertEqual(sorted(r['position'] for r in rows), [0, 1])
        self.assertTrue(all(r['document_id'] == self.identifier for r in rows))
        with self.store.connect() as db:
            self.assertTrue(all('position' not in json.loads(r['data']) for r in db.execute('SELECT data FROM records')))
        exported = csv_bytes(rows, self.store.suppliers()).decode('utf-8-sig')
        self.assertNotIn('position', exported.splitlines()[0])

    def test_invalid_second_line_does_not_change_confirmed_records(self):
        self.store.confirm(self.identifier,draft())
        bad=draft();bad['items'].append(copy.deepcopy(bad['items'][0]));bad['items'][1]['qty']=''
        with self.assertRaises(ValueError):self.store.confirm(self.identifier,bad)
        self.assertEqual(len(self.store.records()),1)

    def test_units_defaulted_and_converted(self):
        data=draft();data['items'][0]['dim_unit']=''
        self.store.confirm(self.identifier,data)
        self.assertEqual(self.store.records()[0]['dim_unit'],'mm')
        data['items'][0]['dim_unit']='cm';data['items'][0]['dims']=[.8,1.7,8.1]
        self.store.confirm(self.identifier,data)
        self.assertEqual(self.store.records()[0]['dims'],[8,17,81])
        data['items'][0]['unit']=''
        self.store.confirm(self.identifier,data)
        self.assertEqual(self.store.records()[0]['unit'],'件')

    def test_nan_rejected_and_zero_price_allowed(self):
        data=draft();data['items'][0]['price']='NaN'
        with self.assertRaises(ValueError):self.store.confirm(self.identifier,data)
        data['items'][0]['price']=0
        self.store.confirm(self.identifier,data)

    def test_backup_contains_consistent_db_and_original(self):
        self.store.confirm(self.identifier,draft())
        backup=self.store.backup()
        with zipfile.ZipFile(io.BytesIO(backup)) as z:
            self.assertEqual(z.read(f'data/files/{self.identifier}/original.jpg'),b'fake test file')
            target=Path(self.temp.name)/'backup.sqlite3';target.write_bytes(z.read('data/ledger.sqlite3'))
            with closing(sqlite3.connect(target)) as db:self.assertEqual(db.execute('SELECT count(*) FROM records').fetchone()[0],1)

    def test_csv_excel_formula_protection(self):
        data=draft();data['items'][0]['note']='=HYPERLINK("http://example.invalid")'
        self.store.confirm(self.identifier,data)
        exported=csv_bytes(self.store.records(),self.store.suppliers()).decode('utf-8-sig')
        self.assertIn("'=HYPERLINK",exported)

    def test_add_supplier_and_confirm(self):
        key=self.store.add_supplier('測試供應商有限公司')
        self.assertEqual(self.store.add_supplier('測試供應商有限公司'),key)
        data=draft();data['meta']['sup']=key;self.store.confirm(self.identifier,data)
        self.assertEqual(self.store.records()[0]['sup'],key)




if __name__=='__main__':unittest.main()
