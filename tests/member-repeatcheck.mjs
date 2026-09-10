import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createMemberRepeatCheckClient, memberRepeatCheckConfiguration } from "../server/integrations/member-repeatcheck-client.mjs";
import { memberCheckPresentation } from "../src/member-check-display.js";
import { redactForLog } from "../server/observability/redaction.mjs";
import { memberRepeatCheckSigner, memberRepeatCheckSigningConfigured } from "../server/integrations/member-repeatcheck-signing.mjs";

process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_PERSISTENCE_BACKEND = "local_json";
process.env.HUAMEI_LEAD_STORE_FILE = ":memory:";
process.env.HUAMEI_IDENTITY_PEPPER = "fixture-member-identity-A1b2C3d4E5f6";
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

const phone = "13600000001";
const tenant = "huamei-shanghai";
const env = {
  ...process.env, HUAMEI_MEMBER_CHECK_ENABLED:"true",
  HUAMEI_MEMBER_CHECK_AUTH_MODE:"md5", HUAMEI_MEMBER_CHECK_SECRET:"",
  HUAMEI_MEMBER_CHECK_URL:"https://member-provider.invalid/query",
  HUAMEI_MEMBER_CHECK_HTTP_METHOD:"POST", HUAMEI_MEMBER_CHECK_TENANT_ID:tenant,
  HUAMEI_MEMBER_CHECK_AKEY:"fixture-only-adapter-key-A1b2C3d4E5f6",
  HUAMEI_MEMBER_CHECK_TOKEN:"", HUAMEI_MEMBER_CHECK_OPERATION:"read_only",
  HUAMEI_MEMBER_CHECK_RESULT_SEMANTICS:"duplicate_only", HUAMEI_MEMBER_CHECK_TIMEOUT_MS:"100",
  HUAMEI_MEMBER_CHECK_HOSPITAL:"虚构测试医院", HUAMEI_MEMBER_CHECK_HOSPITAL_CODE:"FIXTURE-01"
};
const identity = (mobile, tenantId = tenant) => createHmac("sha256", env.HUAMEI_IDENTITY_PEPPER).update(`${tenantId}:${mobile}`).digest("hex");
const request = (sessionId = "member-fixture", tenantId = tenant, mobile = phone) => {
  const subjectReferenceHmac = identity(mobile, tenantId);
  return { tenantId, sessionId, mobile, subjectReferenceHmac,
    verification:{
      schema:"huamei.contact-capture.v1", verified:false, status:"pending_manual",
      method:"format_validation", tenant_id:tenantId,
      subject_reference_hmac:subjectReferenceHmac, session_id:sessionId,
      verification_id:`format-${sessionId}`, captured_at:new Date().toISOString()
    } };
};
const response = (isRepeat = false, overrides = {}) => Response.json({
  isSuccess:true, message:"查重成功", data:[{ phone, isRepeat }], ...overrides
});
// A test-only arbitrary signer checks the transport contract, not provider auth.
const signer = async () => "fixture-signature";
assert.equal(memberRepeatCheckConfiguration(env).ready, false, "the supplied akey does not replace the separate signing secret");
assert.ok(memberRepeatCheckConfiguration(env).missing.includes("signing_secret"));
const signingEnv = { ...env, HUAMEI_MEMBER_CHECK_SECRET:"fixture-secret" };
const signatureInput = { akey:"fixture-akey", method:"meb.sync.client.repeatcheck", timestamp:"1767423226", token:"", nonce:"123456" };
assert.equal(memberRepeatCheckSigningConfigured(signingEnv), true);
assert.equal(memberRepeatCheckSigner(signatureInput, { env:signingEnv }), "d39a98e94565011dd35388f020250e4a", "fixed cross-language fixture covers exact order and empty token=");
assert.match(memberRepeatCheckSigner({ ...signatureInput, nonce:"654321" }, { env:signingEnv }), /^[a-f0-9]{32}$/);
assert.notEqual(memberRepeatCheckSigner({ ...signatureInput, nonce:"654321" }, { env:signingEnv }), "d39a98e94565011dd35388f020250e4a");
assert.throws(() => memberRepeatCheckSigner(signatureInput, { env }), (error) => error.code === "SIGNATURE_UNAVAILABLE");
assert.throws(() => memberRepeatCheckSigner({ ...signatureInput, nonce:"x".repeat(33) }, { env:signingEnv }), (error) => error.code === "SIGNATURE_UNAVAILABLE");
assert.throws(() => memberRepeatCheckSigner({ ...signatureInput, method:"x&secret=y" }, { env:signingEnv }), (error) => error.code === "SIGNATURE_UNAVAILABLE");
let defaultSignedRequest;
const signedClient = createMemberRepeatCheckClient({ env:signingEnv, fetchImpl:async (_url, options) => {
  defaultSignedRequest = options;
  return response(false);
} });
assert.equal(signedClient.config.ready, true);
assert.equal((await signedClient.check(request())).status, "checked");
assert.equal(defaultSignedRequest.headers.sign, memberRepeatCheckSigner(defaultSignedRequest.headers, { env:signingEnv }));
assert.doesNotMatch(JSON.stringify(defaultSignedRequest), /fixture-secret/);
for (const override of [
  { HUAMEI_MEMBER_CHECK_URL:"" }, { HUAMEI_MEMBER_CHECK_AKEY:"" },
  { HUAMEI_MEMBER_CHECK_OPERATION:"sync" }, { HUAMEI_MEMBER_CHECK_HTTP_METHOD:"" },
  { HUAMEI_MEMBER_CHECK_TENANT_ID:"" }, { HUAMEI_MEMBER_CHECK_RESULT_SEMANTICS:"" },
  { HUAMEI_RUNTIME_ENV:"production", HUAMEI_MEMBER_CHECK_URL:"http://127.0.0.1/query" }
]) assert.equal(memberRepeatCheckConfiguration({ ...env, ...override }, signer).ready, false);

