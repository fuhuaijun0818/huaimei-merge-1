import assert from 'node:assert/strict';
import {invokeAgent} from '../server/agent-runtime.mjs';
for(const message of ['抗衰老推荐什么项目呢？','抗衰有哪些项目','抗初老推荐什么项目']){
 const r=invokeAgent('A-01',{message,context:{}});
 assert.equal(r.output.structured_data.understanding_status,'broad_goal_needs_concern',message);
 assert.match(r.output.message,/细纹|松弛/);assert.doesNotMatch(r.output.message,/当前改善问题|抗初老\/紧致除皱|预约|专家/);
 assert.equal((r.output.message.match(/[？?]/g)||[]).length,1);
 // A-016 AC2 口径：知识包里有可公开的抗衰资料时，广目标轮次必须先介绍可了解的方向，
 // 因此允许带来源记录号的公开资料引用（上限 2 条）；资料不足时仍为零引用。
 // 不变的是：不得把目录标题当推荐、不得给个人疗效判断、不得逼约。
 assert.ok(r.output.citations.length <= 2, `${message}：广目标引用不得超过 2 条`);
 for(const item of r.output.citations){
  assert.ok(item.source_record_id, `${message}：引用必须带来源记录号`);
 }
 assert.doesNotMatch(r.output.message,/推荐您做|最适合|保证|一定能|百分百/,`${message}：方向介绍不得写成推荐或疗效承诺`);
 assert.doesNotMatch(r.output.message,/华美资料目录|项目介绍/,`${message}：不得把目录标题当作介绍内容`);
}
for(const message of ['抗衰项目热玛吉的原理是什么','抗衰老，我主要想改善脸部松弛']){
 const r=invokeAgent('A-01',{message,context:{}});assert.notEqual(r.output.structured_data.understanding_status,'broad_goal_needs_concern');
}
const follow=invokeAgent('A-01',{message:'抗衰老推荐什么项目呢？',context:{profile:{concern:'脸部松弛'}}});assert.notEqual(follow.output.structured_data.understanding_status,'broad_goal_needs_concern');
console.log('PASS broad goal clarifies once, no category recommendation or premature booking; concrete project/known concern preserved');
