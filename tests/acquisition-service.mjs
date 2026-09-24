import assert from "node:assert/strict";

process.env.HUAMEI_LLM_ENABLED = "false";
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";
process.env.HUAMEI_CONVERSATION_FEEDBACK_STORE_FILE = ":memory:";
process.env.HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE = ":memory:";
process.env.HUAMEI_CONVERSATION_SEQUENCE_WAIT_MS = "250";
const { ACQUISITION_CHANNELS, formatChannelOutbound, normalizeChannelInbound } = await import("../server/acquisition-channel-adapters.mjs");
const { getOperationsStoreStatus } = await import("../server/acquisition-operations-store.mjs");
const { prepareAcquisitionSessionContext } = await import("../server/acquisition-session.mjs");
const { tenantScopedKey } = await import("../server/platform/tenant-context.mjs");
const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");

const webEnvelope = normalizeChannelInbound("web", { message:"请介绍光子嫩肤", session_id:"web-test-1", interests:["光子嫩肤"] });
assert.equal(webEnvelope.channel, "web");
assert.equal(webEnvelope.tenant_id, "huamei-shanghai");
assert.equal(webEnvelope.conversation_id, "web-test-1");
assert.equal(webEnvelope.message.text, "请介绍光子嫩肤");

const wecomEnvelope = normalizeChannelInbound("企业微信", { MsgId:"wx-1", FromUserName:"customer-1", Content:"想做胸部整形，推荐哪个医生？" });
assert.equal(wecomEnvelope.channel, "wecom");
assert.equal(wecomEnvelope.actor.external_user_id, "customer-1");
assert.equal(wecomEnvelope.conversation_id, "customer-1");
assert.equal(ACQUISITION_CHANNELS.length, 5);
assert.equal(ACQUISITION_CHANNELS.find((item) => item.id === "wecom")?.status, "not_configured");
assert.equal(ACQUISITION_CHANNELS.find((item) => item.id === "douyin")?.status, "not_configured");
assert.equal(ACQUISITION_CHANNELS.find((item) => item.id === "xiaohongshu")?.status, "not_configured");

assert.throws(() => normalizeChannelInbound("sms", { message:"你好" }), (error) => error.code === "UNSUPPORTED_CHANNEL");
assert.throws(() => normalizeChannelInbound("web", { message:"" }), (error) => error.code === "VALIDATION_ERROR");