// An explicit development compatibility mode can reuse operator-provided headers.
// All credentials here are fixtures and the transport is always mocked.
const providedEnv = { ...env,
  HUAMEI_MEMBER_CHECK_AUTH_MODE:"provided_headers",
  HUAMEI_MEMBER_CHECK_URL:"https://scrm.shhmwz.cn/api/thirdApi/checkPhoneExists",
  HUAMEI_MEMBER_CHECK_PROVIDED_TIMESTAMP:"1767423226",
  HUAMEI_MEMBER_CHECK_PROVIDED_NONCE:"fixture123456",
  HUAMEI_MEMBER_CHECK_PROVIDED_SIGN:"0123456789abcdef0123456789abcdef"
};
let providedCalls = 0;
const providedTransport = async (url, options) => {
  providedCalls += 1;
  assert.equal(url, providedEnv.HUAMEI_MEMBER_CHECK_URL);
  assert.equal(options.headers.timestamp, providedEnv.HUAMEI_MEMBER_CHECK_PROVIDED_TIMESTAMP);
  assert.equal(options.headers.nonce, providedEnv.HUAMEI_MEMBER_CHECK_PROVIDED_NONCE);
  assert.equal(options.headers.sign, providedEnv.HUAMEI_MEMBER_CHECK_PROVIDED_SIGN);
  assert.equal(options.headers.token, "");
  assert.deepEqual(JSON.parse(options.body), { phone:[phone], timestamp:providedEnv.HUAMEI_MEMBER_CHECK_PROVIDED_TIMESTAMP });
  return response(false);
};
const provided = createMemberRepeatCheckClient({ env:providedEnv,
  signRequest:() => assert.fail("provided headers must not invoke the MD5 signer"), fetchImpl:providedTransport });
