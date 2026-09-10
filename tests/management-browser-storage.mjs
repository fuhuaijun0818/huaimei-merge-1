import assert from "node:assert/strict";

const values = new Map();
globalThis.localStorage = {
  getItem:(key) => values.has(key) ? values.get(key) : null,
  setItem:(key, value) => values.set(key, String(value)),
  removeItem:(key) => values.delete(key)
};

const storageKey = "huamei-ai-saas-mvp-v1";
values.set(storageKey, JSON.stringify({
  meta:{ version:3, businessCopyVersion:2 },
  customers:[{ id:"real-customer", origin:"acquisition_advisor", name:"真实客户" }],
  conversations:[{ id:"real-conversation", customerId:"real-customer", messages:[{ text:"敏感沟通" }] }],
  tasks:[{ id:"real-task", customerId:"real-customer" }],
  handovers:[{ id:"ho_deadbeef", summary:"医疗边界摘要" }]
}));

const { store } = await import(`../src/store.js?browser-storage=${Date.now()}`);
assert.equal(store.state.customers.some((item) => item.id === "real-customer"), false, "历史localStorage中的真实客户必须在加载时清理");
assert.equal(store.state.conversations.some((item) => item.id === "real-conversation"), false);
assert.equal(store.state.tasks.some((item) => item.id === "real-task"), false);
assert.deepEqual(store.state.handovers, []);

assert.equal(values.has(storageKey), false, "服务端持久化模式必须删除历史浏览器缓存");

store.state.customers.push({ id:"live-customer", origin:"acquisition_advisor", name:"会话期客户" });
store.state.conversations.push({ id:"live-conversation", customerId:"live-customer", messages:[{ text:"仅内存" }] });
store.state.tasks.push({ id:"live-task", customerId:"live-customer" });
store.state.handovers.push({ id:"ho_cafebabe", summary:"仅内存接管摘要" });
store.save("test");

assert.equal(store.state.customers.some((item) => item.id === "live-customer"), true, "当前会话内存数据不应被清除");
assert.equal(values.has(storageKey), false, "任何管理写操作都不能重新把客户、会话或接管信息写入浏览器localStorage");

console.log("✓ 真实客户、会话与人工接管数据不落浏览器localStorage");
