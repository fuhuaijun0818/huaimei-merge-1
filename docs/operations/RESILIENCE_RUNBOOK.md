# 华美一期故障注入与恢复演练手册

## 目标与不可变安全线

本手册验证“依赖故障可见、对客结果安全、业务状态不重复”。任何演练都不得：

- 使用真实客户姓名、手机号、照片或对话原文；
- 将未审核索引、错租户证据或模型错误原文交付客户；
- 将 `/healthz` 当作可接流量信号，流量门禁只读受保护的 `/readyz`；
- 在没有备份和回退负责人的情况下执行真实主备切换。

机器可读场景清单位于 `docs/operations/resilience-fault-matrix.json`。

## 本地自动化门禁

执行：

```bash
npm run test:resilience
```

测试最后输出 `huamei.resilience-test-summary.v1` JSON。通过标准如下：

1. LLM 超时、429、无效 JSON 和断网全部返回本地确定性安全答案；
2. GraphRAG 超时、5xx、租户或索引绑定不一致时，远程 `evidence` 必须为空；
3. PostgreSQL 或 Redis 不可用时 `/readyz` 返回 503，`/healthz` 仅表示进程存活；
4. 渠道收件登记后中断，相同 `message_id` 可恢复且只提交一轮；
5. 人工已接管时，AI 输出为空、不调用模型、重放不重复记录入站事件。

Outbox 和 PostgreSQL 会话终结是真实数据库门禁，需在新建的 PostgreSQL 16
库中使用独立 `huamei_migrator` 与 `huamei_runtime` 账号执行：

```bash
HUAMEI_DATABASE_URL='<runtime-role-url>' \
HUAMEI_MIGRATION_DATABASE_URL='<migrator-role-url>' \
node tests/postgres-outbox-integration.mjs

HUAMEI_PERSISTENCE_BACKEND=postgres \
HUAMEI_DATABASE_URL='<runtime-role-url>' \
node tests/postgres-session-consistency.mjs
```

Outbox 门禁必须同时证明多 worker 互斥领取、指数退避、尝试耗尽进死信、
租约过期恢复和 `event_id` 幂等。会话门禁必须证明失败收件只终结一次，
相同 `message_id` 重放后恢复，且不多写消息、审计或 Outbox 事件。

## 预生产真实故障演练

以下三项无法由本地 mock 证明，上线前必须在与生产同规格的预生产环境完成。

### PostgreSQL 主备切换

前置：当日备份可恢复、主备延迟已记录、数据库和应用负责人在场。

1. 在低流量时段持续发送只含虚拟数据的会话和 Outbox 事件；
2. 终止主库网络或进程，观察 `/readyz` 在探测窗口内变为 503，网关停止引流；
3. 按平台标准流程提升备库，不在应用中手工改写状态；
4. 验证会话 `message_id`、Outbox `event_id`、租户 RLS 和审计计数无重复、无丢失；
5. 记录故障检出时间、切换时间、恢复时间及 RPO/RTO。

验收：恢复时间不超过上线 SLO，RPO 符合数据分级要求，不存在跨租户读写或重复提交。

### Redis 故障切换

1. 用多副本并发请求建立限流和幂等基线；
2. 终止 Redis 主节点或隔离网络，确认 `/readyz` 返回 503，不回退进程内存储；
3. 完成 Sentinel/托管平台切换后，验证各副本共享同一限流窗口和幂等结果；
4. 确认无限流穿透、无同一请求双执行、无凭据进入日志。

### 真实模型限额

1. 使用专用预生产账号和可回滚的低限额，不消耗生产配额；
2. 产生真实 429/配额耗尽，验证回答转本地确定性路径且不暴露供应商错误；
3. 确认模型失败率、限额告警和值班通知在约定时间内触发；
4. 提升配额或切换备用策略后确认自动恢复，不需要重启服务。

## 证据留存和终止条件

每次演练留存：时间线、参与人、变更单、受影响指标截图、脱敏日志、验证 SQL 计数、
Alertmanager 通知回执、RPO/RTO 和复盘项。出现跨租户数据、不可逆写入、备份不可用、
告警未到达或对客使用脏证据时立即终止演练，不得继续放量。

## 上线结论边界

本地自动化通过只证明应用的故障分支和幂等约束。真实 PostgreSQL 主备切换、
Redis 故障切换以及模型供应商限额必须完成上述预生产演练后，才能签署上线结论。