assert.equal(provided.config.ready, true);
const providedResult = await provided.check({ ...request(), name:"must not be sent" });
assert.equal(providedResult.status, "checked");
assert.equal(providedResult.auth_mode, "provided_headers");
assert.equal(providedResult.member_status, "unknown");
assert.doesNotMatch(JSON.stringify(providedResult), /0123456789abcdef|fixture123456|1767423226|13600000001/);
await provided.check({ ...request(), previous:providedResult });
assert.equal(providedCalls, 1);
const noCache = createMemberRepeatCheckClient({ env:{ ...providedEnv, HUAMEI_MEMBER_CHECK_CACHE_MS:"0" }, fetchImpl:providedTransport });
await noCache.check({ ...request(), previous:providedResult });
assert.equal(providedCalls, 2, "zero cache duration must force a fresh check");
for (const override of [
  { HUAMEI_RUNTIME_ENV:"production" }, { NODE_ENV:"production" }, { HUAMEI_RUNTIME_ENV:"staging" },
  { HUAMEI_MEMBER_CHECK_AUTH_MODE:"unknown" }, { HUAMEI_MEMBER_CHECK_URL:"https://wrong-provider.invalid/query" },
  { HUAMEI_MEMBER_CHECK_PROVIDED_TIMESTAMP:"" }, { HUAMEI_MEMBER_CHECK_PROVIDED_NONCE:"" },
  { HUAMEI_MEMBER_CHECK_PROVIDED_SIGN:"" }, { HUAMEI_MEMBER_CHECK_PROVIDED_SIGN:"invalid\r\nheader" },
  { HUAMEI_MEMBER_CHECK_TOKEN:"unexpected-token" }
]) {
  const blocked = createMemberRepeatCheckClient({ env:{ ...providedEnv, ...override }, fetchImpl:() => assert.fail("invalid provided headers configuration must not send") });
  assert.equal(blocked.config.ready, false);
  assert.equal((await blocked.check(request())).status, "not_configured");
}
const expiredHeaders = await createMemberRepeatCheckClient({ env:providedEnv, fetchImpl:async () => response(false, { isSuccess:false, message:"签名验证失败" }) }).check(request());
assert.equal(expiredHeaders.status, "failed");
assert.equal(expiredHeaders.reason_code, "PROVIDER_REJECTED");
assert.equal(expiredHeaders.is_repeat, null);
assert.equal(expiredHeaders.member_status, "unknown");
let rotatedCalls = 0;
await createMemberRepeatCheckClient({ env:{ ...providedEnv, HUAMEI_MEMBER_CHECK_PROVIDED_SIGN:"abcdef0123456789abcdef0123456789" },
  fetchImpl:async () => { rotatedCalls += 1; return response(false); }
}).check({ ...request(), previous:providedResult });
assert.equal(rotatedCalls, 1, "rotating credentials invalidates a cached result");

let calls = [];
let signed = [];
let at = Date.now();
const client = createMemberRepeatCheckClient({ env, now:() => at,
  signRequest:async (input) => { signed.push(input); return "fixture-signature"; },
  fetchImpl:async (url, options) => { calls.push({ url, ...options }); return response(false); }
});
assert.equal((await client.check({ ...request(), verification:{ verified:true } })).status, "capture_required");
assert.equal((await client.check({ ...request(), mobile:"13600000002" })).status, "capture_required", "capture binding must match the actually queried phone");
assert.equal((await client.check(request("other-tenant", "other-tenant"))).status, "not_configured");
assert.equal(calls.length, 0);
const first = await client.check({ ...request(), name:"虚构测试客户" });
assert.equal(first.status, "checked");
assert.equal(first.is_repeat, false);
assert.equal(first.member_status, "unknown", "duplicate false is not membership false without confirmed semantics");
assert.equal(calls.length, 1);
const sent = calls[0];
assert.equal(sent.method, "POST");
assert.equal(sent.redirect, "error");
assert.equal(sent.headers.method, "meb.sync.client.repeatcheck");
assert.equal(sent.headers.akey, env.HUAMEI_MEMBER_CHECK_AKEY);
assert.equal(sent.headers.timestamp, String(Math.floor(at / 1000)));
assert.match(sent.headers.nonce, /^[a-f0-9]{32}$/);
assert.equal(sent.body, signed[0].bodyText);
assert.deepEqual(JSON.parse(sent.body).phone, [phone]);
assert.equal(JSON.parse(sent.body).timestamp, sent.headers.timestamp);
assert.equal(JSON.parse(sent.body).hospitalcode, "FIXTURE-01");
assert.equal(Object.hasOwn(JSON.parse(sent.body), "mainwechat"), false);
assert.doesNotMatch(JSON.stringify(first), /13600000001|fixture-only-adapter-key|fixture-signature/);
await client.check({ ...request(), previous:first });
assert.equal(calls.length, 1, "a recent persisted result avoids repeated provider calls");
at += 61_000;
await client.check({ ...request(), previous:first });
assert.equal(calls.length, 2);
assert.notEqual(calls[0].headers.nonce, calls[1].headers.nonce);
assert.notEqual(calls[0].headers.timestamp, calls[1].headers.timestamp);

