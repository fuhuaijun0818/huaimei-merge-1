import assert from "node:assert/strict";

const attack = `\"><img src=x onerror=globalThis.__huamei_xss=1>`;
const values = new Map();
globalThis.localStorage = {
  getItem:(key) => values.get(key) || null,
  setItem:(key, value) => values.set(key, String(value)),
  removeItem:(key) => values.delete(key)
};

const { sanitizeDisplayData, store } = await import(`../src/store.js?xss-boundary=${Date.now()}`);
const sanitized = sanitizeDisplayData({
  name:attack,
  profile:{ concern:`&quot; onmouseover=alert(1)` },
  photo:"javascript:alert(1)"
});
assert.doesNotMatch(sanitized.name, /[&<>"'`]/);
assert.doesNotMatch(sanitized.profile.concern, /[&<>"'`]/);
assert.equal(sanitized.photo, "", "不受信任图片URL协议必须失败关闭");

store.upsertAcquisitionSnapshot({
  customers:[{
    id:"C-AI-XSS",
    origin:"acquisition_advisor",
    name:attack,
    mobile:"138****0000",
    profile:{ concern:attack },
    tags:[attack],
    timeline:[]
  }],
  conversations:[{
    id:"V-AI-XSS",
    customerId:"C-AI-XSS",
    lastMessage:attack,
    messages:[{ id:"M-XSS", from:"customer", text:attack }]
  }],
  tasks:[{ id:"T-AI-XSS", customerId:"C-AI-XSS", title:attack }]
});
const remoteMaterial = JSON.stringify({
  customer:store.customer("C-AI-XSS"),
  conversation:store.conversation("V-AI-XSS"),
  task:store.task("T-AI-XSS")
});
assert.doesNotMatch(remoteMaterial, /[<>&]/, "服务端快照进入legacy innerHTML视图前必须消除HTML分隔符");

let modalMarkup = "";
const modalRoot = {
  contains:() => false,
  querySelector:() => null,
  querySelectorAll:() => [],
  get innerHTML() { return modalMarkup; },
  set innerHTML(value) { modalMarkup = String(value); }
};
globalThis.document = {
  activeElement:null,
  addEventListener:() => {},
  querySelector:(selector) => selector === "#modal-root" ? modalRoot : null
};
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };

const { avatar, openModal } = await import(`../src/ui.js?xss-boundary=${Date.now()}`);
openModal({ title:attack, desc:attack, body:"<p>trusted template body</p>" });
assert.doesNotMatch(modalMarkup, /<img src=x/i, "弹窗标题和说明不得变成可执行标记");
assert.match(modalMarkup, /&lt;img/, "弹窗文本必须HTML转义");
assert.doesNotMatch(avatar({ name:"X", photo:"javascript:alert(1)", photoConsent:"已授权" }), /javascript:/i);

console.log("✓ 管理端客户快照、本地输入、弹窗文本与图片URL的XSS边界通过");
