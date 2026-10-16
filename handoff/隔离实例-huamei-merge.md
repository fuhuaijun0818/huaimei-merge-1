# huamei-merge 隔离实例（PostgreSQL + Redis）2026-10-16

给融合/验收阶段用的本机隔离依赖。与 A（`huamei-a-dev` 55434/56380）、B（`huamei-b-dev` 55432/6379）、
C（`huamei-c-dev` 55433/56379）以及 `huamei-local-infrastructure` 并列：项目名、端口、卷、网络互不影响。
三条开发线的容器与数据未被改动。

## 1. 实例概况

| 项目 | 值 |
|---|---|
| Compose 项目名 | `huamei-merge`（`deploy/local/compose.merge.yml`） |
| 容器 | `huamei-merge-postgres-1` @127.0.0.1:55435、`huamei-merge-redis-1` @127.0.0.1:56381 |
| 卷 / 网络 | `huamei-merge_huamei_postgres_data`、`huamei-merge_huamei_redis_data` / `huamei-merge_backend` |
| 数据库 | `huamei_team_dev_merge`（18 个迁移全部应用） |
| 角色 | `huamei_owner`（NOLOGIN BYPASSRLS，对象属主）、`huamei_migrator`（LOGIN，`SET ROLE owner` 迁移）、`huamei_runtime`（LOGIN，最小权限） |
| 凭据文件 | `deploy/local/.env.merge`（compose + 引导）、`deploy/local/.env`（应用/套件，`--env-file` 读取） |

**库名为何不叫 `huamei-merge`**：`devkit/seed-postgres.mjs` 与 `docs/onboarding/02_环境与外部服务配置.md`
要求开发库名以 `huamei_team_dev` 开头（多岗位 12 账号 seed 的前置条件），因此库名取
`huamei_team_dev_merge`；用户可见的实例名仍为 `huamei-merge`。若确认不需要 postgres seed，可改名，
但会同时失去该 seed 路径。

两个凭据文件都被 `.gitignore`（`.env` / `.env.*`）忽略，**禁止提交、禁止外发**。口令只在本机文件里，
生成脚本只打印变量名与长度。

## 2. 常用命令

```powershell
# 生成/补全本机凭据（已存在 .env.merge 时复用口令；--force 会轮换口令，必须同时重建数据卷）
node deploy/local/init-merge-env.mjs

# 起停
docker compose --env-file deploy/local/.env.merge -f deploy/local/compose.merge.yml up -d
docker compose --env-file deploy/local/.env.merge -f deploy/local/compose.merge.yml down

# 重置为「刚迁移完的干净状态」：DROP/CREATE 库 → 角色与 ACL 引导 → 18 迁移 → 再归一 ACL
node deploy/local/reset-merge-db.mjs            # 只打印将执行的动作
node deploy/local/reset-merge-db.mjs --confirm  # 真正执行（仅限 huamei-merge-postgres-1 的 huamei_team_dev_merge）

# 套件（脚手架已在 deploy/local/.env 内配好连接）
npm run test:postgres-all                 # 14 组，走 --env-file=deploy/local/.env；需先重置
node --env-file=deploy/local/.env tests/redis-live-integration.mjs   # 真实 Redis 连通/限流/幂等
```

角色与迁移的实际落库方式沿用仓库既有脚本，没有手写 SQL：
`scripts/provision-postgres-runtime-role.mjs`（超级用户连接建角色并归一 ACL）、
`scripts/run-migrations.mjs`（migrator 连接 + `SET ROLE huamei_owner`，带 checksum 记账）。

## 3. 本次实测证据（2026-10-16，真实应用均在本机执行）

