// B-020 / B-021 / B-022 查重适配器四态验收（本地真实 HTTP 模拟院方接口，不连真实院方、不使用真实密钥）。
// 用法：node handoff/tool-b-repeatcheck-acceptance.mjs
// 结论写入 handoff/evidence-b020/b020-b022-acceptance-report.json。
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_PERSISTENCE_BACKEND = "local_json";
process.env.HUAMEI_LEAD_STORE_FILE = ":memory:";
process.env.HUAMEI_IDENTITY_PEPPER = "fixture-member-identity-A1b2C3d4E5f6";
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = join(root, "handoff", "evidence-b020");
mkdirSync(OUT, { recursive:true });

const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const { createMemberRepeatCheckClient, memberRepeatCheckConfiguration } = await load("server/integrations/member-repeatcheck-client.mjs");
const { memberCheckPresentation } = await load("src/member-check-display.js");
const { createStructuredLogger } = await load("server/observability/index.mjs");
const { upsertAcquisitionLead, acquisitionCustomerSnapshot, resetLeadStoreForTest } = await load("server/lead-store.mjs");

const phone = "13600000001";
const otherPhone = "13600000002";
const tenant = "huamei-shanghai";
const fixtureSecret = "fixture-signing-secret-not-a-real-key";
const fixtureAkey = "fixture-only-adapter-key-A1b2C3d4E5f6";
const checks = [];
const record = (id, name, detail) => { checks.push({ id, name, detail }); console.log(`  ✓ ${id} ${name}`); };

