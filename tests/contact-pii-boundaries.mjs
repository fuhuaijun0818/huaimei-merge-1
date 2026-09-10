import assert from "node:assert/strict";

process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_PERSISTENCE_BACKEND = "local_json";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
process.env.HUAMEI_LEAD_STORE_FILE = ":memory:";
process.env.HUAMEI_IDENTITY_PEPPER = "contact_pii_identity_P9o7I5u3Y1t8R6e4W2q0";

const formatted = "+86 138 7654 3210";
const hyphenated = "138-7654-3210";
const parenthesized = "(138)76543210";

const operations = await import(`../server/acquisition-operations-store.mjs?contact-pii=${Date.now()}`);
operations.resetOperationsStoreForTest();
const handover = operations.ensureHandoverTask({
  envelope:{
    tenant_id:"huamei-shanghai",
    channel:"web",
    conversation_id:"contact-pii-handover",
    actor:{ external_user_id:"web-user", customer_id:null },
    message:{ id:"contact-pii-message", text:`请转人工，电话${hyphenated}` }
  },
  result:{ status:"handover_required", handover:{ required:true, reason:"human_requested", to_team:"人工咨询" } },
  session_snapshot:{ conversation_summary:"", known_slots:{}, projects:[] }
});
assert.equal(handover.summary, "请转人工，电话138****3210");
assert.equal(JSON.stringify(operations.listHandovers({ tenant_id:"huamei-shanghai" })).includes(hyphenated), false);

const leadStore = await import(`../server/lead-store.mjs?contact-pii=${Date.now()}`);
leadStore.resetLeadStoreForTest();
const tenantId = "huamei-shanghai";
const sessionId = "contact-pii-lead";
const mobile = "13876543210";
const captured = await leadStore.upsertAcquisitionLead({
  tenant_id:tenantId,
  session_id:sessionId,
  mobile,
  service_consent:true,
  name:`客户 ${parenthesized}`,
  interests:[`咨询 ${hyphenated}`],
  messages:[{ role:"user", content:`也可以回拨${formatted}` }]
});
const ordinaryLeadJson = JSON.stringify(captured.lead);
for (const raw of [mobile, formatted, hyphenated, parenthesized]) {
  assert.equal(ordinaryLeadJson.includes(raw), false, `普通lead/profile残留联系方式: ${raw}`);
}
assert.match(ordinaryLeadJson, /138\*{4}3210/);

const { normalizePrivacyRequestScope } = await import("../server/persistence/postgres-privacy-request-store.mjs");
const privacyScope = normalizePrivacyRequestScope({
  categories:[`更正 ${parenthesized}`],
  correction_fields:[`电话 ${hyphenated}`],
  note:`请联系${formatted}`
});
assert.equal(JSON.stringify(privacyScope).includes(mobile), false);
assert.match(privacyScope.note, /\[mobile-redacted\]/);

const sessionStore = await import(`../server/acquisition-session.mjs?contact-pii=${Date.now()}`);
sessionStore.resetAcquisitionSessionsForTest();
const conversationSessionId = "contact-pii-session";
sessionStore.prepareAcquisitionSessionContext(
  conversationSessionId,
  `我的电话是${formatted}`,
  [`胸部咨询 ${formatted}`]
);
sessionStore.recordAcquisitionSessionTurn(conversationSessionId, {
  message:`我的电话是${formatted}`,
  projects:[`项目补充 ${hyphenated}`],
  result:{
    status:"completed",
    output:{
      message:`顾问会回拨${parenthesized}`,
      structured_data:{ intent:"project_consult", intent_analysis:{ entities:{} } }
    }
  }
});
const sessionContext = sessionStore.prepareAcquisitionSessionContext(conversationSessionId, "继续咨询");
for (const raw of [formatted, hyphenated, parenthesized]) {
  assert.equal(JSON.stringify(sessionContext).includes(raw), false, `会话turn/summary残留联系方式: ${raw}`);
}
assert.match(JSON.stringify(sessionContext), /138\*{4}3210/);
await sessionStore.flushAcquisitionSessions();

const {
  sanitizeConversationMessageForPersistence,
  sanitizeConversationSessionStateForPersistence
} = await import("../server/persistence/postgres-session-store.mjs");
assert.equal(sanitizeConversationMessageForPersistence(`入站${formatted}`), "入站138****3210");
assert.deepEqual(sanitizeConversationSessionStateForPersistence({
  turns:[{ role:"user", content:`号码${hyphenated}` }],
  conversation_summary:`回拨${parenthesized}`
}), {
  turns:[{ role:"user", content:"号码138****3210" }],
  conversation_summary:"回拨138****3210"
});

const { appendAuditEvent, appendOutboxEvent } = await import("../server/persistence/postgres-helpers.mjs");
let auditValues = null;
await appendAuditEvent({
  query:async (_sql, values) => { auditValues = values; return { rowCount:1, rows:[] }; }
}, {
  tenantId,
  action:"contact.pii.boundary_test",
  resourceType:"handover",
  resourceId:`resource-${hyphenated}`,
  actorId:`actor-${parenthesized}`,
  requestId:`request-${formatted}`,
  details:{ summary:`请回拨${formatted}`, nested:{ note:hyphenated } }
});
assert.ok(auditValues);
assert.equal(JSON.stringify(auditValues).includes(mobile), false);
assert.equal(JSON.stringify(auditValues).includes(hyphenated), false);
assert.equal(JSON.stringify(auditValues).includes(parenthesized), false);
assert.match(String(auditValues[10]), /mobile-redacted/);

let outboxValues = null;
const encryptedEnvelope = {
  _encrypted:"huamei.field.a256gcm.v2",
  ciphertext:"opaque-138-7654-3210",
  iv:"opaque",
  tag:"opaque"
};
await appendOutboxEvent({
  query:async (_sql, values) => { outboxValues = values; return { rowCount:1, rows:[] }; }
}, {
  tenantId,
  aggregateType:"contact_pii_test",
  aggregateId:"outbox-test",
  eventType:"contact.pii.tested",
  payload:{ note:`回拨${formatted}`, encrypted:encryptedEnvelope },
  headers:{ subject:`客户${hyphenated}` }
});
const storedOutboxPayload = JSON.parse(outboxValues[5]);
const storedOutboxHeaders = JSON.parse(outboxValues[6]);
assert.equal(storedOutboxPayload.note, "回拨[mobile-redacted]");
assert.equal(storedOutboxHeaders.subject, "客户[mobile-redacted]");
assert.deepEqual(storedOutboxPayload.encrypted, encryptedEnvelope, "显式密文信封不得被PII清洗破坏");

const { redactForLog } = await import("../server/observability/index.mjs");
const logRecord = redactForLog({
  safe_error:new Error(`供应商失败，号码${formatted}`),
  detail:`备用${hyphenated}`
});
assert.equal(JSON.stringify(logRecord).includes(mobile), false);
assert.match(JSON.stringify(logRecord), /REDACTED_PHONE/);

console.log("✓ handover、lead/profile、会话、隐私、审计、outbox及错误日志联系方式旁路已关闭");
