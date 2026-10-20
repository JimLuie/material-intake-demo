import copy
import csv
import io
import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

from analysis import DEFAULT_DENSITIES, observations, build_analysis, fingerprint
from server import Store, Handler, ThreadingHTTPServer
from test_analysis import row
from test_system import draft


def observe(rows, tempers=None):
    docs = [dict(id=r['document_id'], status='done') for r in rows]
    notes = {r['id']: dict(fingerprint=fingerprint(r), data={'temper': tempers[r['document_id']]}) for r in rows if tempers and tempers.get(r['document_id'])}
    return observations(rows, docs, [], notes, DEFAULT_DENSITIES, 'original')


def fixture():
    def source(identifier, qty, unit, weight):
        return row(identifier, qty=qty, unit=unit, weight_kg=weight, amount=qty*10, material_amount=qty*10, subtotal=qty*10, tax=0, document_total=qty*10)
    return observe([source('a', 10, '件', 2), source('b', 20, '件', 4), source('c', 15, '支', 3),
                    source('d', 2.5, '公斤', 2.5), source('e', 10, '組', None), source('f', 10, '件', None), source('h', 5.5, '件', 2.2)],
                   {'a':'T6', 'b':'退火', 'd':'T6', 'f':'T6', 'h':'T6'})


def query(obs, **filters):
    return build_analysis(obs, [], [], dict(price_basis='original', **filters))


def ids(result): return [r['id'] for r in result['observations']]


