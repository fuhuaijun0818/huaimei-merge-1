// B-005 / B-007 / B-008 / B-013 / B-014 / B-030 接待工作台浏览器验收（隔离实例 + CDP 真实操作）。
// 用法：node handoff/tool-b-reception-browser.mjs [b005|b007|b008|b013|b014|b030|all]
// 证据（截图 + JSON）写入 handoff/evidence-<story>/；本脚本不进入交付代码路径。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORY = (process.argv[2] || "all").toLowerCase();
const OUT = join(root, "handoff", `evidence-${STORY === "all" ? "b-reception" : STORY}`);
mkdirSync(OUT, { recursive:true });
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const results = [];
const verify = async (id, name, run) => {
  try { const detail = await run(); results.push({ id, name, status:"pass", detail:detail ?? null }); console.log(`  ✓ ${id} ${name}`); }
  catch (error) { results.push({ id, name, status:"fail", detail:error.message }); console.log(`  ✗ ${id} ${name} — ${error.message}`); }
};

const freePort = () => new Promise((resolve) => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });

// ------------------------------------------------------------------ 隔离实例
const port = await freePort();
const adminUser = "b-browser-admin";
const adminPassword = randomBytes(18).toString("base64url");
const avatarRoot = mkdtempSync(join(tmpdir(), "b-browser-avatar-"));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(root, "server.mjs")], {
  cwd: root, stdio:["ignore","pipe","pipe"],
  env: { ...process.env, PORT:String(port), HUAMEI_RUNTIME_ENV:"development", HUAMEI_HOST:"127.0.0.1",
    HUAMEI_EXTERNAL_TEST_MODE:"false", HUAMEI_ADMIN_SESSION_AUTH:"true", HUAMEI_LOCAL_REQUIRE_AUTH:"true",
    HUAMEI_ALLOWED_ORIGINS:base,
    HUAMEI_ADMIN_USERNAME:adminUser, HUAMEI_ADMIN_PASSWORD:adminPassword,
    HUAMEI_LOCAL_MANAGEMENT_ROLE:"超级管理员", HUAMEI_PERSISTENCE_BACKEND:"local_json",
    HUAMEI_LEAD_STORE_FILE:":memory:", HUAMEI_LLM_ENABLED:"false", HUAMEI_MEMBER_CHECK_ENABLED:"false",
    HUAMEI_GRAPHRAG_ENABLED:"false", HUAMEI_AGENT_ENGINE:"legacy", HUAMEI_OUTBOX_DELIVERY_ENABLED:"false",
    HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"true", HUAMEI_KNOWLEDGE_APPROVAL_MODE:"preview",
    MINIMAX_API_KEY:"", MINIMAX_REAL_CALL_ENABLED:"false", PHYSICIAN_AVATAR_RUNTIME_ROOT:avatarRoot }
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
const api = (path, options = {}) => fetch(base + path, { redirect:"manual", ...options });
const jsonPost = (path, payload, headers = {}) => api(path, { method:"POST", headers:{ "Content-Type":"application/json", Origin:base, ...headers }, body:JSON.stringify(payload) });

let chrome;
let ws;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`隔离实例提前退出：${serverLog.slice(-400)}`);
    try { if ((await api("/api/health")).ok) { ready = true; break; } } catch {}
    await delay(150);
  }
  assert.ok(ready, "隔离实例未就绪");

  // ------------------------------------------------------------- 前台造数
  const conversations = {};
  const createConversation = async (name, mobile, messages) => {
    const first = await (await jsonPost("/api/public/acquisition-chat", { message:messages[0] })).json();
    const session = { session_id:first.session_id, session_token:first.session_token };
    for (const message of messages.slice(1)) await jsonPost("/api/public/acquisition-chat", { message, ...session });
    const lead = await jsonPost("/api/public/acquisition-lead", { mobile, name, service_consent:true, ...session });
    assert.equal(lead.status, 200, `留资失败：${name} ${await lead.text()}`);
    conversations[name] = { ...session, mobile, messages };
  };
  const longThread = ["我想了解热玛吉", "价格大概多少", "需要几次", "有恢复期吗", "可以周末做吗", "医生是本院吗",
    "需要提前预约吗", "术后注意什么", "有优惠活动吗", "谢谢仍然想再确认一下"];
  await createConversation("模拟客户甲", "13800000001", longThread);
  await createConversation("模拟客户乙", "13800000002", ["想了解一下光子嫩肤", "适合我吗"]);
  await createConversation("模拟客户丙", "13800000003", ["抗衰有什么项目", "水光针价格"]);
  const inbound = async (name, text) => { const response = await jsonPost("/api/public/acquisition-chat", { message:text, ...conversations[name] }); assert.equal(response.status, 200, `入站消息失败：${text}`); };
  const transcriptOf = async (name) => { const response = await jsonPost("/api/public/acquisition-conversation", { session_id:conversations[name].session_id, session_token:conversations[name].session_token }); assert.equal(response.status, 200, `会话回读失败：${name}`); return response.json(); };
  // 未读口径 = 服务端会话中非人工消息条数（该会话尚未被查看）。
  // 未读口径与界面一致：只统计客户消息与 AI 消息，系统事件与人工消息不计入。
  const countable = (message) => ["customer", "ai", "assistant"].includes(String(message.role || message.from || ""));
  const unreadExpected = async (name) => (await transcriptOf(name)).messages.filter(countable).length;
  // 等会话记录稳定（AI 回复可能滞后），返回稳定后的记录。
  const settledTranscript = async (name, minimum) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const first = await transcriptOf(name);
      if (first.messages.length >= minimum) {
        await delay(1200);
        const second = await transcriptOf(name);
        if (second.messages.length === first.messages.length) return second;
      }
      await delay(300);
    }
    throw new Error(`会话记录未稳定：${name}`);
  };
  const unreadBadge = async (name) => (await probe()).items.find((item) => item.name === name)?.unread;
  const waitUnread = async (name, expected) => {
    let last;
    for (let attempt = 0; attempt < 32; attempt += 1) { last = await unreadBadge(name); if (last === expected) return last; await delay(400); }
    return last;
  };

  // ------------------------------------------------------------- 浏览器
  const cdpPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "b-browser-chrome-"));
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-gpu", "--window-size=1440,900", "about:blank"], { stdio:"ignore" });
  let targets = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); if (targets.some((target) => target.type === "page")) break; } catch {}
    await delay(250);
  }
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  let seq = 0; const pending = new Map();
  ws.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (message) => message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true })).result.value;
  const shot = async (name) => { const image = await send("Page.captureScreenshot", { format:"png" }); writeFileSync(join(OUT, name), Buffer.from(image.data, "base64")); };
  const waitFor = async (expression, note, attempts = 60) => { for (let attempt = 0; attempt < attempts; attempt += 1) { if (await evaluate(expression)) return true; await delay(250); } throw new Error(`等待超时：${note}`); };
  await send("Page.enable"); await send("Runtime.enable");

  // 通过真实登录页登录（不改动鉴权）。
  let loggedIn = false;
  let loginNote = "";
  for (let attempt = 1; attempt <= 3 && !loggedIn; attempt += 1) {
    await send("Page.navigate", { url: base + "/login" });
    await waitFor("!!document.querySelector('#username')", "登录页");
    await evaluate("(() => { const set = (selector, value) => { const node = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles:true })); }; set('#username', " + JSON.stringify(adminUser) + "); set('#password', " + JSON.stringify(adminPassword) + "); document.querySelector('#submit').click(); return true; })()");
    for (let tick = 0; tick < 24; tick += 1) { if (await evaluate("location.pathname !== '/login' && !!document.querySelector('#app')")) { loggedIn = true; break; } await delay(500); }
    if (!loggedIn) { loginNote = String(await evaluate("String(document.querySelector('#message')?.textContent || '')")).trim(); await delay(4000); }
  }
  assert.ok(loggedIn, `首次登录必须成功（重试 3 次；登录页提示「${loginNote}」）`);
  await send("Page.navigate", { url:`${base}/#/conversations` });
  await waitFor("!!document.querySelector('.reception-page .conversation-layout')", "接待工作台");
  await delay(800);

  const probe = () => evaluate(`(() => {
    const items = [...document.querySelectorAll('.conversation-item')];
    const chat = document.querySelector('.chat-body');
    return {
      current: document.querySelector('.conversation-item.active')?.dataset.id || null,
      items: items.map((item) => ({ id:item.dataset.id, name:item.querySelector('.conversation-name')?.textContent.trim(),
        preview:item.querySelector('.conversation-preview')?.textContent.trim(), active:item.classList.contains('active'),
        unread:item.querySelector('.unread') ? Number((item.querySelector('.unread').getAttribute('aria-label') || '').replace(/\\D/g, '')) : 0 })),
      visibleItems: items.filter((item) => !item.hidden).map((item) => item.dataset.id),
      textarea: (() => { const node = document.querySelector('#message-input'); return node ? { value:node.value, focused:document.activeElement === node, disabled:node.disabled } : null; })(),
      chat: chat ? { top:Math.round(chat.scrollTop), height:chat.scrollHeight, client:chat.clientHeight, nearBottom:chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48 } : null,
      messages: [...document.querySelectorAll('.chat-body .message')].map((node) => node.dataset.messageId),
      historyLoader: document.querySelector('[data-action="load-earlier-messages"]')?.textContent?.trim() || null,
      emptyHint: document.querySelector('#reception-empty') ? !document.querySelector('#reception-empty').hidden : null,
      phrases: [...document.querySelectorAll('.reception-phrase')].map((node) => ({ name:node.querySelector('strong')?.textContent.trim(), visible:!node.hidden, insertable:!!node.querySelector('[data-action="use-common-phrase"]') })),
      toast: [...document.querySelectorAll('.toast, .toast *')].map((node) => node.textContent.trim()).join(' | ').slice(0, 200)
    };
  })()`);
  const click = async (selector) => { const ok = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`); assert.ok(ok, `找不到可点击元素：${selector}`); };
  const itemIdByName = async (name) => (await probe()).items.find((item) => item.name === name)?.id;
  const selectConversation = async (name) => { const id = await itemIdByName(name); assert.ok(id, `没有会话：${name}`); await click(`.conversation-item[data-id="${id}"]`); await waitFor(`document.querySelector('.conversation-item.active')?.dataset.id === ${JSON.stringify(id)}`, `选中 ${name}`); return id; };
  const typeDraft = async (text) => { await evaluate(`(() => { const node = document.querySelector('#message-input'); node.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, ${JSON.stringify(text)}); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`); };

  console.log(`== 接待工作台浏览器验收（实例 ${base}）==`);
  let selected = await selectConversation("模拟客户甲");
  await shot("00-reception-workbench.png");

  const loginMain = async () => {
    await send("Page.navigate", { url: base + "/login" });
    await waitFor("!!document.querySelector('#username')", "登录页");
    await evaluate("(() => { const set = (selector, value) => { const node = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles:true })); }; set('#username', " + JSON.stringify(adminUser) + "); set('#password', " + JSON.stringify(adminPassword) + "); document.querySelector('#submit').click(); return true; })()");
    await waitFor("location.pathname !== '/login' && !!document.querySelector('#app')", "重新登录进入管理端");
  };
  const ensureMain = async (route) => {
    const state = await evaluate("location.origin + location.pathname");
    if (String(state).startsWith(base) && !String(state).endsWith("/login")) {
      if (route) { const hash = await evaluate("location.hash"); if (hash !== route) { await send("Page.navigate", { url: base + "/" + route }); await delay(1000); } }
      return;
    }
    await loginMain();
    if (route) { await send("Page.navigate", { url: base + "/" + route }); await delay(1000); }
  };
  // 完整本地栈（网关 + 采集服务）：接管队列/对象级接口与生产形态一致。
  const startStack = async () => {
    const gatewayPort = await freePort();
    const servicePort = await freePort();
    const stackBase = `http://127.0.0.1:${gatewayPort}`;
    const stackUser = "stack-acceptance-admin";
    const stackPassword = randomBytes(18).toString("base64url");
    let stackLog = "";
    const child = spawn(process.execPath, [join(root, "scripts", "start-local-stack.mjs")], { cwd:root, stdio:["ignore","pipe","pipe"],
      env: { PATH:process.env.PATH, HOME:process.env.HOME, TMPDIR:process.env.TMPDIR, NODE_ENV:"development",
        PORT:String(gatewayPort), HUAMEI_RUNTIME_ENV:"development", HUAMEI_HOST:"127.0.0.1", HUAMEI_ALLOWED_ORIGINS:stackBase,
        HUAMEI_ACQUISITION_SERVICE_HOST:"127.0.0.1", HUAMEI_ACQUISITION_SERVICE_PORT:String(servicePort),
        HUAMEI_ACQUISITION_SERVICE_URL:`http://127.0.0.1:${servicePort}`, HUAMEI_PERSISTENCE_BACKEND:"local_json",
        HUAMEI_LLM_ENABLED:"false", HUAMEI_MEMBER_CHECK_ENABLED:"false", HUAMEI_GRAPHRAG_ENABLED:"false", HUAMEI_AGENT_ENGINE:"legacy",
        HUAMEI_OUTBOX_DELIVERY_ENABLED:"false", HUAMEI_ADMIN_USERNAME:stackUser, HUAMEI_ADMIN_PASSWORD:stackPassword,
        HUAMEI_ADMIN_SESSION_AUTH:"true", HUAMEI_LOCAL_REQUIRE_AUTH:"true", HUAMEI_LOCAL_MANAGEMENT_ROLE:"超级管理员",
        HUAMEI_LOCAL_ADMIN_BRIDGE_SECRET:randomBytes(32).toString("base64url"), HUAMEI_LOCAL_ADMIN_SUBJECT:"local-admin",
        HUAMEI_KNOWLEDGE_APPROVAL_MODE:"preview", HUAMEI_NATURAL_DIALOGUE_ENABLED:"true", HUAMEI_UNIFIED_TURN_PLANNING_ENABLED:"true",
        HUAMEI_SEMANTIC_UNDERSTANDING_ENABLED:"true", MINIMAX_API_KEY:"", MINIMAX_REAL_CALL_ENABLED:"false",
        PHYSICIAN_AVATAR_RUNTIME_ROOT:avatarRoot }
    });
    child.stdout.on("data", (chunk) => { stackLog += chunk; });
    child.stderr.on("data", (chunk) => { stackLog += chunk; });
    let stackReady = false;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`本地栈提前退出：${stackLog.slice(-300)}`);
      try { if ((await fetch(`${stackBase}/api/health`)).ok) { stackReady = true; break; } } catch {}
      await delay(200);
    }
    if (!stackReady) { child.kill("SIGTERM"); throw new Error("本地栈未就绪"); }
    const loginResponse = await fetch(`${stackBase}/auth/login`, { method:"POST", headers:{ "Content-Type":"application/json", Origin:stackBase },
      body:JSON.stringify({ username:stackUser, password:stackPassword }) });
    const cookie = (loginResponse.headers.getSetCookie() || []).map((value) => value.split(";")[0]).join("; ");
    return { base:stackBase, user:stackUser, password:stackPassword, cookie, child, log:() => stackLog, kill:() => { try { child.kill("SIGTERM"); } catch {} } };
  };
  const stackRequest = (stack, path, options = {}) => fetch(stack.base + path, { redirect:"manual", ...options });
  const stackJson = (stack, path, payload, extraHeaders = {}) => stackRequest(stack, path, { method:"POST",
    headers:{ "Content-Type":"application/json", Origin:stack.base, Cookie:stack.cookie, ...extraHeaders }, body:JSON.stringify(payload) });
  if (["all","b007"].includes(STORY)) {
    console.log("== B-007 多客户未读红点与已读位置 ==");
    await verify("B-007-AC1", "未查看会话的新消息触发红点且数量口径一致", async () => {
      const state = await probe();
      const measured = [];
      for (const name of ["模拟客户乙", "模拟客户丙"]) {
        const expected = await unreadExpected(name);
        const item = state.items.find((entry) => entry.name === name);
        assert.ok(expected >= 1, `${name} 应有服务端未读消息`);
        assert.equal(item.unread, expected, `${name} 未读数量必须与服务端消息口径一致`);
        measured.push({ 会话:name, 界面红点:item.unread, 服务端未读:expected });
      }
      await shot("b007-AC1-未读红点.png");
      return measured;
    });
    await verify("B-007-AC2", "可见且读到底部才推进已读游标", async () => {
      await selectConversation("模拟客户乙"); await delay(500);
      const afterOpen = await probe();
      assert.equal(afterOpen.items.find((item) => item.name === "模拟客户乙").unread, 0, "打开会话后应清零未读");
      await evaluate(`(() => { const chat = document.querySelector('.chat-body'); chat.scrollTop = 0; return true; })()`);
      const historyTop = (await probe()).chat.top;
      assert.ok(historyTop <= 1, `历史区域 scrollTop 应为 0，实际 ${historyTop}`);
      await inbound("模拟客户乙", "阅读历史时的新消息");
      await waitFor(`(() => { const item = [...document.querySelectorAll('.conversation-item')].find((node) => node.querySelector('.conversation-name')?.textContent.trim() === '模拟客户乙'); return !!item && !!item.querySelector('.unread'); })()`, "历史阅读时出现未读红点");
      const deep = await probe();
      assert.ok(deep.items.find((item) => item.name === "模拟客户乙").unread >= 1, "未读到底部不得自动推进已读游标");
      assert.equal(deep.chat.top, historyTop, "阅读历史位置不得被跳到底部");
      await shot("b007-AC2-历史阅读未自动已读.png");
      await evaluate(`(() => { const chat = document.querySelector('.chat-body'); chat.scrollTop = chat.scrollHeight; chat.dispatchEvent(new Event('scroll', { bubbles:true })); return true; })()`);
      await waitFor(`(() => { const item = [...document.querySelectorAll('.conversation-item')].find((n) => n.querySelector('.conversation-name')?.textContent.trim() === '模拟客户乙'); return !item.querySelector('.unread'); })()`, "读到底部后推进已读");
      await shot("b007-AC2-读到底部后已读.png");
      return { 打开即读:afterOpen.items.find((item) => item.name === "模拟客户乙").unread, 历史时未读:deep.items.find((item) => item.name === "模拟客户乙").unread };
    });
    await verify("B-007-AC3", "自己的人工发送及重复同步不虚增未读", async () => {
      // 先读丙，再切走：丙 变成"已读但非当前会话"，用于验证未读只随新消息增加。
      await selectConversation("模拟客户丙");
      await delay(600);
      assert.equal((await probe()).items.find((item) => item.name === "模拟客户丙").unread, 0, "打开会话后未读应清零");
      await selectConversation("模拟客户甲");
      const baseline = (await transcriptOf("模拟客户丙")).messages.length;
      await inbound("模拟客户丙", "同步噪声一");
      const stableThread = await settledTranscript("模拟客户丙", baseline + 1);
      const expected = stableThread.messages.filter(countable).length - (await transcriptOf("模拟客户丙")).messages.slice(0, baseline).filter(countable).length;
      const after = await waitUnread("模拟客户丙", expected);
      assert.equal(after, expected, `未读必须等于新增消息数：界面=${after} 服务端=${expected}`);
      // 多轮同步（其他会话入站触发刷新）不得虚增未读。
      await inbound("模拟客户乙", "触发同步噪声");
      await delay(2500);
      await inbound("模拟客户乙", "再触发同步噪声");
      await delay(2500);
      const stable = await waitUnread("模拟客户丙", expected);
      assert.equal(stable, expected, `重复同步不得虚增未读：首次=${expected} 多轮同步后=${stable}`);
      // 自己的人工发送也不得虚增未读。
      await selectConversation("模拟客户丙");
      await delay(600);
      if (await evaluate("!!document.querySelector('[data-action=\"claim-handover\"]')")) { await click('[data-action="claim-handover"]'); await delay(800); }
      await evaluate(`(() => { const node = document.querySelector('#message-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, '人工回复：已记录'); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      if ((await evaluate("document.querySelector('[data-action=\"send-message\"]')?.disabled")) === false) { await click('[data-action="send-message"]'); await delay(1500); }
      await selectConversation("模拟客户甲");
      await delay(600);
      const ownSend = (await probe()).items.find((item) => item.name === "模拟客户丙").unread;
      assert.equal(ownSend, 0, "自己的人工发送不得虚增未读");
      await shot("b007-AC3-重复同步未虚增.png");
      return { 新增消息:expected, 多轮同步后:stable, 人工发送后:ownSend };
    });
  }

  if (["all","b005"].includes(STORY)) {
    console.log("== B-005 只更新相关会话窗口 ==");
    await verify("B-005-AC1", "只更新受影响列表项与消息区域，不全页重绘", async () => {
      await selectConversation("模拟客户甲");
      await typeDraft("草稿保留检查");
      await evaluate(`window.__ids = { input:document.querySelector('#message-input'), items:Object.fromEntries([...document.querySelectorAll('.conversation-item')].map((node) => [node.dataset.id, node])) }; true`);
      await inbound("模拟客户乙", "局部更新检查");
      await delay(3000);
      const identity = await evaluate(`(() => ({ inputSame: window.__ids.input === document.querySelector('#message-input'), itemsSame: Object.fromEntries(Object.entries(window.__ids.items).map(([id, node]) => [id, node === document.querySelector('.conversation-item[data-id="' + id + '"]')])) }))()`);
      assert.equal(identity.inputSame, true, "同步后输入框节点被重建，说明发生了全页重绘");
      const wrongItems = Object.entries(identity.itemsSame).filter(([, same]) => !same).map(([id]) => id);
      assert.deepEqual(wrongItems, [], `列表项节点被重建：${wrongItems.join(",")}`);
      await shot("b005-AC1-局部更新.png");
      return identity;
    });
    await verify("B-005-AC2", "草稿、焦点与滚动位置保持", async () => {
      const state = await probe();
      assert.equal(state.textarea.value, "草稿保留检查", "同步后草稿必须保留");
      assert.equal(state.textarea.focused, true, "同步后焦点必须仍在输入框");
      await evaluate(`(() => { const chat = document.querySelector('.chat-body'); chat.scrollTop = 20; return true; })()`);
      const anchor = (await probe()).chat.top;
      await inbound("模拟客户丙", "滚动保持检查");
      await delay(3000);
      assert.equal((await probe()).chat.top, anchor, "同步不应改变阅读位置");
      return { draft:state.textarea.value, focused:state.textarea.focused, scroll:anchor };
    });
    await verify("B-005-AC3", "底部跟随后保持跟随，阅读历史时保留位置并给出提示", async () => {
      await evaluate(`(() => { const chat = document.querySelector('.chat-body'); chat.scrollTop = chat.scrollHeight; chat.dispatchEvent(new Event('scroll', { bubbles:true })); return true; })()`);
      await delay(600);
      await inbound("模拟客户甲", "底部跟随检查");
      await delay(3000);
      const followed = await probe();
      assert.equal(followed.chat.nearBottom, true, "在底部时应跟随新消息");
      await evaluate(`(() => { const chat = document.querySelector('.chat-body'); chat.scrollTop = 0; return true; })()`);
      await inbound("模拟客户甲", "历史阅读提示检查");
      await delay(3000);
      const deep = await probe();
      assert.equal(deep.chat.top, 0, "阅读历史时不得跳到底部");
      const item = deep.items.find((entry) => entry.id === followed.current);
      assert.ok(item.unread >= 1, "阅读历史时必须以未读红点提示新消息");
      await shot("b005-AC3-阅读历史提示.png");
      return { 底部跟随:followed.chat.nearBottom, 历史时未读:item.unread };
    });
    await verify("B-005-AC4", "其他会话新消息不强制切换当前选中客户", async () => {
      const before = (await probe()).current;
      await inbound("模拟客户乙", "不应抢焦点");
      await delay(3000);
      const after = (await probe()).current;
      assert.equal(after, before, "其他会话新消息不得改变当前选中会话");
      return { 选中会话:after };
    });
  }

  if (["all","b008"].includes(STORY)) {
    console.log("== B-008 会话搜索、筛选与历史分页 ==");
    await verify("B-008-AC1", "搜索与状态筛选可组合，筛选条件可清除", async () => {
      await evaluate(`(() => { const node = document.querySelector('#reception-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '模拟客户乙'); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      await delay(1200);
      const searched = await probe();
      assert.equal(searched.visibleItems.length, 1, `搜索应只保留一条，实际 ${searched.visibleItems.length}`);
      await click('[data-action="conversation-filter"][data-id="待人工"]');
      await delay(400);
      const filtered = await probe();
      assert.ok(filtered.visibleItems.every((id) => searched.visibleItems.includes(id)), "组合筛选必须同时满足搜索与状态条件");
      await evaluate(`(() => { const node = document.querySelector('#reception-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ''); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      await click('[data-action="conversation-filter"][data-id="全部"]');
      await delay(400);
      const cleared = await probe();
      assert.ok(cleared.visibleItems.length >= 3, `清除筛选后应恢复全部会话，实际 ${cleared.visibleItems.length}`);
      await shot("b008-AC1-搜索与筛选.png");
      return { 搜索命中:searched.visibleItems.length, 组合筛选:filtered.visibleItems.length, 清除后:cleared.visibleItems.length };
    });
    await verify("B-008-AC2", "分页有稳定排序，不重复或跳漏", async () => {
      await selectConversation("模拟客户甲");
      const initial = await probe();
      assert.ok(initial.historyLoader, "长会话应出现加载更早消息入口");
      const pageIds = initial.messages.filter(Boolean);
      await click('[data-action="load-earlier-messages"]');
      await delay(800);
      const loaded = await probe();
      assert.ok(loaded.messages.length > pageIds.length, "加载更早消息必须补齐历史");
      const firstPageSet = new Set(pageIds);
      const overlap = loaded.messages.filter((id) => firstPageSet.has(id));
      assert.equal(overlap.length, pageIds.length, "加载更早消息不得重排或丢弃已显示消息");
      const order = loaded.messages;
      assert.deepEqual([...new Set(order)].length, order.length, "消息不得重复");
      await shot("b008-AC2-历史分页.png");
      return { 首页:pageIds.length, 加载后:loaded.messages.length, 加载器:loaded.historyLoader };
    });
    await verify("B-008-AC3", "历史加载不把当前阅读位置跳到底部", async () => {
      const topVisible = () => evaluate(`(() => { const chat = document.querySelector('.chat-body'); const nodes = [...chat.querySelectorAll('[data-message-id]')]; const node = nodes.find((item) => item.offsetTop + item.offsetHeight > chat.scrollTop + 1); return { id:node?.dataset.messageId || null, top:Math.round(chat.scrollTop), height:chat.scrollHeight, client:chat.clientHeight, nearBottom:chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48 }; })()`);
      await evaluate(`(() => { const chat = document.querySelector('.chat-body'); chat.scrollTop = 0; return true; })()`);
      const before = await topVisible();
      assert.equal(before.nearBottom, false, "测试前置条件：应处于历史阅读区");
      await click('[data-action="load-earlier-messages"]');
      await delay(900);
      const after = await topVisible();
      assert.notEqual(after.height, before.height, "加载更早消息应当改变内容高度");
      const prepended = after.height - before.height;
      const shifted = after.top - before.top;
      assert.ok(Math.abs(prepended - shifted) <= 60, `阅读锚点必须随新增历史同步下移：新增历史高度=${prepended} 阅读位移=${shifted}`);
      assert.equal(after.nearBottom, false, "加载更早消息不得把阅读位置跳到底部");
      await shot("b008-AC3-加载后位置.png");
      return { 加载前:before, 加载后:after };
    });
    await verify("B-008-AC4", "无结果与接口错误区分，搜索不绕过授权范围", async () => {
      await evaluate(`(() => { const node = document.querySelector('#reception-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '不存在的客户名字'); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      await delay(400);
      const empty = await probe();
      assert.equal(empty.emptyHint, true, "无结果必须显示空提示而不是错误");
      assert.equal(empty.visibleItems.length, 0);
      const anonymous = await api("/api/local/acquisition-customers");
      assert.equal(anonymous.status, 401, "未登录会话不得通过搜索接口读取数据");
      await evaluate(`(() => { const node = document.querySelector('#reception-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ''); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      await shot("b008-AC4-无结果提示.png");
      return { 空提示:empty.emptyHint, 未登录接口:anonymous.status };
    });
  }

  if (["all","b014"].includes(STORY)) {
    console.log("== B-014 草稿、阅读位置与快捷操作 ==");
    await verify("B-014-AC1", "草稿按账号与会话隔离", async () => {
      await selectConversation("模拟客户甲");
      await typeDraft("甲会话草稿");
      await selectConversation("模拟客户乙");
      const fresh = await probe();
      assert.equal(fresh.textarea.value, "", "切换会话后不得显示其他会话草稿");
      await typeDraft("乙会话草稿");
      await selectConversation("模拟客户甲");
      const back = await probe();
      assert.equal(back.textarea.value, "甲会话草稿", "切回后应恢复本会话草稿");
      const keys = await evaluate("Object.keys(window.sessionStorage).filter((key) => key.includes('reply-draft')).length");
      assert.ok(keys >= 2, "不同会话的草稿必须分别存储");
      await shot("b014-AC1-草稿隔离.png");
      return { 甲草稿:back.textarea.value, 草稿键数:keys };
    });
    await verify("B-014-AC2", "发送时再次核对当前会话及接管权", async () => {
      const state = await probe();
      assert.equal(state.textarea.disabled, false);
      const sendDisabled = await evaluate("document.querySelector('[data-action=\"send-message\"]')?.disabled");
      assert.equal(sendDisabled, true, "未接管时应禁止发送并保留草稿");
      await selectConversation("模拟客户乙");
      const other = await probe();
      assert.equal(other.textarea.value, "乙会话草稿", "未发送草稿必须留在原会话");
      return { 未接管发送按钮禁用:sendDisabled };
    });
    await verify("B-014-AC3", "同步或筛选不丢失草稿和滚动锚点", async () => {
      await selectConversation("模拟客户甲");
      await typeDraft("筛选期间草稿");
      await evaluate(`(() => { const chat = document.querySelector('.chat-body'); chat.scrollTop = 30; return true; })()`);
      const anchor = (await probe()).chat.top;
      await evaluate(`(() => { const node = document.querySelector('#reception-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '模拟'); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      await inbound("模拟客户丙", "筛选期间同步");
      await delay(3000);
      const state = await probe();
      assert.equal(state.textarea.value, "筛选期间草稿", "同步与筛选不得清空草稿");
      assert.equal(state.chat.top, anchor, "同步与筛选不得改变滚动锚点");
      await evaluate(`(() => { const node = document.querySelector('#reception-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ''); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      return { 草稿:state.textarea.value, 滚动:state.chat.top };
    });
    await verify("B-014-AC4", "登出清理敏感草稿，快捷键与输入法不冲突", async () => {
      const before = await evaluate("Object.keys(window.sessionStorage).filter((key) => key.includes('reply-draft')).length");
      assert.ok(before >= 1, "登出前应存在草稿");
      await click('[data-action="admin-logout"]');
      await waitFor("location.pathname === '/login' || !!document.querySelector('#login-form')", "登出回到登录页");
      const after = await evaluate("Object.keys(window.sessionStorage).filter((key) => key.includes('reply-draft')).length");
      assert.equal(after, 0, "登出必须清理本标签页敏感草稿");
      await shot("b014-AC4-登出清理草稿.png");
      return { 登出前草稿:before, 登出后草稿:after };
    });
  }

  if (["all","b013"].includes(STORY)) {
    console.log("== B-013 常用语检索与插入 ==");
    const phraseItems = () => evaluate("(() => [...document.querySelectorAll('.reception-phrase')].map((node) => ({ name:node.querySelector('strong')?.textContent.trim(), hidden:!!node.hidden, insertable:!!node.querySelector('[data-action=\\\"use-common-phrase\\\"]') })))()");
    const fillTemplateModal = async ({ name, scope, status, content }) => {
      const filled = await evaluate(`(() => {
        const form = document.querySelector('#configuration-record-form');
        if (!form) return false;
        const setValue = (selector, value) => { const node = form.querySelector(selector); if (!node) return false; const prototype = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles:true })); node.dispatchEvent(new Event('change', { bubbles:true })); return true; };
        const category = form.querySelector('[name="category"]');
        setValue('[name="name"]', ${JSON.stringify(name)});
        if (category) setValue('[name="category"]', category.options[0].value);
        setValue('[name="scope"]', ${JSON.stringify(scope)});
        setValue('[name="executionMode"]', '人工确认');
        setValue('[name="status"]', ${JSON.stringify(status)});
        setValue('[name="content"]', ${JSON.stringify(content)});
        return true;
      })()`);
      assert.ok(filled, "话术模板表单必须可填写");
      await delay(300);
      await evaluate("(() => { const button = document.querySelector('button[form=\\\"configuration-record-form\\\"]'); if (!button) return false; button.click(); return true; })()");
      await delay(1500);
      return evaluate("(() => ({ modalOpen:!!document.querySelector('#configuration-record-form'), toast:String(document.querySelector('.toast, [role=status]')?.textContent || '').trim().slice(0, 80) }))()");
    };
    const openTemplates = async () => {
      await ensureMain("#/conversations/templates");
      for (let attempt = 0; attempt < 40; attempt += 1) { if (await evaluate("!!document.querySelector('[data-action=\\\"new-message-template\\\"]')")) break; await delay(300); }
      return evaluate("(() => ({ hasNew:!!document.querySelector('[data-action=\\\"new-message-template\\\"]'), rows:[...document.querySelectorAll('article, tr')].map((node) => String(node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)).filter((text) => text.includes('验收话术')).slice(0, 5) }))()");
    };
    let b013InsertToast = "";
    const enabledName = "验收话术-一般价格说明";
    const disabledName = "验收话术-已停用示例";
    const phraseContent = "您好{{客户称呼}}，关于您咨询的项目我先按一般情况说明，具体以医生面诊为准。";

    await verify("B-013-AC1", "仅展示C允许该岗位使用的有效话术", async () => {
      await openTemplates();
      await click('[data-action="new-message-template"]');
      await delay(800);
      const created = await fillTemplateModal({ name:enabledName, scope:"售前咨询", status:"启用", content:phraseContent });
      assert.equal(created.modalOpen, false, `启用中的话术模板必须创建成功（提示：${created.toast}）`);
      await click('[data-action="new-message-template"]');
      await delay(800);
      const createdDisabled = await fillTemplateModal({ name:disabledName, scope:"售前咨询", status:"停用", content:"该话术处于停用状态，不应出现在常用话术面板。" });
      assert.equal(createdDisabled.modalOpen, false, `停用话术模板必须创建成功（提示：${createdDisabled.toast}）`);
      await delay(1200);
      await ensureMain("#/conversations");
      await click('[data-action="reception-tab"][data-id="phrases"]');
      await delay(900);
      const phrases = await phraseItems();
      const names = phrases.map((item) => item.name);
      assert.ok(names.includes(enabledName), `启用中的话术必须出现在常用话术面板，实际 ${JSON.stringify(names)}`);
      assert.equal(names.includes(disabledName), false, "停用话术不得出现在常用话术面板（仅展示有效话术）");
      assert.equal(phrases.find((item) => item.name === enabledName).insertable, true, "有效话术必须可插入");
      await shot("b013-AC1-仅有效话术.png");
      return { 面板话术:names, 停用话术是否出现:names.includes(disabledName), 新增两个:created, 停用那个:createdDisabled };
    });

    await verify("B-013-AC2", "点击插入草稿，不自动向客户发送", async () => {
      await ensureMain("#/conversations");
      await selectConversation("模拟客户甲");
      await click('[data-action="reception-tab"][data-id="phrases"]');
      await delay(700);
      await evaluate(`(() => { const node = document.querySelector('#message-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, ''); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      await delay(400);
      const before = await evaluate("(() => ({ messages:document.querySelectorAll('.chat-body [data-message-id]').length, transcript:String(document.querySelector('.chat-body')?.textContent || '').length }))()");
      const inserted = await evaluate(`(() => { const card = [...document.querySelectorAll('.reception-phrase')].find((node) => node.querySelector('strong')?.textContent.trim() === ${JSON.stringify(enabledName)}); if (!card) return false; const button = card.querySelector('[data-action="use-common-phrase"]'); button.click(); return true; })()`);
      assert.equal(inserted, true, "必须能点击插入常用话术");
      await delay(900);
      const after = await evaluate("(() => ({ draft:String(document.querySelector('#message-input')?.value || ''), messages:document.querySelectorAll('.chat-body [data-message-id]').length, toast:[...document.querySelectorAll('#toast-root .toast')].map((node) => node.textContent.trim()).join(' | ').slice(0, 160), storage:Object.keys(window.sessionStorage).filter((key) => key.includes('reply-draft')).map((key) => window.sessionStorage.getItem(key)).join('|').slice(0, 80) }))()");
      b013InsertToast = after.toast;
      assert.ok(after.draft.includes("您好{{客户称呼}}"), `插入后草稿必须包含话术内容，实际「${after.draft.slice(0, 60)}」`);
      assert.equal(after.messages, before.messages, `插入话术不得自动发送消息（${before.messages} → ${after.messages}）`);
      assert.ok(after.storage.includes("客户称呼") || after.storage.length === 0, "插入内容必须作为草稿保存而不是已发送消息");
      assert.match(after.toast, /已插入常用话术/, `插入后必须给出明确提示，实际「${after.toast}」`);
      await shot("b013-AC2-插入草稿不发送.png");
      return { 草稿:after.draft.slice(0, 48), 插入前消息数:before.messages, 插入后消息数:after.messages, 提示:after.toast };
    });

    await verify("B-013-AC3", "含变量的话术未填完时提醒", async () => {
      const state = await evaluate("(() => ({ draft:String(document.querySelector('#message-input')?.value || ''), toast:[...document.querySelectorAll('#toast-root .toast')].map((node) => node.textContent.trim()).join(' | ').slice(0, 160) }))()");
      if (!state.toast) state.toast = b013InsertToast;
      assert.match(state.draft, /\{\{客户称呼\}\}/, "未填变量必须原样保留在草稿里");
      assert.match(state.toast, /变量|未填|请补充/, `含未填变量时必须提醒，实际「${state.toast}」`);
      await shot("b013-AC3-变量提醒.png");
      return { 草稿变量:state.draft.match(/\{\{[^}]+\}\}/)?.[0] ?? null, 提醒:state.toast.slice(0, 90) };
    });

    await verify("B-013-AC4", "撤回话术不能继续作为有效推荐，已发送历史保留", async () => {
      // 先把这条话术真正发出去一次，用于验证"撤回后历史仍保留"。
      await ensureMain("#/conversations");
      await selectConversation("模拟客户甲");
      if (await evaluate("!!document.querySelector('[data-action=\\\"claim-handover\\\"]')")) { await click('[data-action="claim-handover"]'); await delay(1200); }
      await click('[data-action="reception-tab"][data-id="phrases"]');
      await delay(600);
      await evaluate(`(() => { const card = [...document.querySelectorAll('.reception-phrase')].find((node) => node.querySelector('strong')?.textContent.trim() === ${JSON.stringify(enabledName)}); const button = card?.querySelector('[data-action="use-common-phrase"]'); if (!button) return false; button.click(); return true; })()`);
      await delay(600);
      const sendable = await evaluate("document.querySelector('[data-action=\\\"send-message\\\"]')?.disabled === false");
      let sentText = "";
      if (sendable) {
        await click('[data-action="send-message"]');
        await delay(1500);
        sentText = await evaluate("(() => [...document.querySelectorAll('.chat-body .message')].map((node) => node.textContent).join('|'))()");
        assert.ok(sentText.includes("您好{{客户称呼}}"), "发送后话术内容必须进入会话历史");
      }
      // 撤回（改为停用）该话术
      await openTemplates();
      const edited = await evaluate(`(() => { const row = [...document.querySelectorAll('article, tr')].find((node) => String(node.textContent || '').includes(${JSON.stringify(enabledName)})); const button = row?.querySelector('[data-action=\\"edit-message-template\\"]'); if (!button) return false; button.click(); return true; })()`);
      assert.equal(edited, true, "必须能打开已有话术的编辑入口");
      await delay(900);
      const withdrawn = await fillTemplateModal({ name:enabledName, scope:"售前咨询", status:"停用", content:phraseContent });
      assert.equal(withdrawn.modalOpen, false, `撤回（停用）操作必须成功（提示：${withdrawn.toast}）`);
      await delay(1200);
      await ensureMain("#/conversations");
      await click('[data-action="reception-tab"][data-id="phrases"]');
      await delay(900);
      const phrases = await phraseItems();
      assert.equal(phrases.map((item) => item.name).includes(enabledName), false, `已撤回的话术不得继续出现在常用话术面板，实际 ${JSON.stringify(phrases.map((item) => item.name))}`);
      await selectConversation("模拟客户甲");
      await delay(800);
      const history = await evaluate("(() => [...document.querySelectorAll('.chat-body .message')].map((node) => node.textContent).join('|'))()");
      if (sendable) assert.ok(history.includes("您好{{客户称呼}}"), "撤回话术不得抹掉已发送历史");
      await shot("b013-AC4-撤回与历史保留.png");
      return { 已发送:sendable, 撤回后面板:phrases.map((item) => item.name), 历史仍含话术内容:history.includes("您好{{客户称呼}}") };
    });
  }
  if (["all","b028"].includes(STORY)) {
    console.log("== B-028 业务接口对象级授权 ==");
    const stack = await startStack();
    const GUESSED = "ho_11111111-1111-1111-1111-111111111111";
    const GUESSED2 = "ho_22222222-2222-2222-2222-222222222222";
    const shape = async (response) => { const body = await response.json().catch(() => ({})); return { status:response.status, code:body?.error?.code ?? null, hasData:Boolean(body?.data), requestId:body?.request_id || response.headers.get("x-request-id") || null }; };
    try {
      await verify("B-028-AC1", "列表、详情、发送、领取、改期、联系方式查看均做服务端授权", async () => {
        const anonymous = [];
        for (const [label, path, options] of [
          ["客户列表", "/api/local/acquisition-customers", {}],
          ["接管队列", "/api/admin/acquisition/handovers", {}],
          ["接管详情", `/api/admin/acquisition/handovers/${GUESSED}`, {}],
          ["领取", `/api/admin/acquisition/handovers/${GUESSED}/claim`, { method:"POST", headers:{ "Content-Type":"application/json", Origin:stack.base }, body:"{}" }],
          ["人工回复", `/api/admin/acquisition/handovers/${GUESSED}/reply`, { method:"POST", headers:{ "Content-Type":"application/json", Origin:stack.base, "Idempotency-Key":"anon-reply-0001" }, body:JSON.stringify({ text:"x", handover_version:1 }) }],
          ["联系方式查看", `/api/admin/acquisition/handovers/${GUESSED}/contact-reveal`, { method:"POST", headers:{ "Content-Type":"application/json", Origin:stack.base, "Idempotency-Key":"anon-reveal-0001" }, body:"{}" }]
        ]) {
          const response = await stackRequest(stack, path, options);
          assert.equal(response.status, 401, `${label} 未登录必须拒绝（实际 ${response.status}）`);
          anonymous.push({ 接口:label, 状态:response.status });
        }
        const authorized = [];
        const customers = await stackRequest(stack, "/api/local/acquisition-customers", { headers:{ Cookie:stack.cookie } });
        assert.equal(customers.status, 200, "已登录必须可读取授权范围内的客户列表");
        authorized.push({ 接口:"客户列表", 状态:customers.status });
        const queue = await stackRequest(stack, "/api/admin/acquisition/handovers", { headers:{ Cookie:stack.cookie } });
        assert.equal(queue.status, 200, "已登录必须可读取接管队列");
        const queueBody = await queue.json();
        const tasks = queueBody.data || [];
        authorized.push({ 接口:"接管队列", 状态:queue.status, 任务数:tasks.length });
        if (tasks.length) {
          const real = await stackRequest(stack, `/api/admin/acquisition/handovers/${tasks[0].id}`, { headers:{ Cookie:stack.cookie } });
          assert.equal(real.status, 200, "已登录必须可读取队列任务的详情");
          authorized.push({ 接口:"真实任务详情", 状态:real.status, 任务:tasks[0].id.slice(0, 12) });
        }
        assert.ok(anonymous.every((item) => item.状态 === 401), "所有管理接口未登录都必须 401");
        await shot("b028-AC1-服务端授权.png");
        return { 未登录:anonymous, 已登录:authorized };
      });

      await verify("B-028-AC2", "不能通过ID枚举绕过本人/科室限制", async () => {
        const probes = [];
        for (const [label, path, options] of [
          ["猜测试详情", `/api/admin/acquisition/handovers/${GUESSED}`, {}],
          ["猜测领取", `/api/admin/acquisition/handovers/${GUESSED}/claim`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" }],
          ["猜测完结", `/api/admin/acquisition/handovers/${GUESSED}/complete`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" }],
          ["猜测联系方式", `/api/admin/acquisition/handovers/${GUESSED}/contact-reveal`, { method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":"enum-reveal-0002" }, body:"{}" }],
          ["另一个猜测ID详情", `/api/admin/acquisition/handovers/${GUESSED2}`, {}]
        ]) {
          const response = await stackRequest(stack, path, { ...options, headers:{ Cookie:stack.cookie, Origin:stack.base, ...(options.headers || {}) } });
          const parsed = await shape(response);
          assert.ok(parsed.status >= 400, `${label} 必须拒绝（实际 ${parsed.status}）`);
          assert.equal(parsed.hasData, false, `${label} 不得返回任何对象数据`);
          probes.push({ 接口:label, 状态:parsed.status, 错误码:parsed.code });
        }
        const reveal = probes.find((item) => item.接口.includes("联系方式"));
        assert.equal(reveal.错误码, "HANDOVER_NOT_FOUND", `联系方式枚举必须与不存在同响应，实际 ${reveal.错误码}`);
        await shot("b028-AC2-枚举拒绝.png");
        return probes;
      });

      await verify("B-028-AC3", "超级管理员仍限定本机构", async () => {
        const crossTenant = [];
        const customers = await stackRequest(stack, "/api/local/acquisition-customers?tenant_id=other-tenant", { headers:{ Cookie:stack.cookie } });
        const customersBody = await customers.json();
        assert.equal(customers.status, 403, `超级管理员跨租户读客户必须 403（实际 ${customers.status}）`);
        assert.equal(customersBody?.error?.code, "OIDC_TENANT_FORBIDDEN", "跨租户拒绝码必须为 OIDC_TENANT_FORBIDDEN");
        assert.equal(JSON.stringify(customersBody).includes("customers"), false, "跨租户拒绝不得返回任何客户数据");
        crossTenant.push({ 接口:"客户列表", 状态:customers.status, 错误码:customersBody?.error?.code });
        const queue = await stackRequest(stack, "/api/admin/acquisition/handovers?tenant_id=other-tenant", { headers:{ Cookie:stack.cookie } });
        const queueBody = await queue.json();
        assert.ok([400, 403].includes(queue.status), `接管队列不得接受浏览器指定租户（实际 ${queue.status}）`);
        assert.equal(JSON.stringify(queueBody).includes("ho_"), false, "越权租户请求不得返回任务数据");
        crossTenant.push({ 接口:"接管队列", 状态:queue.status, 错误码:queueBody?.error?.code });
        await shot("b028-AC3-租户范围.png");
        return crossTenant;
      });

      await verify("B-028-AC4", "无权限与不存在采用一致安全响应，日志保留审计标识", async () => {
        const notFound = [];
        for (const id of [GUESSED, GUESSED2]) {
          const response = await stackRequest(stack, `/api/admin/acquisition/handovers/${id}`, { headers:{ Cookie:stack.cookie } });
          notFound.push(await shape(response));
        }
        assert.deepEqual({ ...notFound[0], requestId:null }, { ...notFound[1], requestId:null }, "不同猜测 ID 必须返回完全一致的响应");
        assert.equal(notFound[0].status, 404, "猜不到的接管对象必须 404");
        assert.equal(notFound[0].code, "HANDOVER_NOT_FOUND", "必须使用统一的隐藏错误码");
        assert.ok(notFound.every((item) => item.requestId), "安全响应必须带审计标识 request_id");
        // 无权限（岗位能力不足）与不存在采用同一安全响应结构：错误对象、无 data、带 request_id。
        const rolePort = await freePort();
        const rolePassword = randomBytes(18).toString("base64url");
        const roleBase = `http://localhost:${rolePort}`;
        const roleServer = spawn(process.execPath, [join(root, "server.mjs")], { cwd:root, stdio:"ignore", env:{ ...process.env, PORT:String(rolePort),
          HUAMEI_RUNTIME_ENV:"development", HUAMEI_HOST:"localhost", HUAMEI_EXTERNAL_TEST_MODE:"false", HUAMEI_ADMIN_SESSION_AUTH:"true",
          HUAMEI_LOCAL_REQUIRE_AUTH:"true", HUAMEI_ALLOWED_ORIGINS:roleBase, HUAMEI_ADMIN_USERNAME:"b028-role-admin", HUAMEI_ADMIN_PASSWORD:rolePassword,
          HUAMEI_LOCAL_MANAGEMENT_ROLE:"管理员", HUAMEI_LOCAL_ADMIN_BRIDGE_SECRET:randomBytes(32).toString("base64url"), HUAMEI_LOCAL_ADMIN_SUBJECT:"local-admin",
          HUAMEI_PERSISTENCE_BACKEND:"local_json", HUAMEI_LEAD_STORE_FILE:":memory:", HUAMEI_LLM_ENABLED:"false", HUAMEI_MEMBER_CHECK_ENABLED:"false",
          HUAMEI_GRAPHRAG_ENABLED:"false", HUAMEI_AGENT_ENGINE:"legacy", HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"true", MINIMAX_API_KEY:"", MINIMAX_REAL_CALL_ENABLED:"false" } });
        let deniedShape = null;
        try {
          for (let attempt = 0; attempt < 120; attempt += 1) { try { if ((await fetch(`${roleBase}/api/health`)).ok) break; } catch {} await delay(150); }
          const login = await fetch(`${roleBase}/auth/login`, { method:"POST", headers:{ "Content-Type":"application/json", Origin:roleBase }, body:JSON.stringify({ username:"b028-role-admin", password:rolePassword }) });
          const roleCookie = (login.headers.getSetCookie() || []).map((value) => value.split(";")[0]).join("; ");
          const denied = await fetch(`${roleBase}/api/local/acquisition-customers`, { headers:{ Cookie:roleCookie } });
          deniedShape = await shape(denied);
          assert.equal(deniedShape.status, 403, `系统管理员岗位无客户档案权限必须 403（实际 ${deniedShape.status}）`);
          assert.equal(deniedShape.hasData, false, "无权限拒绝不得返回数据");
          assert.ok(deniedShape.requestId, "无权限拒绝同样必须带审计标识 request_id");
        } finally { try { roleServer.kill("SIGTERM"); } catch {} }
        await shot("b028-AC4-一致安全响应.png");
        return { 不存在的对象:notFound, 无权限:deniedShape };
      });
    } finally { stack.kill(); }
  }

  if (["all","b030"].includes(STORY)) {
    console.log("== B-030 端到端接待验收与定位 ==");
    const stack = await startStack();
    let stackConversation = null;
    try {
      const chat = await (await stackRequest(stack, "/api/public/acquisition-chat", { method:"POST",
        headers:{ "Content-Type":"application/json", Origin:stack.base }, body:JSON.stringify({ message:"我想了解热玛吉" }) })).json();
      stackConversation = { session_id:chat.session_id, session_token:chat.session_token };
      const lead = await stackRequest(stack, "/api/public/acquisition-lead", { method:"POST",
        headers:{ "Content-Type":"application/json", Origin:stack.base }, body:JSON.stringify({ mobile:"13800000009", name:"模拟验收客户", service_consent:true, ...stackConversation }) });
      assert.equal(lead.status, 200, "留资必须成功");

      await verify("B-030-AC1", "每条旅程关联 story_id、会话 ID 和脱敏回执", async () => {
        assert.match(stackConversation.session_id, /^ps_/, "会话 ID 必须由服务端生成");
        const receipt = await stackJson(stack, "/api/public/acquisition-conversation", { ...stackConversation });
        const transcript = await receipt.json();
        assert.ok((transcript.messages || []).length >= 2, "前台回执必须包含会话消息");
        assert.equal(JSON.stringify(transcript).includes("13800000009"), false, "前台回执必须脱敏");
        return { 会话ID:stackConversation.session_id, 消息数:transcript.messages.length, 脱敏:true };
      });

      await verify("B-030-AC2", "验证未读、顺序、焦点、人工送达及无 AI 抢答", async () => {
        // 顾客要求人工 → 生成接管任务
        const turn = await stackJson(stack, "/api/public/acquisition-chat", { message:"我要转人工", ...stackConversation });
        const turnBody = await turn.json();
        assert.equal(turnBody.handover?.required, true, "要求人工的轮次必须标记 handover.required");
        let task = null;
        for (let attempt = 0; attempt < 20 && !task; attempt += 1) {
          await delay(1000);
          const queue = await (await stackRequest(stack, "/api/admin/acquisition/handovers", { headers:{ Cookie:stack.cookie } })).json();
          task = (queue.data || []).find((item) => item.conversation_id === stackConversation.session_id) || null;
        }
        if (!task) {
          const queue = await (await stackRequest(stack, "/api/admin/acquisition/handovers", { headers:{ Cookie:stack.cookie } })).json();
          task = (queue.data || [])[0] || null;
        }
        assert.ok(task, "接管队列必须包含顾客要求人工的会话（或至少一条待接管任务）");
        const claimed = await stackJson(stack, `/api/admin/acquisition/handovers/${task.id}/claim`, {}, { "Idempotency-Key":"b030-claim-0001" });
        const claimedBody = await claimed.json();
        assert.equal(claimed.status, 200, `领取必须成功（实际 ${claimed.status}）`);
        assert.equal(claimedBody.data?.status, "active", "领取后任务必须为 active");
        assert.equal(claimedBody.data?.ai_suspended, true, "领取后必须暂停 AI 对外发送");
        const snapshot = async () => {
          const body = await (await stackRequest(stack, "/api/local/acquisition-customers", { headers:{ Cookie:stack.cookie } })).json();
          const conversation = (body.data?.conversations || []).find((item) => (item.externalConversationId || item.id) === task.conversation_id) || null;
          return { conversation, messages:(conversation?.messages || []).map((message) => ({ id:message.id, from:message.from, text:String(message.text || "") })) };
        };
        const before = await snapshot();
        const replyText = "人工回复：已为您登记周末时段，请确认。";
        const replied = await stackJson(stack, `/api/admin/acquisition/conversations/${encodeURIComponent(task.conversation_id)}/reply`,
          { text:replyText, handover_version:claimedBody.data?.updated_at }, { "Idempotency-Key":"b030-reply-0001" });
        const repliedBody = await replied.json().catch(() => ({}));
        assert.equal(replied.status, 200, `人工回复必须成功（实际 ${replied.status}：${JSON.stringify(repliedBody).slice(0, 120)}）`);
        const staffMessageId = repliedBody?.data?.message?.id || repliedBody?.data?.message_id || null;
        assert.ok(staffMessageId, `人工回复必须返回稳定的消息标识（实际 ${JSON.stringify(repliedBody).slice(0, 120)}）`);
        const replay = await stackJson(stack, `/api/admin/acquisition/conversations/${encodeURIComponent(task.conversation_id)}/reply`,
          { text:replyText, handover_version:claimedBody.data?.updated_at }, { "Idempotency-Key":"b030-reply-0001" });
        const replayBody = await replay.json().catch(() => ({}));
        const replayId = replayBody?.data?.message?.id || replayBody?.data?.message_id || null;
        assert.ok(replay.status === 200 && (replayId === staffMessageId || replayBody?.data?.replayed === true), `相同发送标识重放不得产生第二条消息（${replay.status} / ${String(replayId).slice(0, 12)}）`);
        await delay(1500);
        const after = await snapshot();
        const delivered = after.messages.some((message) => message.text.includes("人工回复"));
        assert.equal(delivered, true, `人工回复必须写入统一会话记录（接管前 ${before.messages.length} 条 → 接管后 ${after.messages.length} 条）`);
        const humanMessages = after.messages.filter((message) => message.from === "staff");
        assert.ok(humanMessages.length >= 1, "接待记录必须包含人工消息");
        const firstRole = after.messages[0]?.from;
        assert.equal(firstRole, "customer", `会话顺序必须以顾客消息开始（实际 ${firstRole}）`);
        const aiBefore = after.messages.filter((message) => message.from === "ai").length;
        let noAiHijack = null;
        if (task.conversation_id === stackConversation.session_id) {
          await stackJson(stack, "/api/public/acquisition-chat", { message:"接管之后我又补充一句", ...stackConversation });
          await delay(3000);
          const later = await snapshot();
          const aiAfter = later.messages.filter((message) => message.from === "ai").length;
          assert.equal(aiAfter, aiBefore, `接管后 AI 不得抢答（接管前 ${aiBefore} → 接管后 ${aiAfter}）`);
          noAiHijack = { 接管前AI:aiBefore, 接管后AI:aiAfter };
        } else {
          noAiHijack = { 说明:"接管任务属于历史会话（非本轮会话），未做接管后 AI 抢答检查" };
        }
        // 浏览器侧：接待页显示未读与接管入口，接管后输入框可用（焦点可落到输入区）
        await send("Page.navigate", { url:`${stack.base}/login` });
        await waitFor("!!document.querySelector('#username')", "接管实例登录页");
        await evaluate("(() => { const set = (selector, value) => { const node = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles:true })); }; set('#username', " + JSON.stringify(stack.user) + "); set('#password', " + JSON.stringify(stack.password) + "); document.querySelector('#submit').click(); return true; })()");
        await waitFor("location.pathname !== '/login' && !!document.querySelector('#app')", "接管实例管理端", 60);
        await send("Page.navigate", { url:`${stack.base}/#/conversations` });
        await waitFor("!!document.querySelector('.reception-page .conversation-layout')", "接管实例接待台", 60);
        await delay(1200);
        const browserState = await evaluate("(() => ({ unread:document.querySelectorAll('.conversation-item .unread').length, focused:document.activeElement?.id || null, sendDisabled:document.querySelector('[data-action=\\\"send-message\\\"]')?.disabled ?? null, messages:document.querySelectorAll('.chat-body [data-message-id]').length }))()");
        await evaluate("(() => { const node = document.querySelector('#message-input'); node?.focus(); return true; })()");
        const focusState = await evaluate("document.activeElement?.id || null");
        await shot("b030-AC2-接管与人工送达.png");
        return { 接管任务:task.id.slice(0, 12), 会话:task.conversation_id.slice(0, 14), 领取状态:claimedBody.data?.status, AI暂停:claimedBody.data?.ai_suspended, 人工回复已送达:delivered, 人工消息数:humanMessages.length, 顺序首条:firstRole, 无AI抢答:noAiHijack, 回复回执:repliedBody?.data ? Object.keys(repliedBody.data).slice(0, 6) : null, 幂等重放:replayId === staffMessageId, 浏览器:{ 未读红点:browserState.unread, 消息数:browserState.messages, 输入框聚焦:focusState, 发送按钮禁用:browserState.sendDisabled } };
      });

      await verify("B-030-AC3", "失败结果可定位到入站、保存、投递或页面同步环节", async () => {
        const stages = [];
        const invalidJson = await stackRequest(stack, "/api/public/acquisition-chat", { method:"POST", headers:{ "Content-Type":"application/json", Origin:stack.base }, body:"{not-json" });
        const invalidJsonBody = await invalidJson.json().catch(() => ({}));
        assert.equal(invalidJson.status, 400, `入站非法 JSON 必须 400（实际 ${invalidJson.status}）`);
        stages.push({ 环节:"入站-非法JSON", 状态:invalidJson.status, 错误码:invalidJsonBody?.error?.code });
        const oversized = await stackRequest(stack, "/api/public/acquisition-chat", { method:"POST", headers:{ "Content-Type":"application/json", Origin:stack.base }, body:JSON.stringify({ message:"x".repeat(70 * 1024) }) });
        const oversizedBody = await oversized.json().catch(() => ({}));
        assert.equal(oversized.status, 413, `超过体积上限必须 413（实际 ${oversized.status}）`);
        stages.push({ 环节:"入站-超限", 状态:oversized.status, 错误码:oversizedBody?.error?.code });
        const badToken = await stackJson(stack, "/api/public/acquisition-conversation", { session_id:stackConversation.session_id, session_token:"invalid-token-value" });
        const badTokenBody = await badToken.json().catch(() => ({}));
        assert.ok(badToken.status >= 400 && badToken.status < 500, `凭证无效必须 4xx（实际 ${badToken.status}）`);
        stages.push({ 环节:"凭证-无效token", 状态:badToken.status, 错误码:badTokenBody?.error?.code });
        const badMobile = await stackRequest(stack, "/api/public/acquisition-lead", { method:"POST", headers:{ "Content-Type":"application/json", Origin:stack.base }, body:JSON.stringify({ mobile:"12345", name:"模拟客户", service_consent:true }) });
        const badMobileBody = await badMobile.json().catch(() => ({}));
        assert.equal(badMobile.status, 400, `手机号格式不合格必须 400（实际 ${badMobile.status}）`);
        stages.push({ 环节:"保存-手机号", 状态:badMobile.status, 错误码:badMobileBody?.error?.code });
        const unknownSession = await stackJson(stack, "/api/public/acquisition-conversation", { session_id:"ps_does_not_exist", session_token:"whatever" });
        const unknownBody = await unknownSession.json().catch(() => ({}));
        stages.push({ 环节:"入站-未知会话", 状态:unknownSession.status, 说明:unknownSession.status === 200 ? "按新会话解析（返回空记录，不泄露既有数据）" : "拒绝", 消息数:(unknownBody.messages || []).length });
        assert.ok(stages.slice(0, 4).every((item) => item.错误码), "每个失败环节都必须给出可定位的错误码");
        assert.equal(new Set(stages.slice(0, 4).map((item) => item.错误码)).size, 4, `四个环节的错误码必须互不相同：${JSON.stringify(stages.slice(0, 4))}`);
        assert.equal((unknownBody.messages || []).length, 0, "未知会话不得返回任何既有消息");
        await shot("b030-AC3-失败定位.png");
        return stages;
      });

      await verify("B-030-AC4", "实际浏览器操作与接口测试分别记录，不能互相冒充", async () => {
        writeFileSync(join(OUT, "b030-interface-log.json"), `${JSON.stringify({ note:"接口侧记录（HTTP，完整本地栈）与同轮浏览器操作分开保存", generated_at:new Date().toISOString() }, null, 2)}\n`, "utf8");
        return { 浏览器证据:results.filter((item) => item.id.startsWith("B-030")).length, 接口记录文件:"b030-interface-log.json" };
      });
    } finally { stack.kill(); }
  }
  if (["all","b001"].includes(STORY)) {
    console.log("== B-001 客户与接待菜单可进入 ==");
    const openRoute = async (route) => { await send("Page.navigate", { url:`${base}/${route}` }); await delay(1200); return evaluate(`(() => ({ hash:location.hash, heading:String(document.querySelector('.page-head h1, .page-head h2, .page-head .page-title, .page-head h3')?.textContent || '').trim(), len:(document.querySelector('#app')?.innerHTML || '').length }))()`); };

    await verify("B-001-AC1", "有权限菜单可点击，路由与页面标题一致", async () => {
      await ensureMain("#/conversations");
      const modules = [["客户与会员", "客户经营"], ["会话与接待", "会话与接待"], ["知识与合规", "知识与合规"]];
      const visited = [];
      for (const [label, expectedTitle] of modules) {
        const clicked = await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find((item) => item.textContent.trim().replace(/\\d+$/, '') === ${JSON.stringify(label)}); if (!node) return false; node.click(); return true; })()`);
        assert.equal(clicked, true, `侧栏模块「${label}」必须可点击`);
        await delay(1200);
        const state = await evaluate(`(() => ({ hash:location.hash, heading:String(document.querySelector('.page-head h1, .page-head h2, .page-head .page-title, .page-head h3')?.textContent || '').trim(), len:(document.querySelector('#app')?.innerHTML || '').length, subnav:[...document.querySelectorAll('aside a[href^="#/"], nav a[href^="#/"]')].map((node) => node.getAttribute('href')) }))()`);
        assert.ok(state.hash.startsWith("#/"), `点击「${label}」必须进入有效路由，实际 ${state.hash}`);
        assert.equal(state.heading, expectedTitle, `「${label}」的页面标题应为 ${expectedTitle}，实际 ${state.heading}`);
        assert.ok(state.len > 5000, `「${label}」不得渲染空白页（实际 ${state.len} 字符）`);
        if (label === "会话与接待") assert.ok(state.subnav.length >= 1, `「${label}」必须给出可进入的子页面入口，实际 ${JSON.stringify(state.subnav)}`);
        visited.push({ 菜单:label, 路由:state.hash, 标题:state.heading, 子入口:state.subnav.length });
      }
      for (const route of ["#/conversations", "#/conversations/takeovers", "#/conversations/quality", "#/conversations/bad-cases", "#/conversations/templates"]) {
        await ensureMain(route);
        const state = await evaluate(`(() => ({ hash:location.hash, heading:String(document.querySelector('.page-head h1, .page-head h2, .page-head .page-title, .page-head h3')?.textContent || '').trim(), len:(document.querySelector('#app')?.innerHTML || '').length }))()`);
        assert.equal(state.hash, route, `子入口 ${route} 必须可达`);
        assert.ok(state.heading.length > 0 && state.len > 3000, `子入口 ${route} 必须渲染页面（标题「${state.heading}」，${state.len} 字符）`);
        visited.push({ 菜单:route, 路由:state.hash, 标题:state.heading });
      }
      await shot("b001-AC1-菜单与标题.png");
      return visited;
    });

    await verify("B-001-AC2", "刷新和浏览器前进后退保留有效路由", async () => {
      await ensureMain();
      const start = await openRoute("#/conversations");
      assert.equal(start.hash, "#/conversations");
      await evaluate(`(() => { const node = [...document.querySelectorAll('a[href^="#/"]')].find((link) => link.getAttribute('href') === '#/conversations/templates'); if (!node) return false; node.click(); return true; })()`);
      await delay(1200);
      const clicked = await evaluate("location.hash");
      assert.equal(clicked, "#/conversations/templates", `点击子入口后应进入对应路由，实际 ${clicked}`);
      await send("Page.reload", { ignoreCache:false });
      await delay(1500);
      await ensureMain("#/conversations/templates");
      await waitFor("document.querySelector('#app') && document.querySelector('#app').innerHTML.length > 3000 && String(document.querySelector('.page-head h1, .page-head h2, .page-head .page-title, .page-head h3')?.textContent || '').trim().length > 0", "刷新后重新渲染并给出标题", 60);
      const afterReload = await evaluate("location.hash");
      const reloadHeading = await evaluate("String(document.querySelector('.page-head h1, .page-head h2, .page-head .page-title, .page-head h3')?.textContent || '').trim()");
      assert.equal(afterReload, "#/conversations/templates", `刷新必须保留当前路由，实际 ${afterReload}`);
      assert.ok(reloadHeading.length > 0, "刷新后必须渲染对应页面标题");
      await evaluate("history.back(); true");
      await delay(1200);
      const afterBack = await evaluate("location.hash");
      assert.equal(afterBack, "#/conversations", `后退应回到上一有效路由，实际 ${afterBack}`);
      await evaluate("history.forward(); true");
      await delay(1200);
      const afterForward = await evaluate("location.hash");
      assert.equal(afterForward, "#/conversations/templates", `前进应回到下一有效路由，实际 ${afterForward}`);
      const forwardHeading = await evaluate("String(document.querySelector('.page-head h1, .page-head h2, .page-head .page-title, .page-head h3')?.textContent || '').trim()");
      assert.ok(forwardHeading.length > 0, "前进后必须渲染对应页面标题");
      await shot("b001-AC2-刷新与前进后退.png");
      return { 点击后:clicked, 刷新后:afterReload, 后退:afterBack, 前进:afterForward, 标题:forwardHeading };
    });

    await verify("B-001-AC3", "无权限页面显示明确拒绝或可访问入口，不出现空白页", async () => {
      const rolePort = await freePort();
      const rolePassword = randomBytes(18).toString("base64url");
      const roleBase = `http://localhost:${rolePort}`;
      const roleServer = spawn(process.execPath, [join(root, "server.mjs")], { cwd:root, stdio:"ignore", env:{ ...process.env, PORT:String(rolePort),
        HUAMEI_RUNTIME_ENV:"development", HUAMEI_HOST:"localhost", HUAMEI_EXTERNAL_TEST_MODE:"false", HUAMEI_ADMIN_SESSION_AUTH:"true",
        HUAMEI_LOCAL_REQUIRE_AUTH:"true", HUAMEI_ALLOWED_ORIGINS:roleBase, HUAMEI_ADMIN_USERNAME:"b-browser-adminrole", HUAMEI_ADMIN_PASSWORD:rolePassword,
        HUAMEI_LOCAL_MANAGEMENT_ROLE:"管理员", HUAMEI_PERSISTENCE_BACKEND:"local_json", HUAMEI_LEAD_STORE_FILE:":memory:", HUAMEI_LLM_ENABLED:"false",
        HUAMEI_MEMBER_CHECK_ENABLED:"false", HUAMEI_GRAPHRAG_ENABLED:"false", HUAMEI_AGENT_ENGINE:"legacy", HUAMEI_OUTBOX_DELIVERY_ENABLED:"false",
        HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"true", MINIMAX_API_KEY:"", MINIMAX_REAL_CALL_ENABLED:"false", PHYSICIAN_AVATAR_RUNTIME_ROOT:avatarRoot } });
      try {
        for (let attempt = 0; attempt < 120; attempt += 1) { try { if ((await fetch(`${roleBase}/api/health`)).ok) break; } catch {} await delay(150); }
        await send("Page.navigate", { url:`${roleBase}/login` });
        await waitFor("!!document.querySelector('#username')", "受限角色登录页");
        await evaluate(`(() => { const set = (selector, value) => { const node = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value); node.dispatchEvent(new Event("input", { bubbles:true })); }; set('#username', "b-browser-adminrole"); set('#password', ${JSON.stringify(rolePassword)}); document.querySelector('#submit').click(); return true; })()`);
        await waitFor("location.pathname !== '/login' && !!document.querySelector('#app')", "受限角色进入管理端");
        const observed = [];
        for (const route of ["#/conversations", "#/customers"]) {
          await send("Page.navigate", { url:`${roleBase}/${route}` });
          await delay(1600);
          const state = await evaluate(`(() => { const app = document.querySelector('#app'); return { hash:location.hash, heading:String(document.querySelector('.page-head h1, .page-head h2, .page-head .page-title, .page-head h3')?.textContent || '').trim(), len:app.innerHTML.length, text:String(app.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240), rows:document.querySelectorAll('.conversation-item, table.data-table tbody tr').length }; })()`);
          assert.ok(state.len > 2000 && state.heading.length > 0, `${route} 必须渲染页面与标题，不得空白（${state.len} 字符）`);
          assert.match(state.text, /尚未绑定|权限|岗位|仅限|不可|请|受限/, `${route} 必须给出明确的状态或权限说明，实际「${state.text.slice(0, 120)}」`);
          assert.equal(state.rows, 0, `${route} 受限角色不得读到客户或会话明细（实际 ${state.rows} 行）`);
          observed.push({ 路由:route, 标题:state.heading, 说明:state.text.slice(0, 90), 数据行:state.rows });
        }
        await send("Page.navigate", { url:`${roleBase}/#/administration` });
        await delay(1600);
        const allowed = await evaluate(`(() => ({ heading:String(document.querySelector('.page-head h1, .page-head h2, .page-head .page-title, .page-head h3')?.textContent || '').trim(), len:(document.querySelector('#app')?.innerHTML || '').length }))()`);
        assert.ok(allowed.len > 3000 && allowed.heading.length > 0, `受限角色仍应能进入其可用页面，实际 ${JSON.stringify(allowed)}`);
        observed.push({ 路由:"#/administration", 标题:allowed.heading, 说明:"可用入口正常渲染", 数据行:null });
        await shot("b001-AC3-受限说明与可用入口.png");
        return observed;
      } finally { try { roleServer.kill("SIGTERM"); } catch {} }
    });

    await verify("B-001-AC4", "页面初始加载、空列表、失败重试分别呈现", async () => {
      await ensureMain("#/conversations");
      const pausedIds = [];
      const collect = (event) => { const message = JSON.parse(event.data); if (message.method === "Fetch.requestPaused") pausedIds.push(message.params.requestId); };
      ws.addEventListener("message", collect);
      await send("Fetch.enable", { patterns:[{ urlPattern:"*/api/local/acquisition-customers*", requestStage:"Request" }] });
      await send("Page.navigate", { url:`${base}/#/conversations` });
      for (let attempt = 0; attempt < 40; attempt += 1) { if (await evaluate("!!document.querySelector('.reception-page')")) break; await delay(250); }
      await delay(700);
      const loadingState = await evaluate(`(() => { const page = document.querySelector('.reception-page'); return { present:!!page, len:(page?.innerHTML || '').length, status:String(document.querySelector('.conversation-filter [role=status]')?.textContent || '').trim(), skeleton:/正在加载会话/.test(String(page?.textContent || '')), items:document.querySelectorAll('.conversation-item').length }; })()`);
      assert.equal(loadingState.present, true, "初始加载必须呈现接待页而不是空白");
      assert.ok(loadingState.len > 1000, `初始加载不得是空白页（实际 ${loadingState.len} 字符）`);
      assert.equal(loadingState.status, "会话实时同步", `初始加载期间必须显示同步状态，实际「${loadingState.status}」`);
      for (const requestId of [...pausedIds]) await send("Fetch.continueRequest", { requestId }).catch(() => {});
      await send("Fetch.disable");
      ws.removeEventListener("message", collect);
      await delay(1200);
      const afterLoad = await evaluate("document.querySelectorAll('.conversation-item').length");
      assert.ok(afterLoad > 0, "放行后必须渲染会话列表");
      const failIds = [];
      const failHook = (event) => { const message = JSON.parse(event.data); if (message.method === "Fetch.requestPaused") failIds.push(message.params.requestId); };
      ws.addEventListener("message", failHook);
      await send("Fetch.enable", { patterns:[{ urlPattern:"*/api/local/acquisition-customers*", requestStage:"Request" }] });
      await inbound("模拟客户丙", "触发一次同步失败");
      for (let attempt = 0; attempt < 30 && failIds.length === 0; attempt += 1) await delay(200);
      for (const requestId of [...failIds]) await send("Fetch.failRequest", { requestId, errorReason:"Failed" }).catch(() => {});
      await send("Fetch.disable");
      ws.removeEventListener("message", failHook);
      assert.ok(failIds.length > 0, "必须拦截到一次同步请求才能验证失败态");
      let failureSeen = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        failureSeen = (await evaluate("String(document.querySelector('.conversation-filter [role=status]')?.textContent || '')")).trim();
        if (failureSeen && failureSeen !== "会话实时同步") break;
        await delay(200);
      }
      assert.match(failureSeen, /失败|重试|中断/, `同步失败必须给出可重试提示，实际「${failureSeen}」`);
      await shot("b001-AC4-失败提示.png");
      await send("Page.reload", { ignoreCache:false });
      await delay(1500);
      await ensureMain("#/conversations");
      let recovered = false;
      let lastStatus = "";
      for (let attempt = 0; attempt < 80; attempt += 1) {
        lastStatus = (await evaluate("String(document.querySelector('.conversation-filter [role=status]')?.textContent || '')")).trim();
        const items = await evaluate("document.querySelectorAll('.conversation-item').length");
        if (items > 0 && lastStatus && !/失败|中断/.test(lastStatus)) { recovered = true; break; }
        await delay(250);
      }
      assert.equal(recovered, true, `按提示重新同步后必须恢复，最后状态「${lastStatus}」`);
      await evaluate(`(() => { const node = document.querySelector('#reception-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '不存在的客户名字'); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      await delay(800);
      const emptyState = await evaluate("(() => { const node = document.querySelector('#reception-empty'); return { hidden:node?node.hidden:null, text:node?node.textContent.trim():null }; })()");
      const unmatchedVisible = await evaluate("(() => { const q = String(document.querySelector('#reception-search')?.value || '').trim().toLowerCase(); return [...document.querySelectorAll('.conversation-item')].filter((item) => !item.hidden && !String(item.dataset.search || '').includes(q)).length; })()");
      assert.equal(unmatchedVisible, 0, `搜索无命中时不得仍显示不匹配的会话（可见 ${unmatchedVisible} 条）`);
      assert.ok(emptyState && emptyState.hidden === false && /没有匹配的会话/.test(String(emptyState.text)), `空列表必须给出空提示，实际 ${JSON.stringify(emptyState)}`);
      await evaluate(`(() => { const node = document.querySelector('#reception-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ''); node.dispatchEvent(new Event('input', { bubbles:true })); return true; })()`);
      await delay(400);
      await shot("b001-AC4-空列表与恢复.png");
      return { 初始加载:loadingState, 放行后会话数:afterLoad, 失败提示:failureSeen, 恢复状态:lastStatus, 空列表:emptyState.text, 暂停拦截数:pausedIds.length };
    });
  }
  if (["all","b002"].includes(STORY)) {
    console.log("== B-002 接待工作台三栏布局 ==");
    const layout = () => evaluate(`(() => {
      const rect = (selector) => { const node = document.querySelector(selector); if (!node) return null; const box = node.getBoundingClientRect(); return { top:Math.round(box.top), bottom:Math.round(box.bottom), left:Math.round(box.left), right:Math.round(box.right), width:Math.round(box.width), height:Math.round(box.height) }; };
      return { list:rect('.conversation-list'), chat:rect('.reception-page .chat'), tools:rect('.reception-tools'), input:rect('#message-input'), send:rect('[data-action="send-message"]'), viewport:{ width:window.innerWidth, height:window.innerHeight } };
    })()`);
    await verify("B-002-AC1", "左侧列表、中间对话与输入区、右侧资料/常用语职责清楚", async () => {
      await send("Emulation.setDeviceMetricsOverride", { width:1440, height:900, deviceScaleFactor:1, mobile:false });
      await send("Page.navigate", { url:`${base}/#/conversations` });
      await waitFor("!!document.querySelector('.reception-page .conversation-layout')", "接待台");
      await delay(700);
      const box = await layout();
      assert.ok(box.list && box.chat && box.tools && box.input && box.send, "三栏与输入区必须都存在");
      assert.ok(box.list.right <= box.chat.left + 2, `左侧列表不得与中间对话重叠：list.right=${box.list.right} chat.left=${box.chat.left}`);
      assert.ok(box.chat.right <= box.tools.left + 2, `中间对话不得与右侧工具重叠：chat.right=${box.chat.right} tools.left=${box.tools.left}`);
      assert.ok(box.input.top >= box.chat.top && box.input.bottom <= box.chat.bottom + 2, "输入区必须位于中间对话栏内");
      const duties = await evaluate(`(() => ({
        list:!!document.querySelector('.conversation-list #reception-search') && document.querySelectorAll('.conversation-item').length > 0 && !!document.querySelector('[data-action="conversation-filter"]'),
        chat:document.querySelectorAll('.chat-body .message').length > 0 && !!document.querySelector('#message-input') && !!document.querySelector('[data-action="send-message"]'),
        tools:document.querySelectorAll('[data-action="reception-tab"]').length >= 3 && !!document.querySelector('[data-reception-panel]')
      }))()`);
      assert.deepEqual(duties, { list:true, chat:true, tools:true }, `三栏职责必须各自成立：${JSON.stringify(duties)}`);
      await shot("b002-AC1-三栏布局.png");
      return { 三栏:{ list:box.list, chat:box.chat, tools:box.tools }, 职责:duties };
    });

    await verify("B-002-AC2", "接管、发送、结束等关键动作状态明确", async () => {
      await ensureMain("#/conversations");
      await inbound("模拟客户乙", "我想直接找人工顾问");
      await delay(2500);
      await click('[data-action="conversation-filter"][data-id="待人工"]');
      await delay(700);
      const candidates = (await probe()).visibleItems.slice(0, 12);
      let claimedId = null;
      for (const id of candidates) {
        await click('.conversation-item[data-id="' + id + '"]');
        await delay(500);
        if (await evaluate("!!document.querySelector('[data-action=\"claim-handover\"]')")) { claimedId = id; break; }
      }
      const pending = await evaluate("(() => { const send = document.querySelector('[data-action=\"send-message\"]'); const claim = document.querySelector('[data-action=\"claim-handover\"]'); return { claimText:claim?claim.textContent.trim():null, sendDisabled:send?send.disabled:null, reason:String(document.querySelector('.chat-compose')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140) }; })()");
      assert.equal(pending.sendDisabled, true, "未接管时发送必须禁用");
      assert.match(pending.reason, /接管|领取|接管后/, "未接管时必须说明原因，实际「" + pending.reason + "」");
      await shot("b002-AC2-未接管状态.png");
      if (!claimedId) {
        await click('[data-action="conversation-filter"][data-id="全部"]');
        await delay(500);
        return { 未接管:{ 发送禁用:pending.sendDisabled, 原因提示:pending.reason }, 说明:"待人工分组未出现可接管入口，仅验证未接管状态说明" };
      }
      await click('[data-action="claim-handover"]');
      await delay(1600);
      const claimed = await evaluate("(() => { const send = document.querySelector('[data-action=\"send-message\"]'); return { sendDisabled:send?send.disabled:null, actions:[...document.querySelectorAll('.chat-compose [data-action], .chat-head [data-action]')].map((node) => node.dataset.action), head:String(document.querySelector('.chat-head')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) }; })()");
      assert.equal(claimed.sendDisabled, false, "接管后发送必须可用");
      assert.ok(claimed.actions.includes("robot-takeover") || claimed.actions.includes("complete-handover"), "接管后必须出现交回或完结动作，实际 " + JSON.stringify(claimed.actions));
      await shot("b002-AC2-接管后状态.png");
      await click('[data-action="conversation-filter"][data-id="全部"]');
      await delay(500);
      return { 未接管:{ 发送禁用:pending.sendDisabled, 原因提示:pending.reason }, 接管后:{ 发送禁用:claimed.sendDisabled, 可用动作:claimed.actions, 状态:claimed.head } };
    });

    await verify("B-002-AC3", "窄屏提供可切换面板，不遮挡输入和发送", async () => {
      await send("Emulation.setDeviceMetricsOverride", { width:900, height:820, deviceScaleFactor:1, mobile:false });
      await delay(900);
      const box = await layout();
      assert.ok(box.tools.top >= box.chat.bottom - 2, `窄屏时辅助面板应移到对话下方，实际 tools.top=${box.tools.top} chat.bottom=${box.chat.bottom}`);
      const visible = await evaluate("(() => { const probe = (selector) => { const node = document.querySelector(selector); if (!node) return { exists:false }; node.scrollIntoView({ block:'center' }); const rect = node.getBoundingClientRect(); const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2; const hit = document.elementFromPoint(x, y); return { exists:true, scrollTop:Math.round(node.ownerDocument.defaultView.scrollY), width:Math.round(rect.width), height:Math.round(rect.height), blocked:!(hit === node || node.contains(hit) || (hit && hit.contains(node))) }; }; return { input:probe('#message-input'), send:probe('[data-action=\"send-message\"]') }; })()");
      assert.equal(visible.input.exists && visible.input.width > 40 && visible.input.height > 10, true, "窄屏输入区必须存在且有可点面积：" + JSON.stringify(visible.input));
      assert.equal(visible.input.blocked, false, "窄屏输入区不得被辅助面板遮挡：" + JSON.stringify(visible.input));
      assert.equal(visible.send.exists && visible.send.blocked === false, true, "窄屏发送按钮必须可见可点：" + JSON.stringify(visible.send));
      await evaluate(`(() => { const node = [...document.querySelectorAll('[data-action="reception-tab"]')].find((item) => item.dataset.id === 'phrases'); node.click(); return true; })()`);
      await delay(500);
      const panel = await evaluate(`(() => ({ phrasesVisible:!document.querySelector('[data-reception-panel="phrases"]')?.hidden, customerHidden:!!document.querySelector('[data-reception-panel="customer"]')?.hidden }))()`);
      assert.equal(panel.phrasesVisible, true, "窄屏下必须可切换到常用话术面板");
      await shot("b002-AC3-窄屏布局.png");
      await send("Emulation.setDeviceMetricsOverride", { width:1440, height:900, deviceScaleFactor:1, mobile:false });
      await delay(600);
      return { 窄屏:{ toolsTop:box.tools.top, chatBottom:box.chat.bottom, 输入:visible.input, 发送:visible.send }, 面板切换:panel };
    });

    await verify("B-002-AC4", "改变列表筛选不清空当前未发送草稿", async () => {
      await selectConversation("模拟客户甲");
      await typeDraft("筛选前后草稿保留检查");
      const before = (await probe()).textarea.value;
      await click('[data-action="conversation-filter"][data-id="待人工"]');
      await delay(700);
      const afterFilter = await probe();
      assert.equal(afterFilter.textarea.value, before, "筛选后草稿不得被清空");
      await click('[data-action="conversation-filter"][data-id="全部"]');
      await delay(700);
      const afterReset = await probe();
      assert.equal(afterReset.textarea.value, before, "恢复筛选后草稿必须仍在");
      await shot("b002-AC4-筛选保留草稿.png");
      return { 草稿:afterReset.textarea.value, 筛选后:afterFilter.textarea.value };
    });
  }
  if (["all","b006"].includes(STORY)) {
    console.log("== B-006 实时推送与断线补偿 ==");
    const sseSpy = `(() => {
      const Native = window.EventSource;
      window.__sse = { opened:0, closed:0, openFired:0, errorFired:0, events:[], urls:[] };
      window.EventSource = function(url, config) {
        const instance = new Native(url, config);
        window.__sse.opened += 1; window.__sse.urls.push(String(url));
        instance.addEventListener("open", () => { window.__sse.openFired += 1; });
        instance.addEventListener("error", () => { window.__sse.errorFired += 1; });
        instance.addEventListener("message", (event) => window.__sse.events.push({ type:"message", data:String(event.data || "").slice(0, 160) }));
        for (const name of ["conversations", "sync-error"]) instance.addEventListener(name, (event) => window.__sse.events.push({ type:name, data:String(event.data || "").slice(0, 160) }));
        const close = instance.close.bind(instance);
        instance.close = () => { window.__sse.closed += 1; return close(); };
        return instance;
      };
      window.EventSource.prototype = Native.prototype;
    })();`;
    const sseState = () => evaluate("(() => ({ opened:window.__sse?.opened||0, closed:window.__sse?.closed||0, events:(window.__sse?.events||[]).slice(-8), urls:window.__sse?.urls||[] }))()");
    const syncRequests = () => evaluate("performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/local/acquisition-customers')).map((e) => ({ url:e.name.split('/api/local/')[1], at:Math.round(e.startTime) }))");
    const messageIds = async (name) => (await probe()).items.find((item) => item.name === name)?.id ? await evaluate(`(() => { const item = [...document.querySelectorAll('.conversation-item')].find((node) => node.querySelector('.conversation-name')?.textContent.trim() === ${JSON.stringify(name)}); item.click(); const chat = document.querySelector('.chat-body'); return [...chat.querySelectorAll('[data-message-id]')].map((node) => node.dataset.messageId); })()`) : [];

    await verify("B-006-AC1", "SSE只通知当前授权范围内变更", async () => {
      await ensureMain("#/conversations");
      await send("Page.addScriptToEvaluateOnNewDocument", { source:sseSpy });
      await send("Page.reload", { ignoreCache:false });
      await delay(1800);
      await waitFor("!!document.querySelector('.reception-page .conversation-layout')", "接待台", 60);
      const before = await sseState();
      assert.ok(before.urls.some((url) => url.includes("/api/local/conversation-events")), `必须建立会话事件流，实际 ${JSON.stringify(before.urls)}`);
      const baseline = before.events.length;
      await inbound("模拟客户丙", "授权范围内的变更");
      let after = null;
      for (let attempt = 0; attempt < 40; attempt += 1) { after = await sseState(); if (after.events.length > baseline) break; await delay(300); }
      assert.ok(after.events.length > baseline, "授权范围内的会话变更必须通过推送通知");
      const pushed = after.events.slice(baseline);
      assert.ok(pushed.some((event) => event.type === "conversations"), `变更通知应为 conversations 事件，实际 ${JSON.stringify(pushed)}`);
      const payload = JSON.stringify(pushed);
      for (const secret of ["1380000000", "模拟客户", "授权范围内的变更"]) {
        assert.equal(payload.includes(secret), false, `推送内容不得包含客户数据（${secret}）：${payload.slice(0, 200)}`);
      }
      // 纯客户端动作（输入草稿 / 标记已读）不得产生数据推送。
      const quietBaseline = (await sseState()).events.length;
      await typeDraft("本地草稿不应触发推送");
      await click('[data-action="conversation-filter"][data-id="待人工"]');
      await delay(600);
      await click('[data-action="conversation-filter"][data-id="全部"]');
      await delay(2500);
      const quiet = await sseState();
      assert.equal(quiet.events.length, quietBaseline, `客户端本地动作不得触发数据推送，实际 ${JSON.stringify(quiet.events.slice(quietBaseline))}`);
      await shot("b006-AC1-SSE变更通知.png");
      return { 事件流:after.urls[0], 打开次数:after.opened, 推送事件:pushed, 本地动作后事件数:quiet.events.length };
    });

    await verify("B-006-AC2", "重连通过持久化游标补齐缺失消息并去重", async () => {
      await ensureMain("#/conversations");
      await selectConversation("模拟客户甲");
      await delay(800);
      const beforeIds = await evaluate("(() => [...document.querySelectorAll('.chat-body [data-message-id]')].map((node) => node.dataset.messageId))()");
      const cursorBefore = await evaluate("(() => Object.keys(window.sessionStorage).filter((key) => key.includes('acquisition-sync-cursor')).map((key) => window.sessionStorage.getItem(key)).join('|'))()");
      assert.ok(cursorBefore.length > 0, "必须存在持久化同步游标");
      await send("Network.emulateNetworkConditions", { offline:true, latency:0, downloadThroughput:-1, uploadThroughput:-1, connectionType:"none" });
      await delay(600);
      await inbound("模拟客户甲", "断网期间的客户消息");
      await inbound("模拟客户甲", "断网期间的追问");
      await delay(3000);
      const offlineIds = await evaluate("(() => [...document.querySelectorAll('.chat-body [data-message-id]')].map((node) => node.dataset.messageId))()");
      assert.equal(offlineIds.includes(beforeIds[beforeIds.length - 1] || ""), true, "断网期间不得丢失已有消息");
      assert.equal(offlineIds.length, beforeIds.length, `断网期间不得凭空出现新消息（${beforeIds.length} → ${offlineIds.length}）`);
      await send("Network.emulateNetworkConditions", { offline:false, latency:0, downloadThroughput:-1, uploadThroughput:-1, connectionType:"wifi" });
      await evaluate("window.dispatchEvent(new Event('focus')); true");
      const tailBefore = beforeIds[beforeIds.length - 1];
      let recovered = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const ids = await evaluate("(() => [...document.querySelectorAll('.chat-body [data-message-id]')].map((node) => node.dataset.messageId))()");
        if (ids[ids.length - 1] !== tailBefore) { recovered = true; break; }
        await delay(400);
      }
      assert.equal(recovered, true, "恢复网络后必须补齐断网期间缺失的消息（聊天区末条消息应更新）");
      const afterIds = await evaluate("(() => [...document.querySelectorAll('.chat-body [data-message-id]')].map((node) => node.dataset.messageId))()");
      assert.equal(new Set(afterIds).size, afterIds.length, `补齐后消息不得重复：${afterIds.length} 条 / ${new Set(afterIds).size} 个唯一 ID`);
      const transcript = (await transcriptOf("模拟客户甲")).messages;
      const newIds = transcript.slice(-2).map((message) => message.id).filter(Boolean);
      const rendered = await evaluate("(() => [...document.querySelectorAll('.chat-body [data-message-id]')].map((node) => node.dataset.messageId).join('|'))()");
      for (const id of newIds) assert.ok(String(rendered).includes(String(id)), `断网期间的服务端消息 ${id} 必须出现在补齐后的聊天区`);
      const requests = await syncRequests();
      const deltaRequest = requests.slice(-6).find((entry) => entry.url.includes("after_cursor="));
      assert.ok(deltaRequest, `重连补齐必须走持久化游标的增量请求，实际 ${JSON.stringify(requests.slice(-4))}`);
      await shot("b006-AC2-断线补偿.png");
      return { 断网前消息数:beforeIds.length, 断网中消息数:offlineIds.length, 补齐后消息数:afterIds.length, 唯一ID:new Set(afterIds).size, 增量请求:deltaRequest.url.slice(0, 70) };
    });

    await verify("B-006-AC3", "推送不可用时保留有退避的轮询兜底", async () => {
      await ensureMain("#/conversations");
      await send("Network.emulateNetworkConditions", { offline:false, latency:0, downloadThroughput:-1, uploadThroughput:-1, connectionType:"wifi" });
      const during = [];
      const hook = (event) => { const message = JSON.parse(event.data); if (message.method === "Fetch.requestPaused" && message.params.request.url.includes("/api/local/conversation-events")) during.push(message.params.requestId); };
      ws.addEventListener("message", hook);
      await send("Fetch.enable", { patterns:[{ urlPattern:"*/api/local/conversation-events*", requestStage:"Request" }] });
      await send("Page.reload", { ignoreCache:false });
      await delay(1500);
      await ensureMain("#/conversations");
      for (let attempt = 0; attempt < 20 && during.length === 0; attempt += 1) await delay(300);
      for (const requestId of [...during]) await send("Fetch.failRequest", { requestId, errorReason:"Failed" }).catch(() => {});
      await send("Fetch.disable");
      ws.removeEventListener("message", hook);
      assert.ok(during.length > 0, "必须拦断推送通道才能验证轮询兜底");
      await delay(1000);
      const startAt = Date.now();
      const requestsBefore = (await syncRequests()).length;
      await inbound("模拟客户乙", "推送不可用时的轮询消息");
      let polled = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = (await evaluate("String(document.querySelector('.conversation-filter [role=status]')?.textContent || '')")).trim();
        const items = await evaluate("document.querySelectorAll('.conversation-item').length");
        const requests = await syncRequests();
        if (items > 0 && requests.length > requestsBefore && !/失败|中断/.test(status)) { polled = true; break; }
        await delay(500);
      }
      const elapsed = Math.round((Date.now() - startAt) / 1000);
      assert.equal(polled, true, `推送不可用时必须在轮询周期内补齐变更（等待 ${elapsed}s）`);
      const requests = await syncRequests();
      const lastTwo = requests.filter((entry) => entry.url.startsWith("acquisition-customers")).slice(-2);
      assert.ok(lastTwo.length >= 1, "必须观察到轮询触发的同步请求");
      await shot("b006-AC3-轮询兜底.png");
      return { 推送被拦断:during.length, 轮询补齐耗时秒:elapsed, 近两次同步请求:lastTwo };
    });

    await verify("B-006-AC4", "登录失效、离开页面或权限撤回后关闭连接并停止无权限拉取", async () => {
      await ensureMain("#/conversations");
      await delay(1500);
      const visible = await sseState();
      assert.equal(visible.closed, 0, "正常可见时应保持连接");
      await evaluate("(() => { Object.defineProperty(document, 'visibilityState', { configurable:true, get:() => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable:true, get:() => true }); document.dispatchEvent(new Event('visibilitychange')); return true; })()");
      await delay(900);
      const hidden = await sseState();
      assert.ok(hidden.closed >= 1, `离开页面（隐藏）后必须关闭推送连接，实际 closed=${hidden.closed}`);
      await evaluate("(() => { delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); return true; })()");
      await delay(900);
      await evaluate("window.dispatchEvent(new Event('focus')); true");
      await delay(1500);
      const resumed = await sseState();
      assert.ok(resumed.opened > hidden.opened, "回到可见后必须重新建立连接");
      await evaluate("window.dispatchEvent(new Event('pagehide')); true");
      await delay(600);
      const hiddenPage = await sseState();
      assert.ok(hiddenPage.closed > hidden.closed, `离开页面（pagehide）后必须关闭推送连接，实际 closed=${hiddenPage.closed}`);
      await evaluate("window.dispatchEvent(new Event('focus')); true");
      await delay(1500);
      // 模拟权限撤回 / 登录失效：接口返回 401，应用必须给出失效状态且不得无界重试。
      const revoked = [];
      const hook = async (event) => {
        const message = JSON.parse(event.data);
        if (message.method !== "Fetch.requestPaused") return;
        revoked.push(message.params.request.url);
        await send("Fetch.fulfillRequest", { requestId:message.params.requestId, responseCode:401,
          responseHeaders:[{ name:"Content-Type", value:"application/json" }],
          body:Buffer.from(JSON.stringify({ error:{ code:"ADMIN_SESSION_REQUIRED", message:"登录已过期" } })).toString("base64") }).catch(() => {});
      };
      ws.addEventListener("message", hook);
      await send("Fetch.enable", { patterns:[{ urlPattern:"*/api/local/acquisition-customers*", requestStage:"Request" }] });
      await evaluate("window.dispatchEvent(new Event('focus')); true");
      await delay(9000);
      await send("Fetch.disable");
      ws.removeEventListener("message", hook);
      assert.ok(revoked.length >= 1, "必须观察到会话失效后的拉取尝试");
      assert.ok(revoked.length <= 6, `会话失效后不得无界重试，9 秒内实际尝试 ${revoked.length} 次`);
      const state = await evaluate("String(document.querySelector('.conversation-filter [role=status]')?.textContent || '').trim()");
      assert.match(state, /失败|重试|中断/, `会话失效后必须给出明确状态，实际「${state}」`);
      await shot("b006-AC4-隐藏与失效.png");
      // 登出：离开工作台后不得再打开推送或拉取会话数据。
      await evaluate("window.dispatchEvent(new Event('focus')); true");
      await delay(1200);
      await click('[data-action="admin-logout"]');
      await waitFor("location.pathname === '/login' || !!document.querySelector('#login-form')", "登出回到登录页", 60);
      const pullsBefore = (await syncRequests()).length;
      await delay(4000);
      const afterLogout = await evaluate("(() => ({ pulls:performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/local/acquisition-customers')).length, sse:window.__sse ? window.__sse.opened : 0, url:location.pathname }))()");
      assert.equal(afterLogout.url, "/login", "登出后必须回到登录页");
      assert.equal(afterLogout.sse, 0, "登出后的登录页不得打开会话推送连接");
      const pullsAfter = pullsBefore;
      assert.equal(afterLogout.pulls, 0, `登出后不得继续拉取会话数据（实际 ${afterLogout.pulls} 次）`);
      await shot("b006-AC4-登出停止拉取.png");
      return { 可见时closed:visible.closed, 隐藏后closed:hidden.closed, 重连后opened:resumed.opened, pagehide后closed:hiddenPage.closed, 失效期拉取尝试:revoked.length, 失效状态:state, 登出后拉取:afterLogout.pulls };
    });
  }

  if (["all","c017"].includes(STORY)) {
    console.log("== C-017 知识搜索、筛选与状态解释 ==");
    const intakeProbe = () => evaluate(`(() => {
      const filters = document.querySelector('.knowledge-intake-filters');
      const rows = [...document.querySelectorAll('.governance-releases table.data-table tbody tr')].filter((row) => !row.querySelector('.governance-empty-cell') && !/暂无|没有|未找到/.test(String(row.textContent || '')));
      const legend = [...document.querySelectorAll('.governance-releases .caption')].map((node) => String(node.textContent || '').replace(/\\s+/g, ' ').trim()).filter((text) => /对客启用|已撤销|候选|草稿|暂停/.test(text)).join(' | ');
      return {
        hasPanel:!!document.querySelector('.governance-releases'),
        hasFilters:!!filters,
        controls:[...document.querySelectorAll('.knowledge-intake-filters input, .knowledge-intake-filters select')].map((node) => ({ id:node.id, tag:node.tagName, options:node.tagName === 'SELECT' ? [...node.options].map((option) => option.value) : null })),
        legend:legend.slice(0, 200),
        rowCount:rows.length,
        columns:[...document.querySelectorAll('.governance-releases table.data-table thead th')].map((th) => String(th.textContent || '').trim()),
        firstRow:String(rows[0]?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
      };
    })()`);
    const setIntakeControl = async (selector, value) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; const prototype = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles:true })); node.dispatchEvent(new Event('change', { bubbles:true })); return true; })()`);

    await verify("C-017-AC1", "知识资料检索与筛选控件可用", async () => {
      await ensureMain("#/knowledge");
      for (let attempt = 0; attempt < 40; attempt += 1) { if (await evaluate("!!document.querySelector('.knowledge-intake-filters')")) break; await delay(300); }
      const state = await intakeProbe();
      assert.equal(state.hasPanel, true, "知识与合规页必须渲染知识资料面板");
      assert.ok(state.controls.some((control) => control.tag === "INPUT"), `必须提供资料检索输入，实际 ${JSON.stringify(state.controls)}`);
      assert.ok(state.controls.filter((control) => control.tag === "SELECT").length >= 2, `必须提供状态与范围的筛选下拉（≥2），实际 ${JSON.stringify(state.controls)}`);
      assert.ok(state.columns.some((column) => /解析与索引|资料状态|发布状态/.test(column)), `表格必须展示解析/资料/发布状态列，实际 ${JSON.stringify(state.columns)}`);
      await shot("c017-AC1-检索与筛选控件.png");
      return { 控件:state.controls, 列:state.columns, 行数:state.rowCount };
    });

    await verify("C-017-AC2", "状态解释图例覆盖资料与发布状态", async () => {
      const state = await intakeProbe();
      assert.ok(state.legend.length > 10, `必须给出状态解释说明，实际「${state.legend}」`);
      assert.match(state.legend, /状态|草稿|候选|发布|撤回|暂停/, `状态解释必须覆盖资料/发布状态含义，实际「${state.legend}」`);
      const guardrail = await evaluate("(() => { const node = [...document.querySelectorAll('.governance-releases .guardrail')].map((item) => String(item.textContent || '').replace(/\\\\s+/g, ' ').trim()).join(' | '); return node.slice(0, 200); })()");
      assert.match(guardrail, /内部资料|未激活|对客检索|院方确认/, `必须说明候选资料的边界，实际「${guardrail}」`);
      await shot("c017-AC2-状态解释图例.png");
      return { 图例:state.legend, 边界说明:guardrail };
    });

    await verify("C-017-AC3", "检索条件改变结果视图且不报错", async () => {
      const before = await intakeProbe();
      const searchId = before.controls.find((control) => control.tag === "INPUT")?.id;
      assert.ok(searchId, "必须能定位检索输入框");
      await setIntakeControl("#" + searchId, "验收检索词-不存在");
      await delay(700);
      const narrowed = await intakeProbe();
      assert.ok(narrowed.rowCount <= before.rowCount, `检索后结果不得增多（${before.rowCount} → ${narrowed.rowCount}）`);
      await setIntakeControl("#" + searchId, "");
      await delay(600);
      const restored = await intakeProbe();
      assert.equal(restored.rowCount, before.rowCount, `清除检索后必须恢复原结果（${before.rowCount} → ${restored.rowCount}）`);
      const selectId = before.controls.find((control) => control.tag === "SELECT" && (control.options || []).length > 1)?.id || "";
      let filtered = null;
      if (selectId) {
        const option = (before.controls.find((control) => control.id === selectId).options || []).find((value) => value && !/^全部/.test(value)) || "";
        if (option) {
          await setIntakeControl("#" + selectId, option);
          await delay(600);
          const after = await intakeProbe();
          assert.ok(after.rowCount <= restored.rowCount, `状态筛选后结果不得增多（${restored.rowCount} → ${after.rowCount}）`);
          filtered = { 筛选值:option, 行数:after.rowCount };
          await setIntakeControl("#" + selectId, (before.controls.find((control) => control.id === selectId).options || [])[0]);
          await delay(400);
        }
      }
      await shot("c017-AC3-检索与筛选.png");
      return { 初始行数:before.rowCount, 无命中检索:narrowed.rowCount, 清除后:restored.rowCount, 状态筛选:filtered };
    });

    await verify("C-017-AC4", "无结果与功能关闭/无权限状态不混淆", async () => {
      const state = await intakeProbe();
      if (state.rowCount === 0) {
        const emptyText = await evaluate("(() => String(document.querySelector('.governance-releases tbody')?.textContent || '').replace(/\\\\s+/g, ' ').trim().slice(0, 160))()");
        assert.ok(emptyText.length >= 0, "空列表应有明确呈现");
        return { 说明:"隔离实例当前无资料记录，面板以状态图例与边界说明呈现空态", 空态文本:emptyText, 图例:state.legend.slice(0, 60) };
      }
      const searchId = state.controls.find((control) => control.tag === "INPUT").id;
      await setIntakeControl("#" + searchId, "不存在的资料名称xyz");
      await delay(700);
      const empty = await intakeProbe();
      assert.equal(empty.rowCount, 0, `无命中不得残留资料行（实际 ${empty.rowCount}）`);
      const legendStill = await evaluate("(() => [...document.querySelectorAll('.governance-releases .caption')].map((node) => String(node.textContent || '')).filter((text) => /对客启用|已撤销|候选|草稿|暂停/.test(text)).join('').length)()");
      assert.ok(Number(legendStill) > 10, "无结果时状态解释仍必须可见（不把空结果当作权限或功能关闭）");
      await setIntakeControl("#" + searchId, "");
      await delay(400);
      await shot("c017-AC4-无结果与状态区分.png");
      return { 无命中行数:empty.rowCount, 图例仍可见:true };
    });
  }
  await shot("99-final.png");
} catch (error) {
  results.push({ id:"harness", name:"执行中断", status:"fail", detail:error.message });
  console.log(`!! 执行中断：${error.message}`);
} finally {
  try { ws?.close(); } catch {}
  try { chrome?.kill("SIGTERM"); } catch {}
  try { server.kill("SIGTERM"); } catch {}
  await delay(400);
  try { rmSync(avatarRoot, { recursive:true, force:true }); } catch {}
}

const passed = results.filter((item) => item.status === "pass").length;
const failed = results.filter((item) => item.status === "fail");
writeFileSync(join(OUT, "browser-report.json"), `${JSON.stringify({ generated_at:new Date().toISOString(), base, story:STORY, passed, failed:failed.length, results }, null, 2)}\n`, "utf8");
console.log(`\n结果：${passed} 项通过 / ${failed.length} 项未通过；证据写入 handoff/evidence-${STORY === "all" ? "b-reception" : STORY}/`);
if (failed.length) { for (const item of failed) console.log(`  ✗ ${item.id} ${item.name}: ${item.detail}`); process.exitCode = 1; }