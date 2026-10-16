#!/usr/bin/env node
// 把 huamei-merge 隔离实例的数据库重置为「刚迁移完的干净状态」：
//   DROP + CREATE huamei_team_dev_merge → 角色/ACL 引导（超级用户）→ 18 个迁移（migrator）→ 再次引导归一 ACL。
// 为什么需要它：postgres 套件共用同一个库且不清场，
//   tests/postgres-field-encryption-integration.mjs 会留下 v2 字段信封密文，
//   tests/postgres-field-envelope-v2-migration-integration.mjs 的 dry-run 会扫描全库并因此失败。
//   因此每次跑 test:postgres-all / test:postgres:ci 之前都应先重置。
// 安全约束：只认 huamei-merge-postgres-1 容器里的 huamei_team_dev_merge；必须显式 --confirm。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(dirname(here));
const container = "huamei-merge-postgres-1";
const expectedDatabase = "huamei_team_dev_merge";

if (!process.argv.includes("--confirm")) {
  console.log(JSON.stringify({
    status:"dry_run",
    container,
    database:expectedDatabase,
    warning:"会删除该库全部数据（仅限隔离开发实例）；确认后加 --confirm",
    steps:["DROP/CREATE database", "provision roles+ACL", "run 18 migrations", "provision roles+ACL again"]
  }, null, 2));
  process.exit(0);
}

const envPath = join(here, ".env.merge");
if (!existsSync(envPath)) throw new Error("缺少 deploy/local/.env.merge；先执行 node deploy/local/init-merge-env.mjs");
const fileEnv = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
  if (match) fileEnv[match[1]] = match[2];
}
const database = String(fileEnv.HUAMEI_POSTGRES_DB || expectedDatabase).trim();
if (database !== expectedDatabase) {
  throw new Error(`拒绝重置：目标库为 ${database}，本脚本只操作 ${expectedDatabase}`);
}
const running = spawnSync("docker", ["ps", "--filter", `name=^${container}$`, "--format", "{{.Names}}"], { encoding:"utf8" });
if (running.status !== 0 || !running.stdout.includes(container)) {
  throw new Error(`拒绝重置：未找到运行中的容器 ${container}（先 docker compose --env-file deploy/local/.env.merge -f deploy/local/compose.merge.yml up -d）`);
}

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd:repositoryRoot, env, encoding:"utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`命令失败：${command} ${args.join(" ")}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
};
const psql = (sql) => run("docker", ["exec", container, "psql", "-q", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql]);

psql(`DROP DATABASE IF EXISTS ${expectedDatabase} WITH (FORCE)`);
psql(`CREATE DATABASE ${expectedDatabase} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);

const nodeEnv = { ...process.env, ...fileEnv };
run(process.execPath, ["scripts/provision-postgres-runtime-role.mjs"],
  { ...nodeEnv, HUAMEI_DATABASE_URL:fileEnv.HUAMEI_BOOTSTRAP_DATABASE_URL });
const migrationOutput = run(process.execPath, ["scripts/run-migrations.mjs"],
  { ...nodeEnv, HUAMEI_DATABASE_URL:fileEnv.HUAMEI_MIGRATION_DATABASE_URL });
run(process.execPath, ["scripts/provision-postgres-runtime-role.mjs"],
  { ...nodeEnv, HUAMEI_DATABASE_URL:fileEnv.HUAMEI_BOOTSTRAP_DATABASE_URL });

const summary = (() => {
  try { return JSON.parse(migrationOutput.slice(migrationOutput.indexOf("{"))); } catch { return null; }
})();
console.log(JSON.stringify({
  status:"ok",
  container,
  database,
  migrations:{ applied:summary?.applied?.length ?? null, skipped:summary?.skipped?.length ?? null, total:summary?.total ?? null },
  next:"先跑 npm run test:postgres-all（用 --env-file），或把 deploy/local/.env 载入环境后跑 test:postgres:ci"
}, null, 2));
