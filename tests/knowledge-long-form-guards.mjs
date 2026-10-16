// C-030 AC3/AC4：长表单未保存要提醒、重复点击不重复提交、取消不写入。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

// 1. 未保存提醒覆盖长表单
assert.match(app, /const UNSAVED_GUARD_FORM_IDS = new Set\(\["knowledge-intake-form", "knowledge-maintenance-form", "configuration-record-form", "publication-form", "product-form", "journey-create-form", "agent-form"\]\)/, "未保存提醒必须覆盖长表单与发布相关表单");
assert.match(app, /const isGuardedFormTarget = \(target\) => \{/, "必须能判断事件是否来自受保护表单");
assert.equal((app.match(/if \(isGuardedFormTarget\(event\.target\)\) markUnsavedFormDirty\(true\);/g) || []).length, 2, "input 与 change 都要标记为未保存");
assert.match(app, /if \(unsavedFormDirty && !globalThis\.confirm\("当前表单有未保存的修改，确定放弃并关闭吗？"\)\) break;/, "关闭含未保存修改的弹窗必须先确认");
assert.match(app, /window\.addEventListener\("beforeunload", \(event\) => \{[\s\S]{0,400}?if \(unsavedFormDirty\) event\.preventDefault\(\);/, "存在未保存内容时离开页面要二次确认");
assert.match(app, /if \(UNSAVED_GUARD_FORM_IDS\.has\(form\.id\) && !document\.querySelector\("\.modal-backdrop"\)\) markUnsavedFormDirty\(false\);/, "提交成功后必须清除未保存标记，失败则保留提醒");

// 2. 重复点击不重复提交
assert.match(app, /if \(form\.dataset\.submitting === "true"\) return;/, "提交进行中必须忽略同一表单的再次提交");
assert.match(app, /const submitter = form\.querySelector\('button\[type="submit"\]'\);/, "必须定位提交按钮以便禁用");
assert.match(app, /form\.dataset\.submitting = "true";\n\s*if \(submitter\) submitter\.disabled = true;/, "提交时必须立刻禁用按钮");
assert.match(app, /\} finally \{\n\s*form\.dataset\.submitting = "false";\n\s*if \(submitter\?\.isConnected\) submitter\.disabled = false;/, "提交结束后必须恢复按钮状态");

// 3. 取消不写入：发布写操作只能出现在表单提交分支里
const publishWriteCalls = app.match(/await writeKnowledgePublication\(/g) || [];
assert.equal(publishWriteCalls.length, 1, "发布写操作只允许有一个调用点（表单提交），取消路径不得写入");
assert.match(app, /case "modal-close":\n\s*if \(unsavedFormDirty/, "取消/关闭走的是弹窗关闭分支，不触发写入");

// 4. 发布、撤回、回滚要显示具体对象与影响
assert.match(app, /回滚影响对比/, "回滚必须展示影响对比");
assert.match(app, /当前对客启用/, "回滚必须展示当前启用版本供比较");
assert.match(app, /回滚后不再对客可见/, "回滚必须列出受影响资料");

console.log("✓ 长表单未保存提醒、防重复提交、取消不写入与发布影响展示均已具备");
