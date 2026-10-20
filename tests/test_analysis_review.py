import copy
import unittest

from analysis import DEFAULT_DENSITIES, observations, build_analysis, fingerprint
from test_analysis import row


def observed(rows, notes=None, basis='original'):
    docs = [dict(id=i, status='done', created=i) for i in dict.fromkeys(r['document_id'] for r in rows)]
    return observations(rows, docs, [], notes or {}, DEFAULT_DENSITIES, basis)


class AnalysisReviewTests(unittest.TestCase):
    def test_primary_reason_counts_once_and_preserves_every_diagnostic(self):
        rows = [row('amount', amount=999), row('weight', unit='組', price=None), row('price', price=None), row('good')]
        before = copy.deepcopy(rows)
        obs = observed(rows)
        self.assertEqual([r['primary_issue']['code'] if r['primary_issue'] else None for r in obs], ['amount_mismatch', 'missing_weight', 'missing_price', None])
        self.assertGreater(len(obs[1]['issues']), 1)
        self.assertEqual(obs[1]['reason'], obs[1]['primary_issue']['message'])
        result = build_analysis(obs, [], [], {'price_basis': 'original'})
        self.assertEqual(result['review']['needs_review'], 3)
        self.assertEqual(sum(c['count'] for c in result['review']['categories']), 3)
        self.assertEqual(result['review']['all'], sum(result['review'][s] for s in ['needs_review', 'included', 'duplicate']))
        self.assertEqual(rows, before)

    def test_duplicate_invoice_is_separate_even_when_it_has_errors_and_same_number_is_not_identity(self):
        rows = [row('a', doc='SAME', amount=999), row('b', doc='SAME', amount=999), row('c', doc='SAME', amount=888)]
        # Equal lines in the same invoice are still two distinct positions.
        rows += [dict(rows[2], id='c-1', position=1)]
        obs = observed(rows)
        result = build_analysis(obs, [], [], {'price_basis': 'original'})
        self.assertEqual(result['review']['duplicate'], 1)
        self.assertEqual(result['review']['needs_review'], 3)
        self.assertEqual(obs[1]['review_status'], 'duplicate')
        self.assertIsNone(obs[1]['primary_issue'])
        self.assertTrue(obs[1]['issues'])
        self.assertEqual([r['position'] for r in obs if r['document_id']=='c'], [0, 1])

    def test_stale_supplement_remains_primary_until_explicitly_reconfirmed(self):
        source = row('a', amount=999)
        obs = observed([source], {'a-0': dict(fingerprint='old', data={'weight_kg': 2})})
        self.assertEqual(obs[0]['primary_issue']['code'], 'stale_supplement')
        self.assertTrue(any(i['key']=='amount' for i in obs[0]['issues']))
        obs = observed([source], {'a-0': dict(fingerprint=fingerprint(source), data={'weight_kg': 2})})
        self.assertEqual(obs[0]['primary_issue']['code'], 'amount_mismatch')
        self.assertFalse(obs[0]['eligible'])

    def test_filtered_counts_follow_backend_selection_in_both_price_bases(self):
        for basis in ['original', 'material']:
            obs = observed([row('a', amount=999), row('b', price=None), row('c', grade='7075')], basis=basis)
            result = build_analysis(obs, [], [], {'price_basis': basis, 'grade': '6061'})
            self.assertEqual(result['review']['all'], 2)
            self.assertEqual(result['review']['needs_review'], sum(not r['eligible'] and not r.get('duplicate_of') for r in result['observations']))


if __name__ == '__main__':
    unittest.main()
