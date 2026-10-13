// Display defaults only: do not write inferred facts back into customer records.
export function customerPresentation(customer) {
  const result = { ...customer };
  for (const key of ['tags', 'timeline', 'journeys', 'pains', 'itches', 'delights', 'customerNotes']) {
    result[key] = Array.isArray(customer[key]) ? customer[key] : [];
  }
  result.interests = (Array.isArray(customer.interests) ? customer.interests : [])
    .filter(Boolean).map(item => ({ ...item, trend: item.trend || '' }));
  for (const key of ['sla', 'gender', 'city']) result[key] = customer[key] || '待确认';
  result.profile = { budget:'待确认', decision:'待确认', contact:'待确认', style:'待确认', concern:'待确认', confidence:0, ...customer.profile };
  result.nextAction = { title:'待确认下一步', owner:customer.owner || '未分配', channel:'待确认', status:'待确认', reason:'资料尚未完善', guardrail:'请根据实际沟通确认', ...customer.nextAction };
  return result;
}
