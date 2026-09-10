import assert from 'node:assert/strict';
process.env.HUAMEI_LLM_ENABLED='true';
process.env.HUAMEI_NATURAL_DIALOGUE_ENABLED='true';
process.env.HUAMEI_SEMANTIC_UNDERSTANDING_ENABLED='false';
process.env.HUAMEI_LLM_BASE_URL='http://127.0.0.1:9999/v1';
process.env.HUAMEI_LLM_API_KEY='test';
process.env.HUAMEI_LLM_MODEL='test';
process.env.HUAMEI_LLM_MAX_RETRIES='0';
const {invokeAgentAsync}=await import('../server/agent-runtime.mjs');
const requests=[];let approve=true;let candidate='我们接着聊热玛吉，它采用射频技术。';
const old=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 const b=JSON.parse(options.body);requests.push(b);
 const review=b.messages[0].content.includes('独立答复审核器');
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(review?{grounded:approve,responsive:approve,safe:approve}:{status:'completed',message:candidate,recommended_actions:[{type:'book_now'}],structured_data:{project:'恶意替换'}})}}]}));
};
try {
 const context={known_projects:['热玛吉'],recent_turns:[{role:'user',content:'我想了解热玛吉，我叫测试客户，手机号13812345678'},{role:'assistant',content:'您想了解原理吗？'}]};
 const r=await invokeAgentAsync('A-01',{message:'一般原理',context});
 assert.equal(r.guardrails.client_output_source,'validated_natural_dialogue');
 assert.match(r.output.message,/我们接着聊/);
 assert(!r.output.recommended_actions.some(a=>a.type==='book_now'));
 assert.doesNotMatch(JSON.stringify(r.output.structured_data),/恶意替换/);
 const input=JSON.parse(requests[0].messages[1].content);
 assert.equal(input.dialogue.current,'一般原理');assert.match(input.dialogue.recent[0].content,/热玛吉/);
 assert.doesNotMatch(JSON.stringify(requests),/13812345678|测试客户/);
 approve=false;const denied=await invokeAgentAsync('A-01',{message:'一般原理',context});
 assert.equal(denied.guardrails.model_output_rejected,true);
 assert.doesNotMatch(denied.output.message,/我们接着聊/);
 approve=true;candidate='保证您做完零风险，只要9999元。';
 const unsafe=await invokeAgentAsync('A-01',{message:'一般原理',context});assert.equal(unsafe.guardrails.model_output_rejected,true);assert.doesNotMatch(unsafe.output.message,/9999|保证您/);
 console.log('PASS natural paraphrase; context and PII minimization; independent rejection fallback; model cannot mutate business actions');
} finally {globalThis.fetch=old;}
const {invokeAgent}=await import('../server/agent-runtime.mjs');
const reference=invokeAgent('A-01',{message:'这两个有什么区别',context:{known_projects:['热玛吉','线雕提升']}});
assert.equal(reference.output.structured_data.intent,'project_comparison');
assert.match(reference.output.message,/热玛吉/);assert.match(reference.output.message,/线雕/);
assert.doesNotMatch(reference.output.message,/最想改善的是什么/);
