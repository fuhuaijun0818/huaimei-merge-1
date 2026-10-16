// C-017 AC4：无结果、加载失败、无权限必须是三种不同的提示，而且不能静默消失。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

// 1. 无结果 ≠ 无数据
assert.match(app, /const filterActive = Boolean\(ui\.knowledgeIntakeQuery \|\| ui\.knowledgeIntakeStatus \|\| ui\.knowledgeIntakeContentType \|\| ui\.knowledgeIntakePublicScope\)/, "空态文案必须知道当前是否处于筛选状态");
assert.match(app, /filterActive \? "没有匹配的资料。可调整关键词或筛选条件，或点击上方“清除筛选”后再试。" : "暂无录入资料。上传后先保存为内部草稿。"/, "筛选零结果与资料库为空必须给出不同文案");
assert.doesNotMatch(app, /\|\| `<tr><td colspan="8" class="governance-empty-cell">暂无录入资料。上传后先保存为内部草稿。<\/td><\/tr>`/, "不得对筛选零结果也显示“暂无录入资料”");

// 2. 加载失败要有明确说明和重试入口
assert.match(app, /ui\.knowledgeIntakeError \? `<div class="risk-banner">[\s\S]{0,400}?资料列表暂时无法读取[\s\S]{0,400}?data-action="refresh-knowledge-intake"[\s\S]{0,400}?重试[\s\S]{0,200}?错误码：\$\{escapeHtml\(ui\.knowledgeIntakeError\)\}/, "加载失败必须提示原因、给出重试按钮并展示错误码");

// 3. 无权限不能静默隐藏
assert.match(app, /if \(!knowledgeIntakeEnabled\) return "";\n\s*\/\/ 无权限不能静默消失[\s\S]{0,120}?if \(!hasCapability\("knowledge:read"\)\) \{/, "缺少查看能力时必须走独立分支");
assert.match(app, /当前岗位没有“查看知识资料”的权限，资料列表不可见。如需处理资料，请由系统管理员调整岗位能力或改用有权限的账号。/, "无权限必须给出可理解的提示与下一步");
assert.doesNotMatch(app, /if \(!knowledgeIntakeEnabled \|\| !hasCapability\("knowledge:read"\)\) return "";/, "不得再用一个 return \"\" 同时吞掉功能关闭与无权限");
assert.doesNotMatch(app, /hasCapability\("knowledge:read"\) \? knowledgeIntakePanel\(\) : ""/, "调用处不得再按权限跳过面板渲染，否则无权限时仍然看不到提示");

console.log("✓ 无结果、加载失败、无权限三种提示彼此不同，且无权限时会明确说明而不是静默隐藏");
