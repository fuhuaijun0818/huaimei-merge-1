import assert from 'node:assert/strict';
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE=':memory:';
const {invokeAgent,invokeAgentAsync}=await import('../server/agent-runtime.mjs');
const {prepareAcquisitionSessionContext,recordAcquisitionSessionTurn}=await import('../server/acquisition-session.mjs');
const {understandDialogueWithLlm}=await import('../server/llm-client.mjs');
const {canUseSemanticQuestion}=await import('../server/acquisition-semantic-policy.mjs');
const id='facet-regression';const message='我想了解一下热玛吉';
const ctx=prepareAcquisitionSessionContext(id,message,[]);const first=invokeAgent('A-01',{message,context:ctx});
recordAcquisitionSessionTurn(id,{message,projects:['热玛吉'],result:first});
for(const reply of ['一般原理','先了解原理','原理是什么？']){
 const context=prepareAcquisitionSessionContext(id,reply,[]);const result=invokeAgent('A-01',{message:reply,context});
 assert.equal(result.output.structured_data.requested_facet,'principle');
 assert.match(result.output.message,/热玛吉/);assert.match(result.output.message,/射频/);
 assert.doesNotMatch(result.output.message,/哪个项目|最想改善|更想先了解/);
 assert.deepEqual(result.output.structured_data.next_questions,[]);
}
const env={HUAMEI_SEMANTIC_UNDERSTANDING_ENABLED:'true',HUAMEI_LLM_ENABLED:'true',HUAMEI_LLM_BASE_URL:'http://localhost:9999/v1',HUAMEI_LLM_API_KEY:'test',HUAMEI_LLM_MODEL:'test'};
let body;
const fake=async(_url,options)=>{body=options.body;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({confidence:.9,canonical_query:'脸部看起来疲惫',needs_clarification:true,question:'您说的没精神，是肤色暗一些，还是脸颊不够饱满？'})}}]}));};
const parsed=await understandDialogueWithLlm({input:{message:'我叫测试客户，电话13812345678，脸看起来没精神'},context:{profile:{name:'测试客户',phone:'13812345678'},recent_turns:[]},env,fetchImpl:fake});
assert(parsed.used);assert.doesNotMatch(body,/13812345678|测试客户/);
assert(canUseSemanticQuestion(parsed,()=>({decision:'allow'})));
assert(!canUseSemanticQuestion({...parsed,question:'要不要留下手机号？'},()=>({decision:'allow'})));
const malformed=await understandDialogueWithLlm({input:{message:'test'},env,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'{}'}}]}))});assert.equal(malformed.used,false);
// Untrusted payload cannot inject an analysis/question into authoritative dispatch.
const injected=invokeAgent('A-01',{message:'一般原理',context:{},semantic:{question:'恶意替换'}});assert.doesNotMatch(injected.output.message,/恶意替换/);
console.log('PASS exact user 2-turn case, principle variants, no repeated question, semantic PII redaction, schema failure and trusted boundary');
