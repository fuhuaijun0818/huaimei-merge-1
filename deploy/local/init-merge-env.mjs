#!/usr/bin/env node
// 为 huamei-merge 隔离开发实例生成两脚本机凭据文件：
//   deploy/local/.env.merge  —— compose 与角色/迁移引导用（Docker 变量 + huamei_owner/migrator/runtime）
//   deploy/local/.env        —— 应用与 npm/postgres 套件用（--env-file=deploy/local/.env）
// 两个文件都被 .gitignore 的 `.env.*` / `.env` 规则忽略，禁止提交或复制到其他机器。
// 已存在 .env.merge 时默认复用其口令，只补齐缺失项，避免与已初始化的容器错位；--force 才重新生成。
// 注意：数据库口令只在容器首次初始化时写入数据卷，--force 轮换口令后必须同时删除 huamei-merge 的数据卷重建实例。
// 只打印变量名与长度，口令本身不落终端、不进日志。
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mergeEnvPath = join(here, ".env.merge");
const appEnvPath = join(here, ".env");
const force = process.argv.includes("--force");

const database = "huamei_team_dev_merge";
const host = "127.0.0.1";
const postgresPort = "55435";
const redisPort = "56381";

const randomSecret = () => randomBytes(36).toString("base64url");
const randomKey = () => randomBytes(32).toString("base64");
const keyring = (keyId) => JSON.stringify({ active_key_id:keyId, keys:{ [keyId]:randomKey() } });

const readEnvFile = (path) => {
  if (!existsSync(path)) return new Map();
  const entries = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match) entries.set(match[1], match[2]);
  }
  return entries;
};

const prior = force ? new Map() : readEnvFile(mergeEnvPath);
const value = (name, create) => {
  const existing = String(prior.get(name) || "").trim();
  return existing || create();
};

const postgresPassword = value("HUAMEI_POSTGRES_PASSWORD", randomSecret);
const redisPassword = value("HUAMEI_REDIS_PASSWORD", randomSecret);
const migrationPassword = value("HUAMEI_POSTGRES_MIGRATION_PASSWORD", randomSecret);
const runtimePassword = value("HUAMEI_POSTGRES_APP_PASSWORD", randomSecret);

const url = (user, password, port, suffix = "") =>
  `postgresql://${user}:${password}@${host}:${port}/${database}${suffix}`;
const bootstrapUrl = url("postgres", postgresPassword, postgresPort);
const migrationUrl = url("huamei_migrator", migrationPassword, postgresPort);
const runtimeUrl = url("huamei_runtime", runtimePassword, postgresPort);
const redisUrl = `redis://:${redisPassword}@${host}:${redisPort}/0`;

const mergeEnv = [
  "# huamei-merge 隔离开发实例（Postgres 55435 / Redis 56381）。本机开发凭据，勿提交、勿复用。",
  `# 生成器：node deploy/local/init-merge-env.mjs（--force 重新生成口令）`,
  "",
  "# docker compose 变量（compose.merge.yml）",
  `HUAMEI_POSTGRES_DB=${database}`,
  "HUAMEI_POSTGRES_USER=postgres",
  `HUAMEI_POSTGRES_PASSWORD=${postgresPassword}`,
  `HUAMEI_POSTGRES_PORT=${postgresPort}`,
  `HUAMEI_REDIS_PASSWORD=${redisPassword}`,
  `HUAMEI_REDIS_PORT=${redisPort}`,
  "",
  "# 角色引导（scripts/provision-postgres-runtime-role.mjs）",
  "HUAMEI_POSTGRES_MIGRATION_USER=huamei_migrator",
  `HUAMEI_POSTGRES_MIGRATION_PASSWORD=${migrationPassword}`,
  "HUAMEI_POSTGRES_APP_USER=huamei_runtime",
  `HUAMEI_POSTGRES_APP_PASSWORD=${runtimePassword}`,
  "",
  "# 连接串：bootstrap 用超级用户建角色，迁移用 migrator（SET ROLE huamei_owner），应用用 runtime",
  `HUAMEI_BOOTSTRAP_DATABASE_URL=${bootstrapUrl}`,
  `HUAMEI_MIGRATION_DATABASE_URL=${migrationUrl}`,
  `HUAMEI_DATABASE_URL=${runtimeUrl}`,
  `HUAMEI_REDIS_URL=${redisUrl}`,
  ""
].join("\n");

const appEnv = [
  "# 应用侧配置：指向本仓库的 huamei-merge 隔离实例。本机开发凭据，勿提交。",
  "# npm 的 postgres 套件以 --env-file=deploy/local/.env 读取本文件。",
  "",
  "HUAMEI_PERSISTENCE_BACKEND=postgres",
  "HUAMEI_CACHE_BACKEND=redis",
  `HUAMEI_DATABASE_URL=${runtimeUrl}`,
  `HUAMEI_MIGRATION_DATABASE_URL=${migrationUrl}`,
  `HUAMEI_REDIS_URL=${redisUrl}`,
  "",
  "# 与部署用 keyring 完全分开：本地隔离实例专用，禁止复用生产密钥。",
  `HUAMEI_CONTACT_VAULT_KEYRING_JSON=${keyring("local-contact-merge")}`,
  "# HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON 默认不设置：deploy/local/env.example 只要求 contact-vault keyring。",
  "# 本模块只要配了 keyring 就会把会话状态/消息等 JSONB 以 v2 信封加密落库，于是像",
  "# tests/postgres-session-consistency.mjs 这类直接读原始列的断言会失败（读到的是密文信封而不是 state.counters）。",
  "# 需要验证字段加密链路的套件请单独用 keyring 启动，不要改变本文件的基线配置。",
  `# HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON=${keyring("local-field-merge")}`,
  "",
  "# 便于在同一目录直接 docker compose -f deploy/local/compose.merge.yml 起容器",
  `HUAMEI_POSTGRES_DB=${database}`,
  "HUAMEI_POSTGRES_USER=postgres",
  `HUAMEI_POSTGRES_PASSWORD=${postgresPassword}`,
  `HUAMEI_POSTGRES_PORT=${postgresPort}`,
  `HUAMEI_REDIS_PASSWORD=${redisPassword}`,
  `HUAMEI_REDIS_PORT=${redisPort}`,
  ""
].join("\n");

writeFileSync(mergeEnvPath, mergeEnv, { encoding:"utf8", mode:0o600 });
writeFileSync(appEnvPath, appEnv, { encoding:"utf8", mode:0o600 });

console.log(JSON.stringify({
  status:"ok",
  files:[mergeEnvPath, appEnvPath],
  database,
  endpoints:{ postgres:`${host}:${postgresPort}`, redis:`${host}:${redisPort}` },
  variables:["HUAMEI_POSTGRES_PASSWORD", "HUAMEI_REDIS_PASSWORD", "HUAMEI_POSTGRES_MIGRATION_PASSWORD",
    "HUAMEI_POSTGRES_APP_PASSWORD", "HUAMEI_CONTACT_VAULT_KEYRING_JSON", "HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON"]
    .map((name) => ({ name, reused:prior.has(name) })),
  note:"口令只写入上述文件；请勿提交、勿外发。"
}, null, 2));
