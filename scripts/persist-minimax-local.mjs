import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = join(root, ".env.local");
const temporaryPath = join(dirname(envPath), `.env.local.${process.pid}.tmp`);
const apiKey = String(process.env.MINIMAX_API_KEY || "").trim();

if (!apiKey || /replace_with/i.test(apiKey)) {
  console.error("未检测到有效的 MINIMAX_API_KEY；本地配置未修改。");
  process.exit(1);
}

function safeEnvValue(value) {
  const normalized = String(value ?? "").trim();
  if (/\r|\n|\0/.test(normalized)) throw new Error("环境变量不能包含换行或空字节");
  if (/^[A-Za-z0-9._:/,+-]*$/.test(normalized)) return normalized;
  return `"${normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

const settings = new Map([
  ["MINIMAX_API_KEY", apiKey],
  ["MINIMAX_BASE_URL", process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com"],
  ["MINIMAX_VIDEO_MODEL", process.env.MINIMAX_VIDEO_MODEL || "MiniMax-H3"],
  ["MINIMAX_SPEECH_MODEL", process.env.MINIMAX_SPEECH_MODEL || "speech-2.8-hd"],
  ["MINIMAX_REAL_CALL_ENABLED", "true"],
  ["MINIMAX_REAL_USER_IDS", process.env.MINIMAX_REAL_USER_IDS || "admin-xuning"],
  ["MINIMAX_DAILY_REAL_JOB_LIMIT", process.env.MINIMAX_DAILY_REAL_JOB_LIMIT || "5"],
  ["MINIMAX_POLL_INTERVAL_MS", process.env.MINIMAX_POLL_INTERVAL_MS || "10000"],
  ["MINIMAX_MAX_POLL_ERRORS", process.env.MINIMAX_MAX_POLL_ERRORS || "8"]
]);

let existing = "";
try {
  existing = await readFile(envPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const seen = new Set();
const lines = existing.replace(/\s+$/, "").split(/\r?\n/).filter((line, index, items) => line || index < items.length - 1);
const updated = lines.map((line) => {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!match || !settings.has(match[1])) return line;
  seen.add(match[1]);
  return `${match[1]}=${safeEnvValue(settings.get(match[1]))}`;
});

const missing = [...settings].filter(([key]) => !seen.has(key));
if (missing.length) {
  if (updated.length && updated.at(-1) !== "") updated.push("");
  updated.push("# MiniMax H3 V2（仅服务端读取；禁止提交到版本库）");
  for (const [key, value] of missing) updated.push(`${key}=${safeEnvValue(value)}`);
}

await writeFile(temporaryPath, `${updated.join("\n")}\n`, { mode:0o600, flag:"wx" });
await chmod(temporaryPath, 0o600);
await rename(temporaryPath, envPath);
await chmod(envPath, 0o600);
console.log("MiniMax 本地配置已安全保存；密钥值未输出。");