for (const matched of [true, false]) {
  const membership = createMemberRepeatCheckClient({ env:{ ...env, HUAMEI_MEMBER_CHECK_RESULT_SEMANTICS:"membership" }, signRequest:signer, fetchImpl:async () => response(matched) });
  const value = await membership.check(request());
  assert.equal(value.member_status, matched ? "member" : "non_member");
  assert.match(memberCheckPresentation(value).label, matched ? /^已核验：会员$/ : /^已核验：非会员$/);
}
const invalidResults = [
  { isSuccess:false }, { isSuccess:"true" }, { data:[] },
  { data:[{ phone:"13600000002", isRepeat:true }] },
  { data:[{ phone, isRepeat:"false" }] },
  { data:[{ phone, isRepeat:false }, { phone, isRepeat:true }] }
];
for (const overrides of invalidResults) {
  const invalid = createMemberRepeatCheckClient({ env, signRequest:signer, fetchImpl:async () => response(false, overrides) });
  const value = await invalid.check(request());
  assert.equal(value.status, "failed");
  assert.equal(value.is_repeat, null);
  assert.equal(value.member_status, "unknown");
}
for (const fetchImpl of [
  async () => new Response("invalid-json"),
  async () => new Response("x".repeat(17 * 1024)),
  async () => new Response("failure", { status:500 }),
  async () => { throw new Error(`phone=${phone}&akey=${env.HUAMEI_MEMBER_CHECK_AKEY}`); }
]) {
  const value = await createMemberRepeatCheckClient({ env, signRequest:signer, fetchImpl }).check(request());
  assert.equal(value.status, "failed");
  assert.doesNotMatch(JSON.stringify(value), /13600000001|fixture-only-adapter-key/);
}
for (const options of [
  { signRequest:async () => new Promise(() => {}), fetchImpl:async () => { throw new Error("must not send after signing timeout"); } },
  { signRequest:signer, fetchImpl:async () => new Promise(() => {}) },
  { signRequest:signer, fetchImpl:async () => new Response(new ReadableStream({ start() {} })) }
]) {
  const start = Date.now();
  const value = await createMemberRepeatCheckClient({ env, ...options }).check(request());
  assert.equal(value.status, "failed");
  assert.equal(value.reason_code, "TIMEOUT");
  assert.ok(Date.now() - start < 1_000, "timeout must cover signing, response headers and response body");
}
let release;
let concurrentCalls = 0;
const single = createMemberRepeatCheckClient({ env, signRequest:signer, fetchImpl:async () => {
  concurrentCalls += 1;
  await new Promise((resolve) => { release = resolve; });
  return response(true);
} });
const pendingA = single.check(request("concurrent-a"));
const pendingB = single.check(request("concurrent-b"));
await new Promise((resolve) => setTimeout(resolve, 0));
release();
assert.deepEqual(await pendingA, await pendingB);
assert.equal(concurrentCalls, 1, "concurrent checks for the same tenant/phone share one request");

