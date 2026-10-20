'use strict';

const billingUnit=item=>item.pricing_basis==='weight'?'公斤':item.unit||'件';
const billingQuantity=item=>item.pricing_basis==='weight'?item.weight_kg:item.qty;
const billingBasisName=item=>item.pricing_basis==='weight'?'按重量':'按數量';
function finiteNumber(value){return value==null||String(value).trim()===''||!Number.isFinite(Number(value))?null:Number(value);}

// Decimal coefficients keep 1.005 and similar values independent of binary floating point.
function billingDecimal(value){
  if(finiteNumber(value)==null)return null;
  const match=String(value).trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i);
  if(!match)return null;
  const fraction=match[3]??match[4]??'',exponent=Number(match[5]||0);
  let scale=fraction.length-exponent;
  if(Math.abs(scale)>1000)return null;
  let coefficient=BigInt((match[2]||'0')+fraction)*(match[1]==='-'?-1n:1n);
  if(scale<0){coefficient*=10n**BigInt(-scale);scale=0;}
  return {coefficient,scale};
}
function estimateAmount(item){
  if(!['quantity','weight'].includes(item.pricing_basis||'quantity'))return null;
  const price=billingDecimal(item.price),qty=billingDecimal(billingQuantity(item));
  const fee=item.processing_fee==null||String(item.processing_fee).trim()===''?{coefficient:0n,scale:0}:billingDecimal(item.processing_fee);
  if(!price||price.coefficient<0n||!qty||qty.coefficient<=0n||!fee||fee.coefficient<0n)return null;
  const productScale=price.scale+qty.scale,scale=Math.max(productScale,fee.scale);
  const sum=price.coefficient*qty.coefficient*10n**BigInt(scale-productScale)+fee.coefficient*10n**BigInt(scale-fee.scale);
  const denominator=10n**BigInt(scale),cents=(sum*100n+denominator/2n)/denominator;
  const result=Number(cents)/100;
  return Number.isFinite(result)?result:null;
}