| 检查 | 命令 | 结果 |
|---|---|---|
| 容器健康 | `docker compose ... ps` | postgres、redis 均 `Up (healthy)` |
| 角色模型 | `psql` 查 `pg_roles` | `huamei_owner` NOLOGIN+BYPASSRLS、`huamei_migrator`/`huamei_runtime` LOGIN、三者均非 SUPERUSER |
| 迁移 | `scripts/run-migrations.mjs` | `applied 18 / skipped 0 / total 18` |
| RLS | 查 `pg_class` | 32 张表 `relrowsecurity AND relforcerowsecurity`；业务表属主统一为 `huamei_owner` |
| Redis | `redis-cli ping`（容器内） | `PONG` |
| PostgreSQL 套件 | `npm run test:postgres-all` | **14/14 通过**，重置后连续两次一致（迁移、字段信封 AAD v1→v2、RLS、知识三审、会话一致性、LangGraph turn 协议、Outbox、域集成、留资核号、联系方式保险库、个人信息权利、隐私 HTTP、隐私 attestation、字段加密） |
| Redis 套件 | `tests/redis-live-integration.mjs` | 通过（连通性、多客户端原子限流与幂等 claim） |

未运行（下一步）：`npm run team:seed:postgres` 的 12 个岗位账号、`postgres-*` 多角色 HTTP 验收、
浏览器 E01–E11 联合旅程。本节不声称这些已通过。

## 4. 已知限制（本机实测发现，非本次搭建引入）

1. **套件之间不清场，残留会污染后续全库扫描。** `tests/postgres-five-role-publication-integration.mjs`
   结束时留下 `conversation_sessions.state = {}`（明文），而
   `tests/postgres-field-envelope-v2-migration-integration.mjs` 的 dry-run 会扫描整表并要求每行都是信封，
   于是报 `FIELD_ENVELOPE_PLAINTEXT_OR_UNKNOWN` 而失败；反之，跑过
   `postgres-field-encryption-integration` 后再跑该 dry-run 会报 `FIELD_DECRYPTION_FAILED`。
   实测：干净库上单独跑两者分别通过（信封套件 ✓、publication ✓），先跑 publication 再跑信封套件即失败。
   → 处理方式：每次整批运行前用 `reset-merge-db.mjs --confirm` 重置；或每个套件用独立临时库。
2. **`npm run test:postgres:ci` 的固定顺序在单库上自相冲突**：链里 publication（第 2 个）先于
   envelope-v2 dry-run（第 4 个），同一库内必然踩到第 1 条的残留。本次用
   `test:postgres-all` + 重置作为可重复路径，`test:postgres:ci` 记为 blocked，需按
   `.github/workflows/production-verification.yml` 的思路给每个套件独立临时库后才能宣称通过。
3. **`npm run test:postgres-isolated` 不能指向本实例**：`scripts/run-isolated-postgres-integration.mjs`
   要求引导库为超级用户且 `huamei_owner/huamei_migrator/huamei_runtime` 尚不存在（它自己建临时角色）。
   本实例按仓库文档已完成角色引导，因此该 runner 会主动拒绝。需要它时另起一个空 PostgreSQL 实例。
4. **本地基线配置不配字段加密 keyring。** 首次搭建时我在 `deploy/local/.env` 里设了
   `HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON`，会话状态/消息即以 v2 信封落库，
   `tests/postgres-session-consistency.mjs` 这类直接读原始列的断言随即失败（读到 `_encrypted` 信封）。
   现按 `deploy/local/env.example` 只保留 contact-vault keyring；该变量在 `.env` 中作为注释保留说明。

## 5. 待负责人决策

- 新增文件 `deploy/local/compose.merge.yml`、`deploy/local/init-merge-env.mjs`、
  `deploy/local/reset-merge-db.mjs` 目前未提交（`deploy/` 属共享路径）。是否随下一次交付提交并写入
  Section 4 的两条套件隔离问题（建议交回 A/B/C 各 owner 或按 `devkit`/`tests/onboarding` 排期）。
- 是否在本实例上继续做 12 账号 seed 与多角色 HTTP 验收（第 3 节"未运行"部分）。
