// A-030 LangGraph 编排渐进接入验收（Node 契约 + 隔离库 Turn 协议 + 真实 LangGraph 服务 + Python 编排单测）。
// 用法：node handoff/tool-a030-langgraph-acceptance.mjs
// Python 运行时：agent-orchestrator/.venv（Windows 上需过滤 POSIX-only 的 uvloop：
//   python -m venv .venv && .venv/Scripts/python -m pip install -r <requirements.lock 去掉 uvloop 行>）
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "handoff", "evidence-a030");
mkdirSync(OUT, { recursive:true });
const checks = [];
const run = (label, command, options = {}) => {
  const started = Date.now();
  const result = spawnSync(command, { shell:true, cwd:root, encoding:"utf8", timeout:600_000, maxBuffer:16 * 1024 * 1024, ...options });
  const tail = (`${result.stdout || ""}${result.stderr || ""}`).trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) || "";
  checks.push({ label, command, exit_code:result.status, duration_ms:Date.now() - started, tail });
  console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${label} :: ${tail}`);
  return result.status === 0;
};
const python = [join(root, "agent-orchestrator", ".venv", "bin", "python.exe"), join(root, "agent-orchestrator", ".venv", "bin", "python"), join(root, "agent-orchestrator", ".venv", "Scripts", "python.exe")].find((candidate) => existsSync(candidate));
assert.ok(python, "需要 agent-orchestrator/.venv 的 Python 运行时（见脚本头部说明）");
const needsPostgres = existsSync(join(root, "deploy", "local", ".env"));
assert.ok(needsPostgres, "隔离库连接文件 deploy/local/.env 缺失，无法验证持久 checkpoint");

run("Node 编排契约（shadow 准入、脱敏线程、非副作用中断、turn 协议迁移）", "node tests/langgraph-orchestrator-contract.mjs");
run("真实 LangGraph 服务 live 契约（服务令牌、契约闭环、shadow 决策比较）", "node tests/langgraph-orchestrator-live-contract.mjs");
run(`Python 编排单测（引擎版本/schema/回滚路径）`, `"${python}" -m unittest discover -s tests -v`, { cwd:join(root, "agent-orchestrator") });
run("隔离库 Turn 协议（顺序、租约、fencing、prepared/commit 重放、无外发边界）", "node --env-file=deploy/local/.env tests/postgres-langgraph-turn-protocol-integration.mjs");
const failed = checks.filter((item) => item.exit_code !== 0);
writeFileSync(join(OUT, "a030-langgraph-report.json"), `${JSON.stringify({
  generated_at:new Date().toISOString(),
  python_runtime:python.replace(root, "."),
  note:"Windows 下 uvloop 无可用 wheel，安装依赖时按平台过滤该 POSIX-only 包；不影响编排契约与 checkpoint 验证。",
  checks
}, null, 2)}\n`, "utf8");
console.log(`\nA-030：${checks.length - failed.length}/${checks.length} 项通过；证据写入 handoff/evidence-a030/`);
if (failed.length) process.exitCode = 1;
