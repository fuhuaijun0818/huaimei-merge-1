import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(app, /KNOWLEDGE_INTAKE_FILTER_STORAGE_KEY/, "知识资料筛选必须有独立的会话状态键");
assert.match(app, /globalThis\.sessionStorage\?\.getItem\(KNOWLEDGE_INTAKE_FILTER_STORAGE_KEY\)/, "刷新后必须从当前标签页会话恢复筛选");
assert.match(app, /knowledgeIntakeQuery: initialKnowledgeIntakeFilters\.query/, "初始查询条件必须使用已恢复状态");
assert.match(app, /persistKnowledgeIntakeFilterState\(\);[\s\S]{0,180}__knowledgeIntakeSearchTimer/, "输入查询时必须立即持久化筛选状态");
assert.match(app, /clearKnowledgeIntakeFilterState\(\);[\s\S]{0,100}hydrateKnowledgeIntake/, "清除筛选必须同步清理会话状态");
assert.match(app, /logoutAdminSession\(\);clearKnowledgeIntakeFilterState\(\)/, "退出登录后不得保留上一账号的资料筛选");
assert.doesNotMatch(app, /globalThis\.localStorage.*KNOWLEDGE_INTAKE_FILTER_STORAGE_KEY/, "资料筛选不得写入跨会话 localStorage");

console.log("✓ 知识资料筛选可跨刷新恢复，并仅保留在当前浏览器标签页");
