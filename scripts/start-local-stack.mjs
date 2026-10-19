import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  inspectLocalOfficialGraphRag,
  validateOfficialGraphRagReadiness
} from "./local-graphrag-admission.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  process.loadEnvFile(join(root, ".env.local"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
// Ephemeral, process-tree-only proof used by the loopback management BFF.
// It is never written to .env, returned to the browser or accepted in prod.
if (!process.env.HUAMEI_LOCAL_ADMIN_BRIDGE_SECRET) {
  process.env.HUAMEI_LOCAL_ADMIN_BRIDGE_SECRET = randomBytes(32).toString("base64url");
}
if (!process.env.HUAMEI_LOCAL_ADMIN_SUBJECT) process.env.HUAMEI_LOCAL_ADMIN_SUBJECT = "local-admin";

const servicePort = Number(process.env.HUAMEI_ACQUISITION_SERVICE_PORT || 4180);
const serviceHost = process.env.HUAMEI_ACQUISITION_SERVICE_HOST || "127.0.0.1";
const serviceUrl = String(process.env.HUAMEI_ACQUISITION_SERVICE_URL || `http://${serviceHost}:${servicePort}`).replace(/\/+$/, "");
const externallyManaged = String(process.env.HUAMEI_ACQUISITION_SERVICE_MANAGED_EXTERNALLY || "false").toLowerCase() === "true";
const graphPort = Number(process.env.HUAMEI_GRAPHRAG_PORT || 4191);
const graphHost = process.env.HUAMEI_GRAPHRAG_HOST || "127.0.0.1";
const graphUrl = String(process.env.HUAMEI_GRAPHRAG_URL || `http://${graphHost}:${graphPort}`).replace(/\/+$/, "");
const graphExternallyManaged = String(process.env.HUAMEI_GRAPHRAG_MANAGED_EXTERNALLY || "false").toLowerCase() === "true";
const graphExplicitlyDisabled = String(process.env.HUAMEI_GRAPHRAG_ENABLED || "").toLowerCase() === "false";
const graphPython = join(root, ".venv-graphrag", "bin", "python");
const localPath = (value, fallback) => {
  const selected = String(value || fallback);
  return isAbsolute(selected) ? selected : resolve(root, selected);
};
const graphIndexRoot = localPath(
  process.env.HUAMEI_GRAPHRAG_INDEX_ROOT,
  join(root, "graphrag-service", "data", "indexes")
);
const graphOfficialProjectRoot = localPath(
  process.env.HUAMEI_GRAPHRAG_OFFICIAL_PROJECT_ROOT,
  join(root, "graphrag-service", "graphrag_project")
);
const graphLocalAdmission = inspectLocalOfficialGraphRag({
  indexRoot:graphIndexRoot,
  officialProjectRoot:graphOfficialProjectRoot,
  configuredVersion:process.env.HUAMEI_GRAPHRAG_INDEX_VERSION
});
const graphAvailableLocally = existsSync(graphPython) && graphLocalAdmission.admitted;
const graphRequested = !graphExplicitlyDisabled && (graphExternallyManaged || graphAvailableLocally);
const children = [];
let stopping = false;
let finishSupervisor;
const supervisorDone = new Promise((resolve) => { finishSupervisor = resolve; });

const runProcess = (command, args, label) => {
  const child = spawn(command, args, { cwd:root, env:process.env, stdio:"inherit" });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${label} 已退出（${signal || code}），正在停止本地服务组。`);
    stop(code || 1);
  });
  return child;
};
const runNode = (entry) => runProcess(process.execPath, [join(root, entry)], entry);

const waitForService = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${serviceUrl}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`售前智能体独立服务未能在预期时间内就绪：${serviceUrl}`);
};

const waitForGraph = async (expectedVersion = "") => {
  let lastCode = "GRAPHRAG_SERVICE_UNREACHABLE";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let response;
    try {
      response = await fetch(`${graphUrl}/ready`);
    } catch {
      await delay(100);
      continue;
    }
    if (!response.ok) {
      lastCode = `GRAPHRAG_READY_HTTP_${response.status}`;
      await delay(100);
      continue;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("GRAPHRAG_READY_RESPONSE_INVALID");
    }
    const admission = validateOfficialGraphRagReadiness(payload, { expectedVersion });
    if (!admission.admitted) throw new Error(admission.code);
    return admission;
  }
  throw new Error(`GraphRAG检索服务未能以正式引擎就绪：${lastCode}`);
};

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  setTimeout(() => finishSupervisor(exitCode), 300);
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

if (graphRequested) {
  // Acquisition stays fail-closed until the live service proves that the
  // cryptographically validated official engine is actually loaded.
  process.env.HUAMEI_GRAPHRAG_ENABLED = "false";
  process.env.HUAMEI_GRAPHRAG_URL = graphUrl;
  let expectedVersion = String(process.env.HUAMEI_GRAPHRAG_INDEX_VERSION || "").trim();
  if (!graphExternallyManaged) {
    expectedVersion = graphLocalAdmission.expectedVersion;
    process.env.HUAMEI_GRAPHRAG_ENGINE = "official";
    process.env.HUAMEI_GRAPHRAG_INDEX_ROOT = graphIndexRoot;
    process.env.HUAMEI_GRAPHRAG_OFFICIAL_PROJECT_ROOT = graphOfficialProjectRoot;
    process.env.HUAMEI_GRAPHRAG_INDEX_VERSION = expectedVersion;
    const workers = String(Math.max(1, Number(process.env.HUAMEI_GRAPHRAG_WORKERS || 4)));
    runProcess(graphPython, [
      "-m", "uvicorn", "app.main:app",
      "--app-dir", join(root, "graphrag-service"),
      "--host", graphHost,
      "--port", String(graphPort),
      "--workers", workers,
      "--loop", "asyncio",
      "--no-access-log"
    ], "GraphRAG检索服务");
  }
  await waitForGraph(expectedVersion);
  process.env.HUAMEI_GRAPHRAG_ENABLED = "true";
  console.log(`GraphRAG正式检索服务已就绪：${graphUrl}`);
} else {
  process.env.HUAMEI_GRAPHRAG_ENABLED = "false";
  const reason = graphExplicitlyDisabled
    ? "GRAPHRAG_EXPLICITLY_DISABLED"
    : (!existsSync(graphPython) ? "GRAPHRAG_LOCAL_RUNTIME_MISSING" : graphLocalAdmission.code);
  console.log(`GraphRAG正式检索服务未启用（${reason}）；售前智能体将使用已审核本地检索降级链路。`);
}
if (!externallyManaged) runNode("server/acquisition-service-server.mjs");
await waitForService();
console.log(`网页网关将通过独立服务调用售前智能体：${serviceUrl}`);
runNode("server.mjs");

// Keep the supervisor alive so terminal/session teardown cannot orphan or
// immediately reclaim the two child processes. Shutdown is handled above.
process.exitCode = await supervisorDone;