// ---------------------------------------------------------------- mock 院方接口
const requests = [];
let behavior = "repeat_true";
const provider = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    requests.push({ url:request.url, method:request.method, headers:request.headers, body, parsed });
    const json = (status, payload) => {
      response.writeHead(status, { "Content-Type":"application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    };
    if (behavior === "timeout") { setTimeout(() => json(200, { isSuccess:true, data:[{ phone, isRepeat:true }] }), 400); return; }
    if (behavior === "http_500") { response.writeHead(500, { "Content-Type":"text/plain" }); response.end("provider failure"); return; }
    if (behavior === "html_error") { response.writeHead(200, { "Content-Type":"text/html" }); response.end("<html><body>502 Bad Gateway</body></html>"); return; }
    if (behavior === "oversize") { json(200, { isSuccess:true, data:[{ phone, isRepeat:true }], pad:"x".repeat(20 * 1024) }); return; }
    if (behavior === "business_false") { json(200, { isSuccess:false, message:"查重失败" }); return; }
    if (behavior === "missing_data") { json(200, { isSuccess:true, message:"查重成功" }); return; }
    if (behavior === "wrong_phone") { json(200, { isSuccess:true, data:[{ phone:otherPhone, isRepeat:true }] }); return; }
    if (behavior === "illegal_type") { json(200, { isSuccess:true, data:[{ phone, isRepeat:"false" }] }); return; }
    // 正常查重必须回显本次请求的号码，否则适配器按错号处理。
    if (behavior === "repeat_true") { json(200, { isSuccess:true, message:"查重成功", data:[{ phone:parsed?.phone?.[0] || phone, isRepeat:true }] }); return; }
    json(200, { isSuccess:true, message:"查重成功", data:[{ phone:parsed?.phone?.[0] || phone, isRepeat:false }] });
  });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}/query`;

const env = {
  ...process.env,
  HUAMEI_MEMBER_CHECK_ENABLED:"true",
  HUAMEI_MEMBER_CHECK_AUTH_MODE:"md5",
  HUAMEI_MEMBER_CHECK_SECRET:fixtureSecret,
  HUAMEI_MEMBER_CHECK_URL:providerUrl,
  HUAMEI_MEMBER_CHECK_HTTP_METHOD:"POST",
  HUAMEI_MEMBER_CHECK_TENANT_ID:tenant,
  HUAMEI_MEMBER_CHECK_AKEY:fixtureAkey,
  HUAMEI_MEMBER_CHECK_TOKEN:"",
  HUAMEI_MEMBER_CHECK_OPERATION:"read_only",
  HUAMEI_MEMBER_CHECK_RESULT_SEMANTICS:"duplicate_only",
  HUAMEI_MEMBER_CHECK_TIMEOUT_MS:"120",
  HUAMEI_MEMBER_CHECK_CACHE_MS:"0",
  HUAMEI_MEMBER_CHECK_MAX_ATTEMPTS:"2",
  HUAMEI_MEMBER_CHECK_HOSPITAL:"虚构测试医院",
  HUAMEI_MEMBER_CHECK_HOSPITAL_CODE:"FIXTURE-01"
};
const identity = (mobile, tenantId = tenant) => createHmac("sha256", env.HUAMEI_IDENTITY_PEPPER).update(`${tenantId}:${mobile}`).digest("hex");
const checkRequest = (sessionId = "member-acceptance", mobile = phone, tenantId = tenant) => {
  const subjectReferenceHmac = identity(mobile, tenantId);
  return { tenantId, sessionId, mobile, subjectReferenceHmac,
    verification:{ schema:"huamei.contact-capture.v1", verified:false, status:"pending_manual",
      method:"format_validation", tenant_id:tenantId, subject_reference_hmac:subjectReferenceHmac,
      session_id:sessionId, verification_id:`format-${sessionId}`, captured_at:new Date().toISOString() }
  };
};

const auditLines = [];
const logger = createStructuredLogger({ service:"member-check-acceptance", environment:"development",
  secrets:[fixtureSecret, fixtureAkey], write:(line) => auditLines.push(line) });
const clientFor = (overrides = {}) => createMemberRepeatCheckClient({ env:{ ...env, ...overrides }, logger });

console.log("== B-020 查重结果语义与页面展示 ==");
assert.equal(memberRepeatCheckConfiguration(env).ready, true, "本机模拟院方接口必须视为已配置");
behavior = "repeat_true";
const repeatTrue = await clientFor().check(checkRequest());
assert.equal(repeatTrue.status, "checked");
assert.equal(repeatTrue.is_repeat, true);
assert.equal(memberCheckPresentation(repeatTrue).label, "院方已有客户记录");
record("B-020-AC1", "严格布尔 true 显示已有客户记录", { status:repeatTrue.status, label:memberCheckPresentation(repeatTrue).label });

behavior = "repeat_false";
const repeatFalse = await clientFor().check(checkRequest("member-false"));
assert.equal(repeatFalse.status, "checked");
assert.equal(repeatFalse.is_repeat, false);
assert.equal(memberCheckPresentation(repeatFalse).label, "院方未找到客户记录");
record("B-020-AC2", "严格布尔 false 显示未找到客户记录", { status:repeatFalse.status, label:memberCheckPresentation(repeatFalse).label });

// 四态：已有 / 未找到 / 待查 / 失败，必须互相区分，且失败不得落成"未找到"。
const notQueried = { schema:"huamei.member-repeatcheck.v1", status:"pending", is_repeat:null, checked_at:null };
const fourStates = {
  已有记录:memberCheckPresentation(repeatTrue).label,
  未找到:memberCheckPresentation(repeatFalse).label,
  待查:memberCheckPresentation(notQueried).label,
  失败:memberCheckPresentation({ ...repeatTrue, status:"failed", is_repeat:null, reason_code:"PROVIDER_UNAVAILABLE" }).label
};
assert.equal(new Set(Object.values(fourStates)).size, 4, `四态展示必须互不相同：${JSON.stringify(fourStates)}`);
assert.notEqual(fourStates.失败, fourStates.未找到);
record("B-020-AC3", "四态展示互不相同（已有/未找到/待查/失败）", fourStates);

const illegalCases = [];
for (const [name, mode, expectedCode] of [
  ["业务失败 isSuccess=false", "business_false", "PROVIDER_REJECTED"],
  ["data 缺项", "missing_data", "INVALID_RESPONSE"],
  ["返回错号", "wrong_phone", "INVALID_RESPONSE"],
  ["isRepeat 非法类型（字符串 false）", "illegal_type", "INVALID_RESPONSE"],
  ["HTTP 错误页", "html_error", "INVALID_RESPONSE"],
  ["超大响应体", "oversize", "INVALID_RESPONSE"]
]) {
  behavior = mode;
  const outcome = await clientFor().check(checkRequest(`member-invalid-${mode}`));
  assert.equal(outcome.status, "failed", `${name} 不得判为已核验`);
  assert.equal(outcome.is_repeat, null, `${name} 不得给出布尔结论`);
  assert.equal(outcome.reason_code, expectedCode, `${name} 归类必须为 ${expectedCode}`);
  assert.notEqual(memberCheckPresentation(outcome).label, "院方未找到客户记录", `${name} 不得显示为未找到`);
  illegalCases.push({ case:name, reason_code:outcome.reason_code, label:memberCheckPresentation(outcome).label });
}
record("B-020-AC3", "isSuccess 失败、缺项、错号、非法类型都不能当 false", illegalCases);

for (const [state, value] of [["true", repeatTrue], ["false", repeatFalse]]) {
  const label = memberCheckPresentation(value).label;
  assert.doesNotMatch(label, /会员|权益|归属已验证|实名/, `${state} 标签不得声称会员权益或号码归属`);
  assert.equal(value.member_status, "unknown", "duplicate_only 语义下会员身份必须保持未知");
}
assert.match(JSON.stringify(repeatTrue), /"result_semantics":"duplicate_only"/);
record("B-020-AC4", "不将已有记录称为手机号归属已验证或拥有某会员权益", { labels:[memberCheckPresentation(repeatTrue).label, memberCheckPresentation(repeatFalse).label], member_status:repeatTrue.member_status });

console.log("== B-021 查询失败重试与过期结果 ==");
behavior = "timeout";
const timedOut = await clientFor().check(checkRequest("member-timeout"));
const timeoutLabel = memberCheckPresentation(timedOut).label;
assert.equal(timedOut.status, "failed");
assert.equal(timedOut.reason_code, "TIMEOUT");
assert.match(timeoutLabel, /超时/);
record("B-021-AC1", "失败、超时、未查询、查询中和已完成分别表示", {
  失败:fourStates.失败, 超时:timeoutLabel,
  未查询:memberCheckPresentation({ schema:"huamei.member-repeatcheck.v1", status:"pending", is_repeat:null }).label,
  已完成:fourStates.已有记录
});

behavior = "http_500";
let retryNow = 1_700_000_000_000;
let retryCalls = 0;
const retryClient = createMemberRepeatCheckClient({ env, logger, now:() => retryNow,
  fetchImpl:async (url, options) => { retryCalls += 1; return fetch(url, options); } });
const retryRequest = checkRequest("member-retry");
const retryOne = await retryClient.check(retryRequest);
assert.equal(retryOne.reason_code, "PROVIDER_UNAVAILABLE");
assert.equal(retryOne.retry_count, 1);
retryNow += 500;
const retryTwo = await retryClient.check({ ...retryRequest, previous:retryOne });
assert.equal(retryTwo.retry_count, 2);
retryNow += 1_000;
const retryThree = await retryClient.check({ ...retryRequest, previous:retryTwo });
assert.equal(retryThree.reason_code, "RETRY_EXHAUSTED");
assert.equal(retryThree.retry_count, 2, "达到上限后不得继续累加");
assert.equal(retryCalls, 2, "达到上限后不得继续调用院方接口");
assert.match(memberCheckPresentation(retryThree).label, /重试上限/);
record("B-021-AC2", "重试受限且可观察，不无限调用", { provider_calls:retryCalls, retry_count:retryThree.retry_count, label:memberCheckPresentation(retryThree).label });

behavior = "repeat_true";
const staleResult = await clientFor().check(checkRequest("member-stale", phone));
assert.equal(staleResult.is_repeat, true);
behavior = "repeat_false";
const rotatedResult = await clientFor().check({ ...checkRequest("member-stale", otherPhone), previous:staleResult });
assert.equal(rotatedResult.is_repeat, false, "旧号码结果不得覆盖新号码查询结论");
assert.notEqual(memberCheckPresentation(rotatedResult).label, memberCheckPresentation(staleResult).label);
record("B-021-AC3", "旧号码或旧版本结果不能覆盖当前客户状态", {
  旧号码结论:memberCheckPresentation(staleResult).label, 当前号码结论:memberCheckPresentation(rotatedResult).label
});

resetLeadStoreForTest();
behavior = "http_500";
const capture = await upsertAcquisitionLead({ tenant_id:tenant, session_id:"member-acceptance-lead",
  mobile:phone, service_consent:true, name:"虚构验收客户" }, { memberCheckClient:clientFor() });
assert.equal(capture.verification_status, "pending_manual", "院方不可用不得阻断留资");
assert.equal(capture.lead.customer.memberCheck.status, "failed");
behavior = "repeat_true";
// 退避窗口内的重查必须被挡住：既不能重复调用院方，也不能重置失败预算。
const blockedRecheck = await clientFor().check({ ...checkRequest("member-acceptance-lead"), previous:capture.lead.customer.memberCheck, forceRefresh:true });
assert.equal(blockedRecheck.status, "failed");
assert.equal(blockedRecheck.reason_code, capture.lead.customer.memberCheck.reason_code, "退避期内必须沿用上一次的失败结论");
// 退避窗口结束后，人工重查（更大额度）必须能恢复成"已核验"。
const retryAtMs = Date.parse(capture.lead.customer.memberCheck.next_retry_at || "") || Date.now();
const recheck = await createMemberRepeatCheckClient({ env:{ ...env, HUAMEI_MEMBER_CHECK_MAX_ATTEMPTS:"5" }, logger, now:() => retryAtMs + 1_000 })
  .check({ ...checkRequest("member-acceptance-lead"), previous:capture.lead.customer.memberCheck, forceRefresh:true });
assert.equal(recheck.status, "checked", `人工重查应恢复已核验状态，实际 reason_code=${recheck.reason_code}`);
assert.equal(recheck.is_repeat, true);
assert.equal((await acquisitionCustomerSnapshot(tenant)).customers.length, 1);
record("B-021-AC4", "失败不丢失留资和会话，可按权限手动重查", {
  留资状态:capture.verification_status, 失败后:capture.lead.customer.memberCheck.status,
  手动重查:memberCheckPresentation(recheck).label
});

console.log("== B-022 院方接口最小数据与异常契约 ==");
behavior = "http_500";
const unavailable = await clientFor().check(checkRequest("member-unavailable"));
behavior = "html_error";
const badJson = await clientFor().check(checkRequest("member-json"));
behavior = "timeout";
const timeoutAgain = await clientFor().check(checkRequest("member-timeout-2"));
behavior = "business_false";
const businessFail = await clientFor().check(checkRequest("member-business"));
const anomaly = { 超时:timeoutAgain.reason_code, HTTP失败:unavailable.reason_code, JSON错误:badJson.reason_code, 业务失败:businessFail.reason_code };
assert.equal(new Set(Object.values(anomaly)).size, 4, `四类异常必须互不混同：${JSON.stringify(anomaly)}`);
assert.equal(anomaly.业务失败, "PROVIDER_REJECTED");
assert.equal(anomaly.超时, "TIMEOUT");
record("B-022-AC1", "超时、HTTP失败、JSON错误、业务失败分别归类", anomaly);

// 合同允许的字段白名单；调用方多传的字段必须被丢弃。
behavior = "repeat_true";
await clientFor().check({ ...checkRequest("member-payload"), name:"虚构验收客户", photo:"should-not-be-sent", id_card:"should-not-be-sent" });
const sentBody = requests.at(-1).parsed;
const allowlist = ["date_time", "hospital", "hospitalcode", "name", "phone", "timestamp"];
const unexpected = Object.keys(sentBody).filter((key) => !allowlist.includes(key));
assert.deepEqual(unexpected, [], `载荷出现合同外字段：${JSON.stringify(unexpected)}`);
assert.deepEqual(sentBody.phone, [phone]);
for (const forbidden of ["photo", "id_card", "mobile", "member_status", "subject_reference_hmac", "mainwechat"]) {
  assert.equal(Object.hasOwn(sentBody, forbidden), false, `载荷不得包含 ${forbidden}`);
}
record("B-022-AC2", "只发送合同必需字段，缺失字段不伪造示例值", { fields:Object.keys(sentBody).sort(), phone_field:sentBody.phone });

const auditRecords = auditLines.map((line) => { try { return JSON.parse(line); } catch { return { raw:line }; } });
assert.ok(auditRecords.length > 0, "必须产生适配器审计日志");
const sampleAudit = auditRecords.find((entry) => typeof entry.duration_ms === "number");
assert.ok(sampleAudit, "审计日志必须记录耗时");
assert.ok(String(sampleAudit.request_id || "").length > 0, "日志必须包含请求标识");
for (const forbidden of [phone, fixtureAkey, fixtureSecret]) {
  assert.equal(JSON.stringify(auditLines).includes(forbidden), false, `日志不得出现明文 ${forbidden.slice(0, 6)}…`);
}
record("B-022-AC3", "日志包含请求标识和耗时，不输出明文电话或凭据", { request_id:sampleAudit.request_id, duration_ms:sampleAudit.duration_ms, audit_lines:auditLines.length });

behavior = "repeat_false";
const hostOverride = await clientFor().check({ ...checkRequest("member-host"), providerUrl:"http://127.0.0.1:1/evil", url:"http://127.0.0.1:1/evil", endpoint:"http://127.0.0.1:1/evil" });
assert.equal(hostOverride.status, "checked");
assert.equal(requests.at(-1).url, "/query", "目标地址必须来自服务端配置，调用方传入的地址不得生效");
record("B-022-AC4", "接口地址和配置由服务端管理，前端不能指定任意目标", { actual_url:requests.at(-1).url, configured_url:providerUrl });

provider.close();
const report = {
  generated_at:new Date().toISOString(),
  scope:"B-020 / B-021 / B-022 查重适配器四态验收（本地模拟院方接口，真实 HTTP 传输）",
  transport:"http://127.0.0.1 本地 mock provider（不连真实院方，无真实密钥）",
  mock_provider_calls:requests.length,
  checks
};
writeFileSync(join(OUT, "b020-b022-acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\nPASS：B-020/B-021/B-022 共 ${checks.length} 项验收检查通过；证据写入 handoff/evidence-b020/`);
