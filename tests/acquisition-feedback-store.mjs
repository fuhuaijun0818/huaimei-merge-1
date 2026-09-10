import assert from "node:assert/strict";

process.env.HUAMEI_CONVERSATION_FEEDBACK_STORE_FILE = ":memory:";
const {
  createConversationFeedback,
  listBadCaseFeedback,
  resetConversationFeedbackStoreForTests,
  reviewConversationFeedback
} = await import("../server/acquisition-feedback-store.mjs");

resetConversationFeedbackStoreForTests();

const created = createConversationFeedback({
  tenant_id:"tenant-feedback-store",
  channel:"web",
  conversation_id:"conversation-1",
  reply_id:"reply-1",
  rating:"down",
  transcript:[
    { id:"u-1", role:"user", content:"想了解丰胸，电话 139 1111 2222", at:"2026-08-31T09:00:00.000Z" },
    { id:"a-1", role:"assistant", content:"我先说明一般项目流程。", at:"2026-08-31T09:00:02.000Z" }
  ]
});

assert.equal(created.replayed, false);
assert.equal(created.feedback.is_bad_case, true);
assert.match(created.feedback.transcript[0].content, /139\*\*\*\*2222/);
assert.doesNotMatch(created.feedback.transcript[0].content, /13911112222/);
assert.equal(listBadCaseFeedback({ tenant_id:"tenant-feedback-store" }).length, 1);

const replay = createConversationFeedback({
  tenant_id:"tenant-feedback-store",
  channel:"web",
  conversation_id:"conversation-1",
  reply_id:"reply-1",
  rating:"down",
  transcript:created.feedback.transcript
});
assert.equal(replay.replayed, true, "同一轮回答重复点击踩应合并为一条记录");

const reviewed = reviewConversationFeedback({
  tenant_id:"tenant-feedback-store",
  feedback_id:created.feedback.id,
  actor:"quality-reviewer",
  status:"included_in_eval",
  note:"加入多轮上下文与意图识别回归集",
  idempotency_key:"feedback-store-review-once"
});
assert.equal(reviewed.feedback.status, "included_in_eval");
assert.equal(reviewed.feedback.reviewed_by, "quality-reviewer");
assert.equal(reviewConversationFeedback({
  tenant_id:"tenant-feedback-store",
  feedback_id:created.feedback.id,
  actor:"quality-reviewer",
  status:"included_in_eval",
  note:"加入多轮上下文与意图识别回归集",
  idempotency_key:"feedback-store-review-once"
}).replayed, true, "Bad Case审核重试必须幂等");

const positive = createConversationFeedback({
  tenant_id:"tenant-feedback-store",
  channel:"web",
  conversation_id:"conversation-1",
  reply_id:"reply-1",
  rating:"up",
  transcript:created.feedback.transcript
});
assert.equal(positive.feedback.status, "positive");
assert.equal(listBadCaseFeedback({ tenant_id:"tenant-feedback-store" }).length, 0, "用户改为赞后不得继续出现在Bad Case队列");

console.log("✓ 客户赞踩、脱敏上下文、Bad Case队列与幂等审核通过");
