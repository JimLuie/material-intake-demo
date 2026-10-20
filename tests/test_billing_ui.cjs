'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function billing(){
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/billing.js'),'utf8'),context);
  return value=>vm.runInContext(value,context);
}
test('trial uses the chosen billing quantity without changing original quantity or amount',()=>{
  const run=billing();
  run("var row={qty:7,unit:'件',weight_kg:8.4,price:125,processing_fee:490,amount:1540,pricing_basis:'weight'}");
  assert.equal(run('estimateAmount(row)'),1540);
  assert.equal(run('billingUnit(row)'),'公斤');assert.equal(run('billingQuantity(row)'),8.4);
  assert.equal(run('row.qty'),7);assert.equal(run('row.unit'),'件');
  run('row.processing_fee=500');assert.equal(run('estimateAmount(row)'),1550);assert.equal(run('row.amount'),1540);
  run("row.pricing_basis='quantity';row.processing_fee=490");
  assert.equal(run('estimateAmount(row)'),1365);assert.equal(run('billingUnit(row)'),'件');
});
test('decimal rounding, explicit zero and blank fee match invoice rules',()=>{
  const run=billing();
  for(const [price,qty,fee,expected] of [['1.005',1,null,1.01],['.335',3,'',1.01],['.1',3,'.005',.31],[0,7,0,0],[110,36,'',3960],['1e-3',5,0,.01]]){
    assert.equal(run(`estimateAmount(${JSON.stringify({price,qty,processing_fee:fee})})`),expected);
  }
  run("var row={qty:36,price:110,processing_fee:''};estimateAmount(row)");assert.equal(run('row.processing_fee'),'');
  run('row.processing_fee=0;estimateAmount(row)');assert.equal(run('row.processing_fee'),0);
});
test('invalid or missing required billing values do not produce a trial',()=>{
  const run=billing();
  for(const item of [{qty:7,price:''},{qty:0,price:100},{qty:7,price:-1},{qty:7,price:100,processing_fee:-1},{qty:7,price:100,processing_fee:'NaN'},{qty:7,price:100,pricing_basis:'weight',weight_kg:0},{qty:7,price:100,pricing_basis:'weight',weight_kg:''},{qty:7,price:100,pricing_basis:'other'}]){
    assert.equal(run(`estimateAmount(${JSON.stringify(item)})`),null,JSON.stringify(item));
  }
});