const { upsertAcquisitionLead, acquisitionCustomerSnapshot, resetLeadStoreForTest } = await import("../server/lead-store.mjs");
resetLeadStoreForTest();
let leadCalls = 0;
const leadClient = createMemberRepeatCheckClient({ env, signRequest:signer, fetchImpl:async () => { leadCalls += 1; const persisted = await acquisitionCustomerSnapshot(tenant); assert.equal(persisted.customers.length,1,"lead is committed before member request"); assert.equal(persisted.customers[0].memberCheck.status,"pending"); return response(true); } });
const leadPayload = { tenant_id:tenant, session_id:"member-lead", mobile:phone, service_consent:true, name:"虚构流程测试" };
const capture = await upsertAcquisitionLead(leadPayload, { memberCheckClient:leadClient });
assert.equal(capture.verification_status, "pending_manual");
assert.equal(capture.lead.customer.memberCheck.is_repeat, true);
assert.equal(capture.lead.customer.memberCheck.member_status, "unknown");
assert.equal(leadCalls, 1);
await upsertAcquisitionLead(leadPayload, { memberCheckClient:leadClient });
assert.equal(leadCalls, 1, "duplicate lead submission reuses recent provider result");
const snap = await acquisitionCustomerSnapshot(tenant);
assert.equal(snap.customers[0].memberCheck.status, "checked");
assert.doesNotMatch(JSON.stringify(snap), /13600000001|fixture-only-adapter-key/);
const failureCapture = await upsertAcquisitionLead(leadPayload, {
  memberCheckClient:{ check:async () => { throw new Error("provider down"); } }
});
assert.equal(failureCapture.verification_status, "pending_manual");
assert.equal(failureCapture.lead.customer.memberCheck.status, "failed");
assert.equal(failureCapture.lead.customer.memberCheck.member_status, "unknown");

assert.match(memberCheckPresentation(first).label, /院方.*客户记录/);
assert.match(memberCheckPresentation({ ...first, status:"failed", member_status:"non_member" }).label, /未完成/);
assert.match(memberCheckPresentation({ ...first, checked_at:"<img onerror=alert(1)>" }).label, /未完成/);
assert.deepEqual(redactForLog({ akey:"fixture-secret", sign:"fixture-sign", member_akey:"fixture-secret" }), {
  akey:"[REDACTED]", sign:"[REDACTED]", member_akey:"[REDACTED]"
});
assert.doesNotMatch(JSON.stringify(redactForLog({ url:"https://provider.invalid/?akey=fixture-secret&sign=fixture-sign" })), /fixture-secret|fixture-sign/);
console.log("✓ 会员查重接入：格式校验留资绑定、动态请求、严格响应、超时、幂等复用、失败留资、后台状态和密钥脱敏通过（全程模拟供应商）");

for(const matched of [true,false]){
 const unsignedEnv={...env,HUAMEI_RUNTIME_ENV:'production',HUAMEI_MEMBER_CHECK_AUTH_MODE:'none',HUAMEI_MEMBER_CHECK_URL:'https://scrm.shhmwz.cn/api/thirdApi/checkPhoneExists'};
 const client=createMemberRepeatCheckClient({env:unsignedEnv,signRequest:()=>assert.fail('unsigned endpoint must not sign'),fetchImpl:async(url,options)=>{
  assert.deepEqual(JSON.parse(options.body),{phone:[phone]});
  assert.equal(Object.hasOwn(options.headers,'secret'),false);
  assert.equal(options.headers.sign,'');assert.equal(options.headers.token,'');
  assert.match(options.headers.timestamp,/^\d{10}$/);assert.match(options.headers.nonce,/^[a-f0-9]{32}$/);
  return response(matched);
 }});
 assert.equal(client.config.ready,true);
 const result=await client.check(request());assert.equal(result.is_repeat,matched);assert.equal(result.member_status,'unknown');
 assert.equal(memberCheckPresentation(result).label,matched?'院方已有客户记录':'院方未找到客户记录');
 assert.equal(memberRepeatCheckConfiguration({...unsignedEnv,HUAMEI_MEMBER_CHECK_RESULT_SEMANTICS:'membership'}).ready,false);
}
console.log('PASS: hospital-confirmed unsigned production transport, minimal phone payload, customer-record semantics');

{
 const c=createMemberRepeatCheckClient({env:{...env,HUAMEI_MEMBER_CHECK_AUTH_MODE:'none',HUAMEI_MEMBER_CHECK_URL:'https://scrm.shhmwz.cn/api/thirdApi/checkPhoneExists'},fetchImpl:async()=>new Response(JSON.stringify({isSuccess:false,message:'签名验证失败'}))});
 const r=await c.check(request());assert.equal(r.reason_code,'PROVIDER_SIGNATURE_REQUIRED');assert.equal(r.is_repeat,null);assert.match(memberCheckPresentation(r).label,/配置待确认/);
}
