"""S50C, separate price bases and explicit benchmark classification regressions."""
import copy
import csv
import io
import json
import math
import unittest

from analysis import (DEFAULT_DENSITIES, S50C_DENSITY_URL, observations, build_analysis,
                      original_price_cost, theoretical_weight, csv_output, fingerprint)
from market_data import MARKET_COLUMNS, csv_preview
import test_analysis as fixtures

row = fixtures.row


def observed(rows, mode='original', notes=None):
    docs = [{'id': r['document_id'], 'status': 'done'} for r in rows]
    return observations(rows, docs, [], notes or {}, DEFAULT_DENSITIES, mode)


def steel(identifier='a', **values):
    return row(identifier, **dict({'grade':'S50C', 'label':'S50C', 'material_amount':None,
                                  'subtotal':None, 'tax':None, 'document_total':None}, **values))


class S50CMathTests(unittest.TestCase):
    def test_s50c_density_rect_round_and_actual_weight_priority(self):
        self.assertEqual(theoretical_weight(steel(), DEFAULT_DENSITIES), 1.57)
        r = steel(shape='round', dims=[70, 107], qty=240)
        self.assertAlmostEqual(theoretical_weight(r, DEFAULT_DENSITIES), math.pi*70**2*107/4*240*7.85/1e6)
        o = observed([steel(weight_kg=2)])[0]
        self.assertEqual((o['weight'], o['weight_source']), (2, 'actual'))

    def test_original_quantity_formula_blank_fee_is_never_modified(self):
        r = steel(); before = copy.deepcopy(r); o = observed([r])[0]
        self.assertTrue(o['eligible']); self.assertIsNone(o['material_cost'])
        self.assertEqual(o['analysis_cost'], 100); self.assertAlmostEqual(o['unit_kg'], 100/1.57)
        self.assertEqual(o['tax_status'], 'unknown'); self.assertEqual(r, before)
        self.assertIsNone(o['processing_fee']); self.assertEqual(o['price_basis'], 'original')

    def test_original_weight_formula_excludes_processing_fee(self):
        r = steel(qty=7, weight_kg=8.4, pricing_basis='weight', price=125,
                  processing_fee=490, material_amount=1050, amount=1540)
        o = observed([r])[0]
        self.assertTrue(o['eligible']); self.assertEqual(o['analysis_cost'], 1050)
        self.assertEqual(o['unit_kg'], 125); self.assertEqual(o['qty'], 7)

    def test_blank_and_explicit_zero_fee_price_and_tolerance(self):
        for fee in [None, 0]:
            o = observed([steel(price=0, amount=0, processing_fee=fee)])[0]
            self.assertTrue(o['eligible']); self.assertEqual(o['unit_kg'], 0)
            self.assertIs(o['processing_fee'], fee)
        self.assertEqual(original_price_cost(steel(amount=100.02)), (100, ''))
        self.assertIsNone(original_price_cost(steel(amount=100.03))[0])
        self.assertIsNone(original_price_cost(steel(price=None))[0])

    def test_invalid_data_and_both_arithmetic_mismatches_excluded(self):
        changes = [dict(dims=[0, 20, 100], weight_kg=1), dict(dims=[10, 20], weight_kg=1),
                   dict(weight_kg=0), dict(weight_kg=-1), dict(weight_kg='bad'), dict(qty=0),
                   dict(qty=1.5), dict(price=-1), dict(processing_fee=-1),
                   dict(material_amount=99), dict(amount=490), dict(price='NaN'),
                   dict(pricing_basis='weight', weight_kg=None)]
        for change in changes:
            with self.subTest(change=change): self.assertFalse(observed([steel(**change)])[0]['eligible'])

    def test_legacy_default_keeps_strict_net_material_rule(self):
        r = steel()
        self.assertTrue(observed([r])[0]['eligible'])
        self.assertFalse(observed([r], 'material')[0]['eligible'])
        strict = steel(material_amount=100, processing_fee=0, subtotal=100, tax=5, document_total=105)
        self.assertTrue(observed([strict], 'material')[0]['eligible'])

    def test_tax_status_and_different_included_rates_are_separate_series(self):
        rows = [steel(x, weight_kg=1) for x in 'abcd']
        notes = {r['id']: {'fingerprint': fingerprint(r), 'data': {'tax_basis': basis, 'tax_rate': rate}}
                 for r, (basis, rate) in zip(rows, [('unknown', None), ('pretax', None), ('included', 5), ('included', 10)])}
        obs = observed(rows, notes=notes)
        r = build_analysis(obs, [], [], {'metal': 'steel', 'price_basis': 'original'})
        self.assertEqual(len(r['series']), 4)
        self.assertEqual({s['tax_status'] for s in r['series']}, {'unknown', 'pretax', 'included:5.0', 'included:10.0'})
        self.assertEqual({s['points'][0]['value'] for s in r['series']}, {100})

    def test_weighted_monthly_and_duplicates_keep_one_invoice(self):
        rows = [steel('a', weight_kg=1), steel('b', weight_kg=3, price=20, amount=200),
                steel('c', doc='Na', weight_kg=1)]
        r = build_analysis(observed(rows), [], [], {'metal': 'steel', 'price_basis': 'original'})
        self.assertEqual(r['counts'], {'selected': 3, 'eligible': 2, 'excluded': 1})
        p = r['series'][0]['points'][0]
        self.assertEqual((p['value'], p['weight'], p['count']), (75, 4, 2))

    def test_steel_no_aluminium_or_unclassified_benchmark_fallback(self):
        prices = [dict(series=s, metal=m, label=s, source='manual', contract='cash', frequency='monthly',
                       period='2026-01', currency='TWD', unit='kg', value=20) for s, m in [('wb-aluminium', 'aluminum'), ('old', '')]]
        r = build_analysis(observed([steel()]), prices, [], {'metal': 'steel', 'price_basis': 'original'})
        self.assertEqual(r['market_series'], ''); self.assertEqual(len(r['series']), 1)
        for source in ['old', 'wb-aluminium']:
            with self.assertRaises(ValueError): build_analysis([], prices, [], {'metal': 'steel', 'market': source})

    def test_steel_csv_benchmark_and_common_index(self):
        p = dict(series='steel-local', metal='steel', label='Steel', source='manual', contract='cash',
                 region='Taiwan', frequency='monthly', period='2026-01', value=20000, currency='TWD', unit='tonne')
        r = build_analysis(observed([steel()]), [p], [], {'metal': 'steel', 'price_basis': 'original'})
        self.assertEqual(r['baseline'], '2026-01')
        market = next(s for s in r['series'] if s['kind'] == 'market')
        self.assertEqual((market['metal'], market['region'], market['points'][0]['value']), ('steel', 'Taiwan', 20))
        self.assertEqual({s['points'][0]['index'] for s in r['series']}, {100})

    def test_missing_heat_condition_cannot_form_fixed_spec(self):
        with self.assertRaises(ValueError):
            build_analysis(observed([steel()]), [], [], {'fixed': dict(grade='S50C', temper='', shape='rect', dims=[10,20,100], qty=10)})

    def test_csv_optional_metal_region_and_old_template_compatible(self):
        values = ['steel', 'Steel', 'manual', 'spot', 'monthly', '2026-01', 20000, 'TWD', 'tonne', '', 'steel', 'Taiwan']
        content = csv_output(MARKET_COLUMNS, [values]).decode()
        result = csv_preview('market', content, [])
        self.assertEqual(result['errors'], []); self.assertEqual(result['rows'][0]['region'], 'Taiwan')
        old = csv_preview('market', csv_output(MARKET_COLUMNS[:10], [values[:10]]).decode(), [])
        self.assertEqual(old['errors'], []); self.assertEqual(old['rows'][0]['metal'], '')
        self.assertTrue(csv_preview('market', content.replace(',steel,Taiwan', ',iron,Taiwan'), [])['errors'])


