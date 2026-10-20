import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import urlencode
from urllib.request import urlopen
from urllib.error import HTTPError

from domain import material_catalog, search_materials, structured_query
from server import Store, Handler, ThreadingHTTPServer
from test_system import material, draft


class StructuredSearchTests(unittest.TestCase):
    def setUp(self):
        self.rows=[material('a1','hh',[8,17,81]),material('a2','hh',[10,20,100]),material('a3','hh',[9,18,85]),material('a4','hh',[12,20,100]),
                   material('s','sk',[8,18,82],grade='S50C'),material('u','sk',[8,18,82],grade='CUSTOM-9'),
                   material('b','zf',[70,107],grade=''),material('r','zm',[107,70],grade='')]
        for row in self.rows[-2:]:row['shape']='round'

    def test_same_results_as_legacy_and_all_permutations(self):
        legacy=search_materials(self.rows,'7x16x80 7075鋁')
        for dims in ['7,16,80','80,16,7','16,80,7']:
            new=search_materials(self.rows,filters=dict(shape='rect',dims=dims,grade='7075'))
            self.assertEqual(new['groups'],legacy['groups']);self.assertEqual(new['need'],legacy['need'])
            self.assertEqual(len(new['groups'][0]['items']),3)
        self.assertEqual(search_materials(self.rows,allowance=.5,filters=dict(dims='7,16,80',grade='7075'))['need'],[8,17,81])

    def test_round_dimensions_do_not_rotate_or_mix_shapes(self):
        result=search_materials(self.rows,filters=dict(shape='round',dims='70,107'))
        self.assertEqual([i['r']['id'] for g in result['groups'] for i in g['items']],['b'])
        self.assertEqual(search_materials(self.rows,allowance=.5,filters=dict(shape='round',dims='70,107'))['groups'],[])

    def test_exact_unknown_grade_and_missing_material(self):
        result=search_materials(self.rows,filters=dict(dims='7,16,80',grade=' custom-9 '))
        self.assertEqual(result['groups'][0]['items'][0]['r']['id'],'u')
        self.assertEqual(search_materials(self.rows,filters=dict(grade='CUSTOM'))['groups'],[])
        self.assertEqual(search_materials(self.rows,filters=dict(shape='round',grade='7075'))['groups'],[])
        missing=search_materials(self.rows,filters=dict(shape='round',missing_grade='1'))
        self.assertEqual(missing['total'],2)

    def test_metal_filters_do_not_infer_unknown_or_blank_grades(self):
        for metal,expected in [('aluminum',4),('steel',1),('other',1)]:
            self.assertEqual(search_materials(self.rows,filters=dict(metal=metal))['total'],expected)
        self.assertEqual(search_materials(self.rows,filters=dict(metal='steel',grade='CUSTOM-9'))['total'],0)
        self.assertEqual(search_materials(self.rows,filters=dict(shape='round',metal='other'))['total'],2)

    def test_catalog_deduplicates_sorts_and_classifies_only_observed_grades(self):
        catalog=material_catalog(self.rows+[material('lower','sk',[1,2,3],grade=' s50c ')])
        self.assertEqual([g['grade'] for g in catalog['grades']],['7075','CUSTOM-9','S50C'])
        self.assertEqual([g['count'] for g in catalog['grades']],[4,1,2])
        self.assertEqual(catalog['missing_count'],2)
        self.assertEqual([m['id'] for m in catalog['metals']],['aluminum','steel','other'])
        self.assertEqual(material_catalog([]),{'grades':[],'metals':[],'missing_count':0})

    def test_partial_invalid_or_nonfinite_dimensions_never_broaden_search(self):
        for values in ['7,16','7,,80','0,16,80','-1,16,80','NaN,16,80','Infinity,16,80','1e999,16,80']:
            with self.assertRaises(ValueError,msg=values):search_materials(self.rows,filters=dict(dims=values))
        for filters in [dict(shape='tube'),dict(metal='gold'),dict(missing_grade='yes'),dict(grade='7075',missing_grade='1')]:
            with self.assertRaises(ValueError):structured_query(filters)
        self.assertEqual(structured_query(dict(dims='7.5,16,80'))['dims'],[7.5,16,80])

    def test_no_dimensions_returns_latest_three_per_supplier(self):
        rows=copy.deepcopy(self.rows)
        rows[1]['date']='2026-05-01'
        matches=search_materials(rows,filters=dict(grade='7075'))['groups'][0]['items']
        self.assertEqual(matches[0]['r']['id'],'a2');self.assertEqual(len(matches),3)




if __name__=='__main__':unittest.main()