class ProcurementFilterTests(unittest.TestCase):
    def setUp(self): self.obs = fixture()

    def test_omitted_blank_conditions_and_unit_without_range_keep_legacy_selection(self):
        baseline = query(self.obs)
        for filters in [dict(qty_unit='組'), dict(qty_unit=['ignored']), dict(qty_min='', qty_max=None, piece_weight_min=' ', piece_weight_max='', temper='', temper_missing=False)]:
            self.assertEqual(query(self.obs, **filters), baseline)

    def test_quantity_one_sided_decimal_and_inclusive_bounds_use_only_selected_unit(self):
        for filters, expected in [(dict(qty_min=10), ['a-0','b-0','f-0']), (dict(qty_max=10), ['a-0','f-0','h-0']),
                                  (dict(qty_min='5.5', qty_max='10'), ['a-0','f-0','h-0']), (dict(qty_min=10,qty_max=10), ['a-0','f-0']),
                                  (dict(qty_min=10,qty_unit='支'), ['c-0']), (dict(qty_max=3,qty_unit='公斤'), ['d-0'])]:
            with self.subTest(filters=filters): self.assertEqual(ids(query(self.obs, **filters)), expected)

    def test_invalid_ranges_fail_closed_even_when_no_rows_match(self):
        for key in ['qty_min','qty_max','piece_weight_min','piece_weight_max']:
            for value in [0, -1, 'abc', 'NaN', 'Infinity', '-Infinity', float('nan'), float('inf'), True, {}, []]:
                with self.subTest(key=key,value=value), self.assertRaisesRegex(ValueError, '有限正數'):
                    query([], **{key:value})
        for prefix in ['qty','piece_weight']:
            with self.assertRaisesRegex(ValueError, '最小值不得大於最大值'): query(self.obs, **{prefix+'_min':2,prefix+'_max':1})
        with self.assertRaises(ValueError): query(self.obs, qty_min=1, qty_unit=0)
        with self.assertRaises(ValueError): query(self.obs, temper_missing=True, temper='T6')

    def test_piece_weight_is_existing_per_piece_result_not_batch_weight(self):
        before = copy.deepcopy(self.obs)
        result = query(self.obs, piece_weight_min=.2, piece_weight_max=.2)
        self.assertEqual(ids(result), ['a-0','b-0','c-0'])
        self.assertEqual(result['filter_counts']['missing_piece_weight'], 3)
        self.assertEqual(query(self.obs, piece_weight_min=1)['observations'], [])
        self.assertEqual(query(self.obs, piece_weight_max=.1)['observations'][0]['id'], 'f-0')
        self.assertEqual(self.obs, before)

    def test_theoretical_boundary_and_actual_provenance_are_preserved(self):
        result = query(self.obs, piece_weight_min=.0542, piece_weight_max=.0542)
        self.assertEqual(ids(result), ['f-0']); self.assertEqual(result['observations'][0]['weight_source'], 'theoretical')
        self.assertEqual(ids(query(self.obs, piece_weight_min=.0542000001, piece_weight_max=.1)), [])
        self.assertEqual(ids(query(self.obs, weight_source='actual', piece_weight_max=.2)), ['a-0','b-0','c-0'])

    def test_missing_piece_count_is_after_other_conditions_and_only_when_range_active(self):
        self.assertEqual(query(self.obs)['filter_counts']['missing_piece_weight'], 0)
        result = query(self.obs, qty_min=1, qty_unit='件', temper='T6', piece_weight_min=.001)
        self.assertEqual(ids(result), ['a-0','f-0']);self.assertEqual(result['filter_counts']['missing_piece_weight'], 1)

    def test_supply_state_exact_or_unlisted_and_options_are_from_data_not_selected_range(self):
        self.assertEqual(ids(query(self.obs, temper_missing=True)), ['c-0','e-0'])
        self.assertEqual(ids(query(self.obs, temper='T6')), ['a-0','d-0','f-0','h-0'])
        self.assertEqual(ids(query(self.obs, temper='T651')), [])
        result = query(self.obs, qty_min=999, temper='T6')
        self.assertEqual(result['filter_options']['tempers'], ['T6','退火'])
        self.assertEqual(set(result['filter_options']['quantity_units']), {'件','公斤','支','組'})
        self.assertEqual(result['observations'], [])

    def test_existing_filters_and_fixed_spec_remain_exact_and_intersect_new_conditions(self):
        fixed = dict(grade='6061',temper='T6',shape='rect',dims=[10,20,100],qty=10,unit='件')
        filters = dict(grade='6061',metal='aluminum',sup='hh',shape='rect',start='2026-01-01',end='2026-01-31',qty_min=10,qty_max=10,piece_weight_min=.1,temper='T6')
        self.assertEqual(ids(query(self.obs, fixed=fixed, **filters)), ['a-0'])
        for change in [dict(sup='sk'),dict(start='2026-02-01',end='2026-03-01'),dict(temper_missing=True,temper=''),dict(shape='round')]:
            self.assertEqual(ids(query(self.obs, fixed=fixed, **dict(filters,**change))), [])
        self.assertEqual(ids(query(self.obs, fixed=dict(fixed,dims=[100,20,10]))), [])
        with self.assertRaises(ValueError): query(self.obs, fixed=dict(fixed,temper=''),temper_missing=True)

    def test_international_window_frequency_fx_and_gaps_ignore_procurement_conditions(self):
        obs = observe([row('a',grade='S50C',date='2026-01-10',weight_kg=2),row('b',grade='S50C',date='2026-03-10',qty=20,price=5,weight_kg=4)], {'a':'退火'})
        prices = [dict(series='sb-china-hrb',label='Steel',source='fixture',frequency='daily',period=d,value=400,currency='USD',unit='tonne') for d in ['2026-01-10','2026-02-10','2026-03-10']]
        rates = [dict(source='cbc',frequency='daily',period=d,value=30) for d in ['2026-01-10','2026-03-10']]
        for frequency in ['monthly','weekly','daily']:
            base = dict(metal='steel',price_basis='original',frequency=frequency)
            baseline = build_analysis(obs,prices,rates,base)
            for condition in [dict(qty_min=999),dict(piece_weight_min=999),dict(temper='退火'),dict(temper_missing=True)]:
                result=build_analysis(obs,prices,rates,dict(base,**condition))
                self.assertEqual([s for s in result['series'] if s['kind']=='market'],[s for s in baseline['series'] if s['kind']=='market'])
                self.assertEqual(result['fx_gaps'],baseline['fx_gaps'])


