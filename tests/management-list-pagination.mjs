import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, styles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8")
]);

assert.match(app, /function hydrateListPagination\(\)/, "管理端需要在每次页面渲染后统一挂载列表分页");
assert.match(app, /function listPaginationState\(key, total\)/, "分页状态需要根据筛选后的总数自动校正页码");
assert.match(app, /if \(!items\.length\) \{[\s\S]*?existingPager\?\.remove\(\)/, "筛选结果为空时必须移除旧分页器，不能保留过期总数和页码");
assert.match(app, /data-action="list-page"/, "分页器需要提供页码切换操作");
assert.match(app, /data-pagination-size/, "分页器需要允许维护每页条数");
assert.match(app, /data-paginated-list="journeys"/, "旅程卡片列表需要纳入统一分页");
assert.match(app, /data-paginated-list="agents"/, "AI员工卡片列表需要纳入统一分页");
assert.match(app, /data-paginated-list="physicians"/, "医师卡片列表需要纳入统一分页");
assert.match(app, /data-paginated-list="conversations"/, "会话收件箱需要纳入统一分页");
assert.match(styles, /\.data-table tbody tr\[hidden\]/, "非当前页表格行需要隐藏");
assert.match(styles, /\.collection-pagination/, "卡片列表分页器需要有独立视觉样式");

console.log("✓ 管理后台列表分页组件、表格挂载和卡片列表接入已校验");
