import copy
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest

from billing import estimate_amount, billing_unit, billing_quantity, infer_pricing_basis
from domain import parse_ocr, validate_draft, SUPPLIERS
from server import Store, csv_bytes

FIXTURE=Path(__file__).parent/'fixtures/sk_fees.json'


def sample():
    return parse_ocr(json.loads(FIXTURE.read_text()))


class ProcessingOCRTests(unittest.TestCase):
    def test_real_mixed_basis_rows_and_footer(self):
        data=sample();first,second=data['items']
        self.assertEqual(data['meta']['doc'],'20260111402')
        self.assertEqual(first['dims'],[22,54,146])
        self.assertEqual((first['qty'],first['unit'],first['weight_kg']),(10,'件',14))
        self.assertEqual((first['price'],first['material_amount'],first['processing_fee'],first['amount']),(85,1190,240,1430))
        self.assertEqual(first['note'],'銑4');self.assertEqual(first['pricing_basis'],'weight')
        self.assertEqual((second['qty'],second['weight_kg'],second['price'],second['material_amount'],second['amount']),(27,None,98,2646,2646))
        self.assertIsNone(second['processing_fee']);self.assertEqual(second['pricing_basis'],'quantity')
        self.assertEqual(sum(i['amount'] for i in data['items']),4076)
        self.assertEqual(data['meta']['total'],4076)

    def test_amount_note_with_and_without_space(self):
        ocr=json.loads(FIXTURE.read_text())
        for line in ocr['pages'][0]['lines']:
            if '銑4' in line['text']:line['text']=line['text'].replace(' ','')
        items=parse_ocr(ocr)['items']
        self.assertEqual([i['amount'] for i in items],[1430,2646])
        self.assertTrue(all(i['note']=='銑4' for i in items))

    def test_amount_never_falls_back_to_material_or_processing_columns(self):
        ocr=json.loads(FIXTURE.read_text())
        for page in ocr['pages']:
            page['lines']=[l for l in page['lines'] if not (l['y']<.35 and '銑4' in l['text'])]
        first= parse_ocr(ocr)['items'][0]
        self.assertIsNone(first['amount']);self.assertEqual(first['processing_fee'],240)
        self.assertEqual(first['material_amount'],1190)

    def test_weight_is_not_selected_without_distinguishing_money(self):
        for item in [dict(qty=7,weight_kg=8.4,price=125),dict(qty=8.4,weight_kg=8.4,price=125,material_amount=1050),dict(qty=7,weight_kg=8.4,price=125,material_amount=999)]:
            basis,warning=infer_pricing_basis(item)
            self.assertEqual(basis,'quantity');self.assertTrue(warning)
        self.assertEqual(infer_pricing_basis(dict(qty=7,weight_kg=8.4,price=125,amount=1540,processing_fee=490))[0],'weight')
        self.assertEqual(infer_pricing_basis(dict(qty=7,weight_kg=8.4,price=125,amount=875))[0],'quantity')


class InvoiceCalculationTests(unittest.TestCase):
    def test_exact_rounding_and_blank_fee(self):
        for price,qty,fee,expected in [('1.005',1,None,1.01),('0.335',3,'',1.01),('0.1',3,'0.005',.31),('125',8.4,490,1540),(0,5,490,490),(0,5,0,0)]:
            self.assertEqual(estimate_amount(dict(price=price,qty=qty,processing_fee=fee)),round(expected,2))

    def test_quantity_and_weight_remain_distinct(self):
        first=sample()['items'][0];snapshot=copy.deepcopy(first)
        self.assertEqual(estimate_amount(first),1430);self.assertEqual(first,snapshot)
        self.assertEqual(billing_unit(first),'公斤');self.assertEqual(billing_quantity(first),14)
        first['pricing_basis']='quantity'
        self.assertEqual(estimate_amount(first),1090);self.assertEqual(billing_unit(first),'件')

    def test_incomplete_or_invalid_trial_is_none(self):
        base=dict(price=125,qty=7,processing_fee=490)
        for update in [dict(price=None),dict(qty=''),dict(qty=0),dict(processing_fee='NaN'),dict(processing_fee=-1),dict(pricing_basis='weight'),dict(pricing_basis='weight',weight_kg=0),dict(pricing_basis='unknown')]:
            self.assertIsNone(estimate_amount(dict(base,**update)),update)

    def test_validation_and_blank_zero_fee(self):
        data=sample();data['items'][0]['amount']=99
        rows=validate_draft(data,SUPPLIERS)
        self.assertEqual(rows[0]['amount'],99)  # validation never silently applies a trial amount
        self.assertEqual(rows[0]['qty'],10);self.assertEqual(rows[0]['unit'],'件')
        self.assertIsNone(rows[1]['processing_fee'])
        data['items'][1]['processing_fee']=0
        self.assertEqual(validate_draft(data,SUPPLIERS)[1]['processing_fee'],0)
        for update in [dict(weight_kg=0),dict(weight_kg=None),dict(weight_kg=-1),dict(weight_kg='Infinity'),dict(processing_fee=-1),dict(processing_fee='NaN'),dict(material_amount=-1),dict(pricing_basis='unknown')]:
            invalid=sample();invalid['items'][0].update(update)
            with self.assertRaises(ValueError,msg=str(update)):validate_draft(invalid,SUPPLIERS)


class BillingPersistenceTests(unittest.TestCase):
    def test_save_confirm_reload_export_and_legacy_compatibility(self):
        with tempfile.TemporaryDirectory() as folder:
            store=Store(folder)
            try:
                identifier=store.import_bytes('fees.png',b'fake-test-only',submit=False)['id']
                with store.connect() as db:db.execute("UPDATE documents SET status='pending' WHERE id=?",(identifier,))
                data=sample();data['items'][0]['note']='人工備註';data['items'][0]['amount']=99
                store.save_draft(identifier,data)
                self.assertEqual(store.document(identifier)['draft'],data)
                store.confirm(identifier,data)
                reopened=Store(folder)
                try:
                    rows=reopened.records();first=next(r for r in rows if r['qty']==10)
                    self.assertEqual((first['qty'],first['weight_kg'],first['processing_fee'],first['material_amount'],first['amount']),(10,14,240,1190,99))
                    exported=list(csv.DictReader(io.StringIO(csv_bytes(rows,reopened.suppliers()).decode('utf-8-sig'))))
                    row=next(r for r in exported if float(r['數量'])==10)
                    self.assertEqual((row['計價單位'],row['數量單位'],row['重量(kg)'],row['計價依據'],row['計價數量'],row['加工費(TWD)']),('公斤','件','14.0','按重量','14.0','240.0'))
                    self.assertNotIn(None,row)
                    for item in data['items']:
                        for key in ['processing_fee','weight_kg','material_amount','pricing_basis']:item.pop(key,None)
                    old=validate_draft(data,SUPPLIERS)[0]
                    self.assertEqual(old['pricing_basis'],'quantity');self.assertEqual(old['amount'],99)
                    self.assertEqual(billing_unit(old),'件');self.assertIsNone(old['processing_fee'])
                finally:reopened.executor.shutdown(wait=True)
            finally:store.executor.shutdown(wait=True)


if __name__=='__main__':unittest.main()
