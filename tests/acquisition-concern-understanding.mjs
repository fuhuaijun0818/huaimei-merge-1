import assert from 'node:assert/strict';
import {understandConcern} from '../server/acquisition-concern-understanding.mjs';
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE=':memory:';
const {invokeAgent}=await import('../server/agent-runtime.mjs');
const {prepareAcquisitionSessionContext,recordAcquisitionSessionTurn}=await import('../server/acquisition-session.mjs');
for(const text of ['我的脸有点垮，什么项目合适？','脸看起来有些松垮','面部看起来很累']){
 const r=invokeAgent('A-01',{message:text,context:{}});
 assert.equal(r.output.structured_data.understanding_status,'needs_confirmation',text);
 assert.doesNotMatch(r.output.message,/哪个部位|主要关注|适合您|推荐您做/);
 assert.equal((r.output.message.match(/[？?]/g)||[]).length,1);
}
assert.deepEqual(understandConcern('工作忙到垮了').concerns,[]);
assert.deepEqual(understandConcern('不是松弛而是凹陷',['松弛']).concerns,['凹陷']);
const body=invokeAgent('A-01',{message:'我想改善脸部',context:{}});
assert.match(body.output.message,/面部/);assert.doesNotMatch(body.output.message,/哪个部位|说得很清楚/);
const session='concern-regression';
const first='我的脸有点垮，什么项目合适？';
const ctx=prepareAcquisitionSessionContext(session,first,[]);
const r=invokeAgent('A-01',{message:first,context:ctx});
recordAcquisitionSessionTurn(session,{message:first,projects:[],result:r});
const corrected=prepareAcquisitionSessionContext(session,'不是松弛，是脸颊凹陷',[]);
assert.doesNotMatch(corrected.profile.concern,/松弛/);assert.match(corrected.profile.concern,/凹陷/);
const reply=invokeAgent('A-01',{message:'不是松弛，是脸颊凹陷',context:corrected}).output.message;
assert.doesNotMatch(reply,/抗初老|拉皮|哪个部位/);assert.match(reply,/凹陷/);
const preference=invokeAgent('A-01',{message:'不想动刀',context:{profile:{concern:'嘴边肉'},recent_turns:[{role:'user',content:'嘴边肉下来了'}]}});
assert.match(preference.output.message,/不考虑手术/);assert.match(preference.output.message,/嘴边肉/);assert.doesNotMatch(preference.output.message,/哪个部位|主要关注/);
console.log('PASS: colloquial concerns, ambiguity, known body, correction, session memory and procedure preference');
