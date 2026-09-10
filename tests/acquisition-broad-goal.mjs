import assert from 'node:assert/strict';
import {invokeAgent} from '../server/agent-runtime.mjs';
for(const message of ['抗衰老推荐什么项目呢？','抗衰有哪些项目','抗初老推荐什么项目']){
 const r=invokeAgent('A-01',{message,context:{}});
 assert.equal(r.output.structured_data.understanding_status,'broad_goal_needs_concern',message);
 assert.match(r.output.message,/细纹|松弛/);assert.doesNotMatch(r.output.message,/当前改善问题|抗初老\/紧致除皱|预约|专家/);
 assert.equal((r.output.message.match(/[？?]/g)||[]).length,1);
 assert.equal(r.output.citations.length,0);
}
for(const message of ['抗衰项目热玛吉的原理是什么','抗衰老，我主要想改善脸部松弛']){
 const r=invokeAgent('A-01',{message,context:{}});assert.notEqual(r.output.structured_data.understanding_status,'broad_goal_needs_concern');
}
const follow=invokeAgent('A-01',{message:'抗衰老推荐什么项目呢？',context:{profile:{concern:'脸部松弛'}}});assert.notEqual(follow.output.structured_data.understanding_status,'broad_goal_needs_concern');
console.log('PASS broad goal clarifies once, no category recommendation or premature booking; concrete project/known concern preserved');