class S50CPersistenceTests(unittest.TestCase):
    setUp = fixtures.AnalysisPersistenceTests.setUp
    tearDown = fixtures.AnalysisPersistenceTests.tearDown
    def test_lazy_density_merge_preserves_custom_aluminium_and_source(self):
        legacy = {'densities': {'6061': 2.69, '7075': 2.83}, 'density_source': 'https://example.org/custom'}
        with self.store.connect() as db:
            db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)', ('analysis:settings', json.dumps(legacy)))
        settings = self.a.settings()
        self.assertEqual(settings['densities'], {'6061': 2.69, '7075': 2.83, 'S50C': 7.85})
        self.assertEqual(settings['density_sources']['6061'], legacy['density_source'])
        self.assertEqual(settings['density_sources']['S50C'], S50C_DENSITY_URL)
        with self.store.connect() as db:
            self.assertEqual(json.loads(db.execute("SELECT value FROM settings WHERE key='analysis:settings'").fetchone()[0]), legacy)
        changed = self.a.save_settings({'densities': {'S50C': 7.86}, 'density_sources': {'S50C': 'https://example.org/steel'}})
        self.assertEqual(changed['densities']['6061'], 2.69)
        self.a.save_settings({'densities': {'6061': 2.7, '7075': 2.8}})
        self.assertEqual(self.a.settings()['densities']['S50C'], 7.86)
        self.assertEqual(self.store.records(), self.original)

    def test_existing_unclassified_source_requires_explicit_classification(self):
        p = dict(series='old', label='steel', source='manual', contract='cash', frequency='monthly',
                 period='2026-01', value=20, currency='TWD', unit='kg')
        self.a.write_market('market', [p])
        self.assertEqual(self.a.query({'metal': 'steel'})['market_series'], '')
        self.a.classify_market('old', 'steel')
        self.assertEqual(self.a.query({'metal': 'steel'})['market_series'], 'old')
        self.assertEqual(self.a.values('analysis_market')[0].get('metal'), None)
        with self.assertRaises(ValueError): self.a.classify_market('old', 'iron')
        self.assertEqual(self.store.records(), self.original)

    def test_analysis_export_appends_basis_and_does_not_relabel_unknown_net_cost(self):
        q = self.a.add_quote(dict(row('q'), sup='hh', tax_basis='unknown', material_amount=None, processing_fee=None))
        data = list(csv.reader(io.StringIO(self.a.export('analysis', {'kind':'quote', 'price_basis':'original'}).decode('utf-8-sig'))))
        self.assertEqual(data[0][17:20], ['價格口徑', '稅別狀態', '原單單價換算(TWD/kg)'])
        self.assertEqual(data[1][12], ''); self.assertEqual(data[1][17:19], ['original', 'unknown'])
        self.assertNotEqual(data[1][19], '')
        self.assertEqual(self.store.records(), self.original)


if __name__ == '__main__': unittest.main()
