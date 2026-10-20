import json
def summary(bridge):
    state=bridge.store.state()
    keys=['sup','date','doc','grade','shape','dims','qty','unit','price','amount','weight_kg','pricing_basis','processing_fee','tax','document_total']
    records=sorted([{k:r.get(k) for k in keys} for r in state['records']],key=lambda r:json.dumps(r,sort_keys=True))
    result=bridge.store.analysis.query({'price_basis':'gross','metal':'steel','grade':'S50C'})
    points=sorted([{k:r.get(k) for k in ['date','sup','grade','dims','qty','weight_kg','unit_kg','eligible']} for r in result['observations']],key=lambda r:json.dumps(r,sort_keys=True))
    return {'documents':len(state['documents']),'counts':state['organization_counts'],'records':records,'analysis':points}
