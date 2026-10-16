import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { summarizePublicationRollback } from "../src/modules/knowledge/publication-rollback-diff.js";

const document = (id, title, version, department = "demo") => ({ id, title, version, department, expires_at:"2026-12-31T00:00:00.000Z" });
const pkg = (id, documents, chunkCount) => ({ id, documents, chunk_count:chunkCount, checksum:`checksum-${id}` });

// 1. 目标包含改版资料与新增资料：必须逐条列出，并给出影响摘要
const downgrade = summarizePublicationRollback({
  current:pkg("kpub_current", [document("doc-1", "回滚验收资料 A", 2)], 3),
  target:pkg("kpub_target", [document("doc-1", "回滚验收资料 A", 1), document("doc-2", "公开海报", 1, "皮肤科")], 2)
});
assert.equal(downgrade.has_current, true);
assert.equal(downgrade.same_package, false);
assert.deepEqual(downgrade.version_changed.map((item) => [item.id, item.from_version, item.to_version]), [["doc-1", 2, 1]]);
assert.deepEqual(downgrade.added.map((item) => item.id), ["doc-2"]);
assert.deepEqual(downgrade.removed, []);
assert.deepEqual(downgrade.departments, ["demo", "皮肤科"]);
assert.match(downgrade.impact, /新增或改版 2 份/);
assert.match(downgrade.impact, /停用 0 份/);
assert.equal(downgrade.target.document_count, 2);
assert.equal(downgrade.current.document_count, 1);

// 2. 回滚后不再对客可见的资料必须单独列出
const withRemoval = summarizePublicationRollback({
  current:pkg("kpub_current", [document("doc-1", "资料一", 1), document("doc-9", "已下线资料", 4)], 4),
  target:pkg("kpub_target", [document("doc-1", "资料一", 1)], 1)
});
assert.deepEqual(withRemoval.removed.map((item) => item.id), ["doc-9"]);
assert.deepEqual(withRemoval.version_changed, []);
assert.deepEqual(withRemoval.unchanged.map((item) => item.id), ["doc-1"]);
assert.match(withRemoval.impact, /停用 1 份/);

// 3. 当前没有启用版本时不得伪造对比，要明确说明影响
const noCurrent = summarizePublicationRollback({ current:null, target:pkg("kpub_target", [document("doc-1", "资料一", 1)], 1) });
assert.equal(noCurrent.has_current, false);
assert.equal(noCurrent.current, null);
assert.match(noCurrent.impact, /当前没有对客启用版本/);

// 4. 目标包就是当前启用版本时不得声称内容变化
const samePackage = summarizePublicationRollback({ current:pkg("kpub_same", [document("doc-1", "资料一", 1)], 1), target:pkg("kpub_same", [document("doc-1", "资料一", 1)], 1) });
assert.equal(samePackage.same_package, true);
assert.match(samePackage.impact, /内容与版本不变|有效版本与内容不变/);

// 5. 两个包内容一致但包不同：差异清单为空，影响只描述版本切换
const identical = summarizePublicationRollback({ current:pkg("kpub_a", [document("doc-1", "资料一", 3)], 2), target:pkg("kpub_b", [document("doc-1", "资料一", 3)], 2) });
assert.deepEqual(identical.added, []);
assert.deepEqual(identical.removed, []);
assert.deepEqual(identical.version_changed, []);
assert.deepEqual(identical.unchanged.map((item) => item.id), ["doc-1"]);
assert.match(identical.impact, /完全一致/);

// 6. 缺失目标包时不得抛异常，也要明确提示无法计算
const missingTarget = summarizePublicationRollback({ current:pkg("kpub_a", [document("doc-1", "资料一", 1)], 1), target:null });
assert.equal(missingTarget.target, null);
assert.match(missingTarget.impact, /目标包信息缺失/);

// 7. 回滚弹窗必须真正渲染对比区块，而不是只保留“已核对影响范围”的勾选框
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /import \{ summarizePublicationRollback \} from "\.\/modules\/knowledge\/publication-rollback-diff\.js"/, "回滚对比逻辑必须来自 C 负责模块");
assert.match(app, /action==='rollback'\?publicationRollbackComparisonBlock\(pkg\):''/, "只有回滚操作需要展示差异与影响");
assert.match(app, /回滚影响对比/, "回滚弹窗必须给出影响对比");
assert.match(app, /当前对客启用/, "必须展示当前启用版本，供操作人比较");
assert.match(app, /差异明细/, "必须展示逐条差异");
assert.match(app, /回滚后不再对客可见/, "必须说明回滚后哪些资料不再对客可见");
assert.match(app, /涉及科室：/, "必须说明影响范围");

console.log("✓ 回滚差异与影响对比：新增/改版/停用/未变化、无当前版本、同包、内容一致与缺失目标均正确");