const oidcVerifier = {
  async verifyAuthorizationHeader(header, requirements = {}) {
    const token = String(header || "").replace(/^Bearer\s+/i, "");
    if (!token) {
      const error = new Error("token missing");
      error.code = "OIDC_TOKEN_MISSING";
      error.status = 401;
      throw error;
    }
    const subject = token === "advisor-other" ? "advisor-other" : token === "advisor-restricted" ? "advisor-restricted" : "advisor-test";
    return {
      subject,
      roles:token === "quality-test" ? ["quality"] : ["operations.agent"],
      tenantIds:[requirements.tenantId],
      departmentIds:token === "advisor-restricted" ? ["无权验收科室"] : ["*"],
      issuer:"https://identity.test"
    };
  }
};
const server = createAcquisitionServiceServer({ host:"127.0.0.1", oidcVerifier });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.service, "huamei-acquisition-agent");
  assert.equal(healthBody.boundary, "independent_http_service");
  assert.ok(healthBody.channels.some((item) => item.id === "wecom"));

  const serviceOpenApi = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(serviceOpenApi.status, 200);
  const serviceSpecification = await serviceOpenApi.json();
  assert.equal(serviceSpecification.openapi, "3.1.0");
  assert.ok(serviceSpecification.paths["/v1/channels/{channel}/inbound"]);
  assert.ok(serviceSpecification.paths["/v1/conversations/reply"]);
  assert.ok(serviceSpecification.paths["/v1/conversations/feedback"]);
  assert.ok(serviceSpecification.paths["/v1/feedback/bad-cases"]);
  assert.ok(serviceSpecification.paths["/v1/handovers/{handoverId}/claim"]);
  const atomicCompletionOperation = serviceSpecification.paths["/v1/handovers/{handoverId}/complete"].post;
  assert.equal(atomicCompletionOperation.parameters.some((item) => item.name === "Idempotency-Key" && item.required === true), true);
  assert.deepEqual(atomicCompletionOperation.requestBody.content["application/json"].schema.required, ["resolution", "minutes"]);
  assert.ok(serviceSpecification.paths["/v1/operations/human-work"]);
  assert.ok(serviceSpecification.paths["/v1/knowledge/releases"]);

  const channels = await fetch(`${baseUrl}/v1/channels`);
  assert.equal(channels.status, 200);
  const channelList = (await channels.json()).data;
  assert.equal(channelList.length, 5);
  for (const channelId of ["wecom", "douyin", "xiaohongshu"]) {
    assert.equal(channelList.find((item) => item.id === channelId)?.status, "not_configured");
  }

  const feedbackCreate = await fetch(`${baseUrl}/v1/conversations/feedback`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({
      tenant_id:"tenant-feedback",
      channel:"web",
      conversation_id:"feedback-conversation-1",
      reply_id:"run-feedback-1",
      rating:"down",
      transcript:[
        { role:"user", content:"我想了解丰胸", at:"2026-08-31T09:00:00.000Z" },
        { role:"assistant", content:"您好，可以介绍一般项目流程。我的手机号是13812345678", at:"2026-08-31T09:00:01.000Z" }
      ]
    })
  });
  assert.equal(feedbackCreate.status, 201);
  const feedbackBody = await feedbackCreate.json();
  assert.match(feedbackBody.data.id, /^fb_/);
  assert.equal(feedbackBody.data.status, "new");
  assert.match(JSON.stringify(feedbackBody.data.transcript), /138\*\*\*\*5678/, "Bad Case记录必须在入库前脱敏电话");
  assert.doesNotMatch(JSON.stringify(feedbackBody.data.transcript), /13812345678/);
  const badCaseList = await fetch(`${baseUrl}/v1/feedback/bad-cases?tenant_id=tenant-feedback`);
  assert.equal(badCaseList.status, 200);
  assert.equal((await badCaseList.json()).data.length, 1);
  const feedbackReview = await fetch(`${baseUrl}/v1/feedback/bad-cases/${feedbackBody.data.id}/review`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:"Bearer quality-test", "Idempotency-Key":"feedback-review-once" },
    body:JSON.stringify({ tenant_id:"tenant-feedback", status:"included_in_eval", note:"纳入多轮上下文回归集" })
  });
  assert.equal(feedbackReview.status, 200);
  assert.equal((await feedbackReview.json()).data.status, "included_in_eval");

  const busyTenant = "tenant-test";
  const busyConversation = "sequence-busy-flow";
  const busySession = tenantScopedKey(busyTenant, "api", busyConversation);
  prepareAcquisitionSessionContext(busySession, "仍在处理的第一条消息", [], {
    tenantId:busyTenant,
    channel:"api",
    externalConversationId:busyConversation,
    inboundMessageId:"sequence-blocker-1"
  });
  const sequenceBusy = await fetch(`${baseUrl}/v1/conversations/reply`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({
      tenant_id:busyTenant,
      channel:"api",
      conversation_id:busyConversation,
      message:{ id:"sequence-blocked-2", text:"这是第二条消息" }
    })
  });
  assert.equal(sequenceBusy.status, 409);
  assert.equal(sequenceBusy.headers.get("retry-after"), "1");
  assert.equal((await sequenceBusy.json()).error.code, "CONVERSATION_SEQUENCE_BUSY");

  const web = await fetch(`${baseUrl}/v1/channels/web/inbound`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"web-message-1" },
    body:JSON.stringify({ message:"请介绍光子嫩肤的一般项目知识", session_id:"service-web-1" })
  });
  assert.equal(web.status, 200);
  const webBody = await web.json();
  assert.equal(webBody.agent.id, "A-01");
  assert.equal(typeof webBody.reply, "string");
  assert.ok(webBody.reply_segments.length >= 2);
  assert.ok(webBody.citations.some((item) => item.source_record_id === "KB-P-024"));
  assert.equal(webBody.profile_signals.turn_count, 1);
  assert.equal(webBody.orchestration.conversation_state.current_goal.intent, "project_explanation");
  assert.equal(webBody.orchestration.routing.retrieval_strategy, "none");

  const replay = await fetch(`${baseUrl}/v1/channels/web/inbound`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"web-message-1" },
    body:JSON.stringify({ message:"请介绍光子嫩肤的一般项目知识", session_id:"service-web-1" })
  });
  assert.equal(replay.headers.get("x-idempotent-replay"), "true");
  assert.equal((await replay.json()).run_id, webBody.run_id);
  const replayConflict = await fetch(`${baseUrl}/v1/channels/web/inbound`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"web-message-1" },
    body:JSON.stringify({ message:"相同幂等键但请求内容已经改变", session_id:"service-web-1" })
  });
  assert.equal(replayConflict.status, 409);
  assert.equal((await replayConflict.json()).error.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");

  const wecom = await fetch(`${baseUrl}/v1/channels/wecom/inbound`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ MsgId:"wx-msg-2", FromUserName:"customer-2", Content:"想做胸部整形，推荐哪个医生？" })
  });
  assert.equal(wecom.status, 200);
  const wecomBody = await wecom.json();
  assert.equal(wecomBody.channel, "wecom");
  assert.equal(wecomBody.msgtype, "text");
  assert.equal(typeof wecomBody.text.content, "string");
  assert.ok(wecomBody.messages.length >= 2);
  assert.deepEqual(wecomBody.metadata.reply_segments, wecomBody.messages.map((item) => item.content));
  assert.ok(wecomBody.metadata.profile_signals.doctors.length > 0);
  assert.equal(wecomBody.metadata.profile_signals.turn_count, 1);

  const unified = await fetch(`${baseUrl}/v1/conversations/reply`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ channel:"api", conversation_id:"partner-api-1", message:{ id:"partner-msg-1", text:"介绍李健院长个人资料" } })
  });
  assert.equal(unified.status, 200);
  const unifiedBody = await unified.json();
  assert.equal(unifiedBody.channel, "api");
  assert.equal(unifiedBody.reply.text.includes("李健"), true);
  assert.ok(unifiedBody.reply.segments.length >= 2);
  assert.equal(unifiedBody.profile_signals.turn_count, 1);
  assert.equal(unifiedBody.orchestration.routing.retrieval_strategy, "rag_metadata");
  assert.ok(unifiedBody.orchestration.evidence_claims.length >= 1);

  const contextualTurn = async (conversationId, messageId, text) => {
    const response = await fetch(`${baseUrl}/v1/conversations/reply`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({
        tenant_id:"huamei-shanghai",
        channel:"api",
        conversation_id:conversationId,
        message:{ id:messageId, text }
      })
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  await contextualTurn("context-recovery-flow", "context-recovery-1", "我想做胸部整形，想自然一点");
  const recoveryTurn = await contextualTurn("context-recovery-flow", "context-recovery-2", "恢复大概要多久？");
  assert.equal(recoveryTurn.profile_signals.intent, "conversation_followup");
  assert.match(recoveryTurn.reply.text, /胸部|隆胸/);
  assert.match(recoveryTurn.reply.text, /恢复/);
  assert.doesNotMatch(recoveryTurn.reply.text, /关注哪个部位|改善什么问题/);

  // 回归：客户已经选定自体脂肪丰胸后，指代性追问“这是什么原理”必须继承
  // 已选方式并命中对应项目资料，不能回退到任意其他项目的泛推荐。
  await contextualTurn("context-fat-principle-flow", "context-fat-principle-1", "我想咨询一下丰胸项目");
  const fatChoiceTurn = await contextualTurn("context-fat-principle-flow", "context-fat-principle-2", "自体脂肪隆胸");
  assert.match(fatChoiceTurn.reply.text, /自体脂肪丰胸/);
  const fatPrincipleTurn = await contextualTurn("context-fat-principle-flow", "context-fat-principle-3", "这是什么原理？");
  assert.equal(fatPrincipleTurn.profile_signals.intent, "project_explanation");
  assert.ok(fatPrincipleTurn.profile_signals.projects.includes("自体脂肪隆胸"));
  assert.match(fatPrincipleTurn.reply.text, /自身其他部位的脂肪/);
  assert.match(fatPrincipleTurn.reply.text, /移植到胸部/);
  assert.doesNotMatch(fatPrincipleTurn.reply.text, /热玛吉|面部提升|当前改善问题/);
  assert.deepEqual(fatPrincipleTurn.reply.citations.map((item) => item.source_record_id), ["KB-P-005"]);

  await contextualTurn("context-price-flow", "context-price-1", "双眼皮多少钱？");
  const priceConfirmation = await contextualTurn("context-price-flow", "context-price-2", "是的，帮我核验");
  assert.equal(priceConfirmation.profile_signals.intent, "price_verification");
  assert.match(priceConfirmation.reply.text, /价格|报价|核验/);
  const appointmentTurn = await contextualTurn("context-price-flow", "context-price-3", "周末可以吗？");
  assert.equal(appointmentTurn.profile_signals.intent, "appointment_query");
  assert.ok(appointmentTurn.profile_signals.projects.includes("眼部整形"));
  assert.match(appointmentTurn.reply.text, /周末|到院时间|人工顾问实时确认/);

  const channelMessageReplay = await fetch(`${baseUrl}/v1/conversations/reply`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ channel:"api", conversation_id:"partner-api-1", message:{ id:"partner-msg-1", text:"介绍李健院长个人资料" } })
  });
  assert.equal(channelMessageReplay.status, 200);
  assert.equal((await channelMessageReplay.json()).profile_signals.turn_count, 1, "渠道message.id重放不得重复增加会话轮次");
  const channelMessageConflict = await fetch(`${baseUrl}/v1/conversations/reply`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ channel:"api", conversation_id:"partner-api-1", message:{ id:"partner-msg-1", text:"复用消息ID但内容已经改变" } })
  });
  assert.equal(channelMessageConflict.status, 409);
  assert.equal((await channelMessageConflict.json()).error.code, "CONVERSATION_MESSAGE_ID_REUSED");

  const outbound = formatChannelOutbound("wecom", unifiedBody);
  assert.equal(outbound.msgtype, "text");
  assert.equal(outbound.delivery.delivered, false, "格式化企业微信消息不代表平台已投递");
  assert.equal(outbound.delivery.status, "not_configured");

  const cachedBeforeClaimPayload = { tenant_id:"tenant-test", channel:"api", conversation_id:"handover-flow-1", message:{ id:"cached-before-claim", text:"介绍光子嫩肤" } };
  const cachedBeforeClaimRequest = { method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":"cached-before-handover-claim" }, body:JSON.stringify(cachedBeforeClaimPayload) };
  const beforeClaim = await fetch(`${baseUrl}/v1/conversations/reply`, cachedBeforeClaimRequest);
  assert.equal(beforeClaim.status, 200);
  assert.ok((await beforeClaim.json()).reply.text);
  const handover = await fetch(`${baseUrl}/v1/conversations/reply`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ tenant_id:"tenant-test", channel:"api", conversation_id:"handover-flow-1", message:{ id:"risk-1", text:"我这种情况适不适合做线雕？" } })
  });
  const handoverBody = await handover.json();
  assert.equal(handoverBody.status, "handover_required");
  assert.match(handoverBody.handover.id, /^ho_/);
  assert.match(handoverBody.handover.task_id, /^task_/);

  const handoverList = await fetch(`${baseUrl}/v1/handovers?tenant_id=tenant-test`);
  assert.equal((await handoverList.json()).data.length, 1);
  const anonymousClaim = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/claim`, {
    method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ tenant_id:"tenant-test" })
  });
  assert.equal(anonymousClaim.status, 401, "人工接管必须绑定企业实名身份");
  const outOfDepartmentClaim = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/claim`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-restricted" }, body:JSON.stringify({ tenant_id:"tenant-test" })
  });
  assert.equal(outOfDepartmentClaim.status, 403, "无权科室篡改handoverId不得领取任务");
  assert.equal((await outOfDepartmentClaim.json()).error.code, "HANDOVER_DEPARTMENT_FORBIDDEN");
  const claimed = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/claim`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-test" }, body:JSON.stringify({ tenant_id:"tenant-test" })
  });
  assert.equal(claimed.status, 200);
  const claimedBody = await claimed.json();
  assert.equal(claimedBody.data.ai_suspended, true);
  const replayAfterClaim = await fetch(`${baseUrl}/v1/conversations/reply`, cachedBeforeClaimRequest);
  assert.equal(replayAfterClaim.status, 200);
  assert.equal(replayAfterClaim.headers.get("x-idempotent-replay"), "true");
  const suppressedReplay = await replayAfterClaim.json();
  assert.equal(suppressedReplay.reply.text, "", "Cached AI replies must be suppressed after handover claim");
  assert.equal(suppressedReplay.status, "human_active");
  const sameAssigneeRetry = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/claim`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-test" }, body:JSON.stringify({ tenant_id:"tenant-test" })
  });
  assert.equal(sameAssigneeRetry.status, 200, "同一顾问重复接管必须幂等");
  assert.equal((await sameAssigneeRetry.json()).data.claimed_at, claimedBody.data.claimed_at);
  const competingClaim = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/claim`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-other" }, body:JSON.stringify({ tenant_id:"tenant-test" })
  });
  assert.equal(competingClaim.status, 409, "第二位顾问不得覆盖当前接管人");
  assert.equal((await competingClaim.json()).error.code, "HANDOVER_ALREADY_CLAIMED");
  const duringHuman = await fetch(`${baseUrl}/v1/conversations/reply`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ tenant_id:"tenant-test", channel:"api", conversation_id:"handover-flow-1", message:{ id:"risk-2", text:"还有人在吗？" } })
  });
  const duringHumanBody = await duringHuman.json();
  assert.equal(duringHumanBody.status, "human_active");
  assert.equal(duringHumanBody.delivery.suppress_ai, true);
  assert.equal(duringHumanBody.reply.text, "");
  const handoverEventsAfterFirstInbound = (await getOperationsStoreStatus("tenant-test")).events;
  const duringHumanReplay = await fetch(`${baseUrl}/v1/conversations/reply`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ tenant_id:"tenant-test", channel:"api", conversation_id:"handover-flow-1", message:{ id:"risk-2", text:"还有人在吗？" } })
  });
  assert.equal(duringHumanReplay.status, 200);
  assert.equal((await duringHumanReplay.json()).status, "human_active");
  assert.equal(
    (await getOperationsStoreStatus("tenant-test")).events,
    handoverEventsAfterFirstInbound,
    "人工接管期间相同message.id重放不得重复记录入站事件"
  );
  const duringHumanConflict = await fetch(`${baseUrl}/v1/conversations/reply`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ tenant_id:"tenant-test", channel:"api", conversation_id:"handover-flow-1", message:{ id:"risk-2", text:"复用同一消息ID但内容已经改变" } })
  });
  assert.equal(duringHumanConflict.status, 409);
  assert.equal((await duringHumanConflict.json()).error.code, "CONVERSATION_MESSAGE_ID_REUSED");
  assert.equal(
    (await getOperationsStoreStatus("tenant-test")).events,
    handoverEventsAfterFirstInbound,
    "人工接管期间message.id内容冲突不得写入事件"
  );
  const missingCompletionKey = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/complete`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-test" }, body:JSON.stringify({ tenant_id:"tenant-test", resolution:"不应在缺少幂等键时完结", minutes:4 })
  });
  assert.equal(missingCompletionKey.status, 400, "原子完结必须要求稳定幂等键");
  assert.equal((await missingCompletionKey.json()).error.code, "IDEMPOTENCY_KEY_REQUIRED");
  const mismatchedComplete = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/complete`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-other", "Idempotency-Key":"complete-other-before" }, body:JSON.stringify({ tenant_id:"tenant-test", resolution:"不应成功", minutes:2 })
  });
  assert.equal(mismatchedComplete.status, 409, "只有当前接管顾问可以完成任务");
  assert.equal((await mismatchedComplete.json()).error.code, "HANDOVER_ASSIGNEE_MISMATCH");
  const completionPayload = { tenant_id:"tenant-test", resolution:"已人工说明", minutes:4, notes:"电话跟进" };
  const completed = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/complete`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-test", "Idempotency-Key":"complete-atomic-once" }, body:JSON.stringify(completionPayload)
  });
  assert.equal(completed.status, 200);
  const completedBody = await completed.json();
  assert.equal(completedBody.data.handover.status, "completed");
  assert.equal(completedBody.data.human_work.minutes, 4);
  assert.equal(completedBody.data.human_work.staff_id, "advisor-test");
  assert.equal(completedBody.meta.atomic, true);
  const completedRetry = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/complete`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-test", "Idempotency-Key":"complete-atomic-once" }, body:JSON.stringify(completionPayload)
  });
  assert.equal(completedRetry.status, 200, "当前接管顾问重复完成必须幂等");
  assert.equal(completedRetry.headers.get("x-idempotent-replay"), "true");
  const completionKeyConflict = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/complete`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-test", "Idempotency-Key":"complete-atomic-once" }, body:JSON.stringify({ ...completionPayload, minutes:9 })
  });
  assert.equal(completionKeyConflict.status, 409);
  assert.equal((await completionKeyConflict.json()).error.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
  const completedByOther = await fetch(`${baseUrl}/v1/handovers/${handoverBody.handover.id}/complete`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-other", "Idempotency-Key":"complete-other-after" }, body:JSON.stringify({ tenant_id:"tenant-test", resolution:"不应覆盖", minutes:1 })
  });
  assert.equal(completedByOther.status, 409);
  assert.equal((await completedByOther.json()).error.code, "HANDOVER_ASSIGNEE_MISMATCH");
  const spoofedWork = await fetch(`${baseUrl}/v1/operations/human-work`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-test" }, body:JSON.stringify({ tenant_id:"tenant-test", conversation_id:"handover-flow-1", staff_id:"advisor-other", minutes:6.5 })
  });
  assert.equal(spoofedWork.status, 400, "工时人员不得由正文冒充");
  assert.equal((await spoofedWork.json()).error.code, "OPERATIONS_ACTOR_OVERRIDE_FORBIDDEN");
  const work = await fetch(`${baseUrl}/v1/operations/human-work`, {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer advisor-test" }, body:JSON.stringify({ tenant_id:"tenant-test", conversation_id:"handover-flow-1", handover_id:handoverBody.handover.id, minutes:6.5 })
  });
  assert.equal(work.status, 201);
  assert.equal((await work.clone().json()).data.staff_id, "advisor-test");
  const metrics = await fetch(`${baseUrl}/v1/operations/metrics?tenant_id=tenant-test`);
  const metricsBody = await metrics.json();
  assert.equal(metricsBody.data.human_work_minutes, 10.5, "原子完结工时和后续补充工时均应计量且不得因重试重复");
  assert.equal(metricsBody.data.handovers_completed, 1);
  console.log("✓ 售前智能体独立服务健康检查、统一协议与会话隔离通过");
  console.log("✓ 网页、企业微信和通用API渠道适配、幂等及人工接管闭环通过");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
