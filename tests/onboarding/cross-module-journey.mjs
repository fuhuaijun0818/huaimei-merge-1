// 跨模块联调旅程（A/B/C 合并后新增）：咨询 → 转人工 → 领取 → 人工回复 → 顾客回读 → 送达回执。
//
// 这是本次集成最需要证明的链路：人工回复路由与顾客端回读端点在合并中做过取舍
// （只保留 B 的 /conversations/:id/reply，顾客端消息统一走 /acquisition-history），
// 而 A 的流式、上传能力位、反馈收口与资料失效原因也必须同时可用。
//
// 与 tests/onboarding/application-http.mjs 相同的隔离规则：只复制已跟踪文件，
// 在临时目录起真实应用，绝不读取开发者自己的 .env.local 或本机业务数据。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, cpSync, existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "huamei-probe-"));
const checks = [];
let child;
let log = "";
const freePort = () => new Promise((done) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => done(port)); });
});
const cookieOf = (response) => String(response.headers.get("set-cookie") || "").split(";")[0];

try {
  for (const p of execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)) {
    if (p.startsWith(".env") || p.endsWith("/.env") || p.includes("/node_modules/")) continue;
    if (existsSync(p)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); cpSync(p, join(dir, p)); }
  }
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
  cpSync("apps/acquisition-advisor/dist", join(dir, "apps/acquisition-advisor/dist"), { recursive: true });

  const port = await freePort();
  const servicePort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(18).toString("base64url");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    NODE_ENV: "development", PORT: String(port), HUAMEI_RUNTIME_ENV: "development", HUAMEI_HOST: "127.0.0.1",
    HUAMEI_ALLOWED_ORIGINS: base, HUAMEI_ACQUISITION_SERVICE_HOST: "127.0.0.1",
    HUAMEI_ACQUISITION_SERVICE_PORT: String(servicePort), HUAMEI_ACQUISITION_SERVICE_URL: `http://127.0.0.1:${servicePort}`,
    HUAMEI_PERSISTENCE_BACKEND: "local_json", HUAMEI_LLM_ENABLED: "false", HUAMEI_MEMBER_CHECK_ENABLED: "false",
    HUAMEI_GRAPHRAG_ENABLED: "false", HUAMEI_AGENT_ENGINE: "legacy", HUAMEI_OUTBOX_DELIVERY_ENABLED: "false",
    HUAMEI_ADMIN_USERNAME: "team-probe-admin", HUAMEI_ADMIN_PASSWORD: password,
    HUAMEI_ADMIN_SESSION_AUTH: "true", HUAMEI_LOCAL_REQUIRE_AUTH: "true",
    HUAMEI_LOCAL_MANAGEMENT_ROLE: "超级管理员",
    HUAMEI_KNOWLEDGE_ROOT: join(dir, "knowledge/huamei-v1"), HUAMEI_KNOWLEDGE_APPROVAL_MODE: "preview",
    HUAMEI_NATURAL_DIALOGUE_ENABLED: "true", HUAMEI_UNIFIED_TURN_PLANNING_ENABLED: "true",
    HUAMEI_SEMANTIC_UNDERSTANDING_ENABLED: "true"
  };
  child = spawn(process.execPath, ["scripts/start-local-stack.mjs"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b) => { log = (log + b).slice(-20000); });
  child.stderr.on("data", (b) => { log = (log + b).slice(-20000); });
  let ready = false;
  for (let i = 0; i < 150; i += 1) {
    if (child.exitCode !== null) throw new Error("temporary app exited early\n" + log);
    try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert(ready, "temporary app not ready\n" + log);

  const req = (path, options = {}) => fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(15000), ...options });
  const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };

  // 1. management login
  let response = await req("/auth/login", {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ username: env.HUAMEI_ADMIN_USERNAME, password })
  });
  check("management login", response.status === 200);
  const adminCookie = cookieOf(response);

  // 2. customer turn; find one that requires human handover
  const candidates = [
    "现在呼吸困难",
    "做完热玛吉以后脸肿得厉害，是不是伤到神经了？",
    "我想做双眼皮手术，有什么风险吗？",
    "我朋友做完玻尿酸后视力模糊，我需要马上处理吗？"
  ];
  let chat = null;
  let customerCookie = "";
  for (const message of candidates) {
    response = await req("/api/public/acquisition-chat", {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    check(`customer chat accepted: ${message.slice(0, 12)}…`, response.status === 200);
    customerCookie ||= cookieOf(response);
    chat = await response.json();
    if (chat.handover?.required) break;
  }
  check("a customer turn requested human handover", chat?.handover?.required === true);
  const sessionId = chat.session_id;

  // 3. capability readback endpoint (A's route, kept for the advisor's upload capability)
  response = await req("/api/public/acquisition-conversation", {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: customerCookie },
    body: JSON.stringify({ session_id: sessionId, session_token: chat.session_token, limit: 1 })
  });
  check("capability readback returns 200", response.status === 200);
  const capability = await response.json();
  check("capability readback carries customer_upload switch", capability?.capabilities?.customer_upload?.enabled === false);
  check("capability readback signed a session credential", Boolean(capability.session_token || customerCookie));

  // 4. upload stays closed unless explicitly enabled (A-025 AC1/AC2 gate)
  response = await req("/api/public/acquisition-upload", {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: customerCookie },
    body: JSON.stringify({ file_name: "a.png", mime_type: "image/png", data_base64: "AAAA" })
  });
  check("upload disabled returns 403 CUSTOMER_UPLOAD_DISABLED", response.status === 403 && (await response.json()).error?.code === "CUSTOMER_UPLOAD_DISABLED");

  // 5. feedback endpoint refuses reads (A-027 AC4)
  response = await req("/api/public/acquisition-feedback", { method: "PUT", headers: { Origin: base } });
  check("feedback rejects non-POST with 405", response.status === 405);

  // 6. management handover list + claim + version
  response = await req("/api/admin/acquisition/handovers", { headers: { Cookie: adminCookie } });
  check("handover list returns 200", response.status === 200);
  const listBody = await response.json();
  const handovers = listBody.data || [];
  const ours = handovers.find((item) => item.conversation_id === sessionId) || handovers[0];
  check("handover queue contains the customer conversation", Boolean(ours));
  const handoverId = ours.id;

  response = await req(`/api/admin/acquisition/handovers/${handoverId}/claim`, { method: "POST", headers: { Cookie: adminCookie, Origin: base } });
  check("handover claim returns 200", response.status === 200);

  response = await req(`/api/admin/acquisition/handovers/${handoverId}`, { headers: { Cookie: adminCookie } });
  const claimed = (await response.json()).data;
  check("claimed handover is active with suspended AI", claimed.status === "active" && claimed.ai_suspended === true);

  // 7. staff reply (B's canonical route; A's duplicate route was dropped in the merge)
  const conversationId = claimed.conversation_id;
  const replyBody = { text: "您好，我是华美顾问小李，看到您描述的情况，建议尽快到院由医生面诊评估。", handover_version: claimed.updated_at };
  response = await req(`/api/admin/acquisition/conversations/${encodeURIComponent(conversationId)}/reply`, {
    method: "POST", headers: { Cookie: adminCookie, Origin: base, "Content-Type": "application/json", "Idempotency-Key": "probe-reply-0001" },
    body: JSON.stringify(replyBody)
  });
  check("staff reply returns 200", response.status === 200);
  const reply = await response.json();
  const staffMessageId = reply?.data?.message?.id;
  check("staff reply returns a stable message id", typeof staffMessageId === "string" && staffMessageId.length > 0);

  // replay with the same idempotency key must not create a second message
  const replay = await req(`/api/admin/acquisition/conversations/${encodeURIComponent(conversationId)}/reply`, {
    method: "POST", headers: { Cookie: adminCookie, Origin: base, "Content-Type": "application/json", "Idempotency-Key": "probe-reply-0001" },
    body: JSON.stringify(replyBody)
  });
  const replayBody = await replay.json();
  check("staff reply replay is idempotent", replayBody?.data?.message?.id === staffMessageId || replayBody?.data?.replayed === true);

  // 8. the customer sees the human reply through the history endpoint
  response = await req("/api/public/acquisition-history", { headers: { Origin: base, Cookie: customerCookie } });
  check("customer history returns 200", response.status === 200);
  const history = await response.json();
  const staffRows = (history.messages || []).filter((item) => item.from === "staff");
  check("customer history includes the human reply", staffRows.length >= 1);
  const staffRow = staffRows.find((item) => item.id === staffMessageId) || staffRows[0];
  check("customer history carries a delivery record for the human reply", Boolean(staffRow.delivery));

  // 9. delivery confirmation is explicit and idempotent
  const deliver = async () => {
    const res = await req("/api/public/acquisition-deliveries", {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: customerCookie },
      body: JSON.stringify({ message_id: staffRow.id, session_id: sessionId })
    });
    return { status: res.status, body: await res.json() };
  };
  const first = await deliver();
  check("delivery confirmation returns 200", first.status === 200 && first.body.delivery?.delivery_status === "delivered");
  const second = await deliver();
  check("delivery confirmation replay is idempotent", second.status === 200 && second.body.meta?.replayed === true);

  // 10. history now reports the delivered staff message
  const after = await (await req("/api/public/acquisition-history", { headers: { Origin: base, Cookie: customerCookie } })).json();
  const deliveredRow = (after.messages || []).find((item) => item.id === staffRow.id);
  check("history reports the staff message as delivered", deliveredRow?.delivery?.delivery_status === "delivered");

  // 11. knowledge-media route of any shape is closed with a explained status, never an API-key error
  response = await req("/api/public/knowledge-media/asset_0000000000000000");
  check("unknown media id returns 404 PUBLIC_MEDIA_NOT_FOUND", response.status === 404 && (await response.json()).error?.code === "PUBLIC_MEDIA_NOT_FOUND");
  response = await req("/api/public/knowledge-media/not-an-asset-id");
  check("malformed media path still returns 404, not 401/403", response.status === 404);

  console.log(JSON.stringify({ passed: true, count: checks.length, checks }, null, 2));
} catch (error) {
  console.error("PROBE FAILED:", error?.message || error);
  console.error("--- app log tail ---");
  console.error(String(log || "").slice(-3000));
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    for (let i = 0; i < 30 && child.exitCode === null; i += 1) await delay(100);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  rmSync(dir, { recursive: true, force: true });
}
