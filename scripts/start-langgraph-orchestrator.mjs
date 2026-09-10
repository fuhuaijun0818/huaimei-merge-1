import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  process.loadEnvFile(join(root, ".env.local"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const serviceRoot = join(root, "agent-orchestrator");
const python = join(serviceRoot, ".venv", "bin", "python");
const host = String(process.env.HUAMEI_LANGGRAPH_HOST || "127.0.0.1").trim();
const port = Number(process.env.HUAMEI_LANGGRAPH_PORT || 4192);
const secret = String(process.env.HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET || "").trim();

if (!existsSync(python)) {
  throw new Error("LANGGRAPH_RUNTIME_MISSING: 请先按 agent-orchestrator/README.md 创建隔离 Python 环境");
}
if (!secret) {
  throw new Error("LANGGRAPH_SERVICE_AUTH_SECRET_REQUIRED: 请仅在 .env.local 配置独立服务密钥");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("LANGGRAPH_PORT_INVALID");
}

const child = spawn(python, [
  "-m", "uvicorn", "app.main:app",
  "--host", host,
  "--port", String(port),
  "--no-access-log"
], { cwd:serviceRoot, env:process.env, stdio:"inherit" });

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = code || 0;
});
