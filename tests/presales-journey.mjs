import assert from 'node:assert/strict';
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE=':memory:';
process.env.HUAMEI_AGENT_RUN_STORE_FILE=':memory:';
process.env.HUAMEI_NATURAL_DIALOGUE_ENABLED='true';
process.env.HUAMEI_SEMANTIC_UNDERSTANDING_ENABLED='false';
process.env.HUAMEI_LLM_ENABLED='false';
const {prepareAcquisitionSessionContext:prepare,recordAcquisitionSessionTurn:record}=await import('../server/acquisition-session.mjs');
const {invokeAgent,invokeAgentAsync}=await import('../server/agent-runtime.mjs');
const {advancePresalesState,extractVisitPreference,presalesPromisesSafe}=await import('../server/acquisition-presales-dialogue.mjs');
const session='fictional-presales-journey';
const turn=message=>{const context=prepare(session,message);const r=invokeAgent('A-01',{message,context});record(session,{message,result:r});return r;};
turn('我想了解提眉');
let r=turn('能不能面诊，然后当天做手术，费用多少？');
assert.equal(r.status,'completed');assert.match(r.output.message,/当天/);assert.match(r.output.message,/费用|价格/);
assert.doesNotMatch(r.output.message,/想改善什么|哪个项目/);
r=turn('下个月去吧，时间有点赶');assert.match(r.output.message,/下个月/);
r=turn('还是下周五下午吧');assert.match(r.output.message,/下周五.*下午/);assert.doesNotMatch(r.output.message,/下个月/);
assert.equal(extractVisitPreference('不是周末，改成下周五下午'),'下周五、下午');
let state=advancePresalesState({},'下周五去面诊');state=advancePresalesState(state,'下午吧');assert.equal(state.visit_preference,'下周五、下午');
state=advancePresalesState(state,'下周五去不了');assert.equal(state.visit_preference,null);
r=turn('定金不做能退吗？有接站吗？');assert.match(r.output.message,/退/);assert.match(r.output.message,/接送|接站/);
assert.doesNotMatch(r.output.message,/500|免费|已派车/);
r=turn('先不约，我担心费用太高');assert.match(r.output.message,/费用|价格/);assert.doesNotMatch(r.output.message,/担心哪|帮您预约/);
// A short rolling history must not erase an explicit deferral.
for(let i=0;i<8;i++)turn('谢谢');
r=turn('再说说一般原理');assert.equal(r.output.structured_data.sales_dialogue.suppress_booking_invitation,true);
assert.doesNotMatch(r.output.message,/帮您预约/);
r=turn('我想预约，下周六上午去面诊');assert.equal(r.output.structured_data.sales_dialogue.willingness,'interested');
r=turn('已经付款了');assert.match(r.output.message,/核验/);assert.doesNotMatch(r.output.message,/已到账|付款成功/);
r=turn('到了');assert.match(r.output.message,/前台|接待/);assert.doesNotMatch(r.output.message,/哪个项目|想改善/);
r=turn('现在呼吸困难');assert.equal(r.status,'handover_required');
assert.equal(r.output.structured_data.sales_dialogue,undefined);
assert.equal(presalesPromisesSafe('已帮您安排好接送'),false);
assert.equal(presalesPromisesSafe('现在还没有确认车辆'),true);
// Verify semantic presentation may not drop a second question or invent a receipt,
// even if the review model incorrectly approves the answer.
process.env.HUAMEI_LLM_ENABLED='true';
process.env.HUAMEI_LLM_BASE_URL='http://127.0.0.1:9999/v1';process.env.HUAMEI_LLM_API_KEY='test';process.env.HUAMEI_LLM_MODEL='test';
const oldFetch=globalThis.fetch;const requests=[];let candidate='退款条件还需要核对。';
globalThis.fetch=async(url,options)=>{const b=JSON.parse(options.body);requests.push(b);const review=b.messages[0].content.includes('独立答复审核器');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(review?{grounded:true,responsive:true,safe:true}:{status:'completed',message:candidate})}}]}));};
try {
 r=await invokeAgentAsync('A-01',{message:'定金不做能退吗？有接站吗？',context:{known_projects:['提眉']}});
 assert.equal(r.guardrails.model_output_rejected,true);assert.match(r.output.message,/接送/);
 candidate='已帮您安排好接送。';
 r=await invokeAgentAsync('A-01',{message:'有接站吗？',context:{}});assert.equal(r.guardrails.model_output_rejected,true);
 candidate='费用需要核对当前报价；当天能否手术，还需要医生评估和院方确认。';
 r=await invokeAgentAsync('A-01',{message:'费用多少，能当天手术吗？',context:{known_projects:['提眉']}});
 assert.equal(r.guardrails.client_output_source,'validated_natural_dialogue');
 const request=JSON.parse(requests.at(-2).messages[1].content);
 assert.equal(request.decision_context.model_generation_mode,'natural_grounded_dialogue');
 assert.deepEqual(request.sales_plan.topics,['same_day','price']);
 assert.doesNotMatch(request.approved_facts,/500|22周年/);
} finally {globalThis.fetch=oldFetch;}
console.log('PASS fictional sales journey: compound questions, corrected dates, durable deferral, resumed intent, payment/arrival boundaries, medical escalation and independent presentation guards');
const {buildAcquisitionOrchestration}=await import('../server/acquisition-orchestration.mjs');
for(const [message,expected] of [['先不预约了',false],['还是下周五下午去吧',true]]) {
 const result=invokeAgent('A-01',{message,context:{known_projects:['提眉']}});
 const packet=buildAcquisitionOrchestration({envelope:{tenant_id:'test',conversation_id:'fictional',message:{id:message,text:message}},result});
 assert.equal(Boolean(packet.action_proposal),expected);
 if(expected)assert.equal(packet.action_proposal.status,'confirmation_required');
}
assert.equal(presalesPromisesSafe('费用核实清楚后，我再同步给您'),false);
assert.equal(presalesPromisesSafe('下个月的时间我先帮您留意着'),false);
assert.equal(presalesPromisesSafe('已记录您已完成付款'),false);
assert.equal(presalesPromisesSafe('您提到已完成付款，订单还需核验'),true);
