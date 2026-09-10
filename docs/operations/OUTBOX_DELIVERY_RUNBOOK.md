# PostgreSQL Outbox 投递运维手册

## 语义和安全边界

Outbox worker 提供至少一次（at-least-once）投递。数据库状态与外部系统无法使用同一个事务，
因此 worker 在外部系统已接收、但尚未标记数据库为 `published` 时异常退出，事件会重投。

每次 HTTP 投递都会将不可变 `event_id` 同时放入：

- `Idempotency-Key`；
- `X-Huamei-Event-Id`；
- JSON 消息体的 `event_id`。

下游必须按 `(tenant_id, event_id)` 去重，重放时返回成功 2xx，不得重复创建业务对象。

worker 按显式租户清单运行，通过现有 PostgreSQL RLS 事务设置租户上下文，
不需要 `BYPASSRLS` 或超级用户账号。

## 部署前置

1. 使用 migration 账号执行 `004_outbox_delivery.sql`。
2. 为 worker 提供非 owner、非 superuser、非 BYPASSRLS 的数据库连接。
3. 部署一个支持 `event_id` 幂等的 HTTPS 事件接收端。
4. 至少运行两个 worker 副本；多副本通过 `FOR UPDATE SKIP LOCKED` 互斥领取。

## 必要环境变量

```dotenv
HUAMEI_OUTBOX_DATABASE_URL=postgresql://<runtime-user>:<secret>@<postgres>/huamei
HUAMEI_OUTBOX_TENANTS=huamei-shanghai
HUAMEI_OUTBOX_TARGET_URL=https://<internal-event-router>/v1/events
HUAMEI_OUTBOX_TARGET_SERVICE_KEY=<independent-secret>
```

运行：

```bash
npm run start:outbox
```

可调参数：

- `HUAMEI_OUTBOX_BATCH_SIZE`，默认 25；
- `HUAMEI_OUTBOX_MAX_IN_FLIGHT`，默认 50；
- `HUAMEI_OUTBOX_LEASE_MS`，默认 30000；
- `HUAMEI_OUTBOX_POLL_INTERVAL_MS`，默认 500；
- `HUAMEI_OUTBOX_BASE_RETRY_MS`，默认 1000；
- `HUAMEI_OUTBOX_MAX_RETRY_MS`，默认 300000；
- `HUAMEI_OUTBOX_DRAIN_TIMEOUT_MS`，默认 30000；
- `HUAMEI_OUTBOX_TARGET_TIMEOUT_MS`，默认 10000。

## 失败与恢复

- 每次领取都增加 `attempts`，失败后按 `base * 2^(attempt-1)` 退避，并受最大退避限制。
- 默认最多 8 次；到达 `max_attempts` 后进入 `dead_letter`。
- 每个租约有唯一 `lease_token`。旧 worker 不能确认已被新 worker 重新领取的事件。
- 投递期间会自动续租。进程崩溃后，新 worker 在租约到期后恢复该事件。
- SIGTERM/SIGINT 会先停止领取并 drain 在途投递。drain 超时时停止续租，由其他副本在租约到期后恢复。
- 领取循环发生终止性数据库/程序错误时，worker会先停止领取、清理监控端口和数据库连接，再以非零状态退出；容器`restart`策略必须拉起新实例。禁止把终止错误仅记录日志后让空进程继续存活。

## 监控和告警

worker 定期输出 `outbox.metrics` JSON，包含各租户及汇总：

- pending / retry / processing / published / dead-letter 数量；
- ready 数量；
- expired lease 数量；
- backlog 数量；
- oldest backlog seconds；
- worker 领取、成功、失败、重试、死信、租约丢失计数。

生产编排还会在内部`9190/readyz`执行带独立metrics token的healthcheck。循环已退出、正在停止、PostgreSQL不可用或token错误都返回非就绪；同时必须保留`restart: unless-stopped`，以便终止性错误触发自动恢复。Prometheus报警不能替代进程退出/容器重启机制。

建议上线初始告警：

- `dead_letter > 0`：严重；
- `expired_leases > 0` 持续 2 个周期：警告；
- `oldest_backlog_seconds > 120`：严重；
- backlog 连续 5 分钟增长：警告；
- `pollErrors` 或 `leaseLost` 持续增长：警告。

死信重放必须在查明下游故障、确认幂等约束和保留原 `event_id` 后由受审计的运维流程执行，
不允许直接修改 payload 后重用原 event_id。
