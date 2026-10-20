"""Invoice arithmetic. Original document amounts are never changed by a calculation."""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import math


def decimal_value(value):
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def billing_unit(item):
    return '公斤' if item.get('pricing_basis') == 'weight' else item.get('unit') or '件'


def billing_quantity(item):
    return item.get('weight_kg') if item.get('pricing_basis') == 'weight' else item.get('qty')


def estimate_amount(item):
    if item.get('pricing_basis', 'quantity') not in ['quantity', 'weight']:
        return None
    price, qty = decimal_value(item.get('price')), decimal_value(billing_quantity(item))
    raw_fee = item.get('processing_fee')
    fee = Decimal(0) if raw_fee is None or (isinstance(raw_fee, str) and not raw_fee.strip()) else decimal_value(raw_fee)
    if price is None or price < 0 or qty is None or qty <= 0 or fee is None or fee < 0:
        return None
    try:
        with localcontext() as context:
            context.prec = 100
            value = float((price*qty+fee).quantize(Decimal('.01'), rounding=ROUND_HALF_UP))
        return value if math.isfinite(value) else None
    except (InvalidOperation, OverflowError):
        return None


def infer_pricing_basis(item):
    """Use weight only when observed money distinguishes it from quantity billing."""
    weight = decimal_value(item.get('weight_kg'))
    if weight is None or weight <= 0:
        return 'quantity', ''
    price = decimal_value(item.get('price'))
    qty = decimal_value(item.get('qty'))
    material = decimal_value(item.get('material_amount'))
    amount = decimal_value(item.get('amount'))
    fee = decimal_value(item.get('processing_fee')) or Decimal(0)
    if price is not None and price >= 0 and qty is not None and qty > 0:
        observed = material if material is not None else amount-fee if amount is not None else None
        if observed is not None:
            weight_matches = abs(price*weight-observed) <= Decimal('.02')
            quantity_matches = abs(price*qty-observed) <= Decimal('.02')
            if weight_matches and not quantity_matches:
                return 'weight', ''
            if quantity_matches and not weight_matches:
                return 'quantity', ''
    return 'quantity', '有重量資料但無法唯一判定計價依據，請核對按數量或按重量計價。'
