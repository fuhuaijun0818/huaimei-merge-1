import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonStateStore } from "../server/platform/json-state-store.mjs";
const directory = mkdtempSync(join(tmpdir(), "huamei-state-failure-"));
const parent = join(directory,"blocked");
process.env.HUAMEI_TEST_JSON_STATE_FILE = join(parent,"state.json");
try {
 const store = createJsonStateStore({envName:"HUAMEI_TEST_JSON_STATE_FILE", defaultFile:"unused", initialState:{version:1}});
 writeFileSync(parent,"filesystem failure fixture");
 assert.throws(()=>store.save({version:2}));
 assert.equal(store.load().version,1,"写盘失败不能把未持久化状态当作成功保留");
 rmSync(parent);
 store.save({version:2});
 const reopened = createJsonStateStore({envName:"HUAMEI_TEST_JSON_STATE_FILE", defaultFile:"unused", initialState:{version:1}});
 assert.equal(reopened.load().version,2);
 console.log("✓ JSON持久化失败保持原状态，恢复后可重试并重新加载");
} finally { rmSync(directory,{recursive:true,force:true}); }
