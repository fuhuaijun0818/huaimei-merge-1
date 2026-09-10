# 华美一期可观测性运维手册

## 目标与边界

可观测性底座统一提供三类信号：

1. JSON 结构化日志，自动携带 `request_id`、`trace_id` 和 `span_id`；
2. Prometheus 兼容指标，覆盖 HTTP、模型、GraphRAG、转人工和 Outbox；
3. 分离的存活检查与就绪检查，避免“进程还活着”被误判为“可以接流量”。

任何日志、指标标签和探针响应都不得写入客户姓名、手机号、证件号、邮箱、地址、
对话原文、模型 prompt、知识检索 query、Authorization、Cookie、API Key 或数据库连接串。
业务明细仍进入受权限和留存策略约束的业务存储，不进入运维信号。

## 组件

- `server/observability/redaction.mjs`：递归脱敏、循环对象和错误对象安全序列化；
- `server/observability/context.mjs`：W3C `traceparent` 与 `X-Request-Id` 上下文；
- `server/observability/logger.mjs`：单行 JSON 日志；
- `server/observability/metrics.mjs`：无外部依赖的 Prometheus Counter、Gauge、Histogram；
- `server/observability/http.mjs`：请求观测 wrapper、受保护的 `/metrics` 和 `/readyz`；
- `server/observability-server.mjs`：内部端口参考实现；
- `deploy/observability/`：Prometheus 采集、告警和 Grafana 仪表盘模板。

指标必须在被观测服务的进程内记录。独立启动 `observability-server.mjs` 只适合验证采集链路，
不能替代业务进程内的模型、GraphRAG、转人工和 Outbox 埋点。

## 服务接入

核心链路已在代码中完成接入：获客 HTTP 入口/出口、模型调用、GraphRAG 查询、
转人工状态以及 Outbox 发送 worker 都使用同一个进程级 SDK。获客服务的
`/healthz`、`/readyz`和 `/metrics` 与业务 API 共用 `4180` 端口；Outbox worker
在独立的内网运维端口（默认 `9190`）提供这三个端点。

每个 Node.js 服务创建一个进程级实例，并用统一 wrapper 包装 HTTP handler：

```js
import { createServer } from "node:http";
import {
  createObservability,
  createObservedHttpHandler,
  outboundTraceHeaders
} from "./server/observability/index.mjs";

const observability = createObservability({
  service:"huamei-acquisition",
  version:"2.1.0",
  environment:process.env.HUAMEI_RUNTIME_ENV
});

const server = createServer(createObservedHttpHandler(applicationHandler, {
  observability,
  service:"huamei-acquisition",
  routeResolver:(request) => routeTemplateFor(request)
}));

await fetch(downstreamUrl, {
  headers:outboundTraceHeaders({ "Content-Type":"application/json" })
});
```

`routeResolver` 必须返回路由模板，例如 `/v1/runs/:id`，不能返回查询参数或客户输入。
默认 resolver 会将长标识、纯数字段和疑似手机号替换为 `:id`。

关键业务埋点：

```js
observability.observeModel({
  provider, model, outcome, durationMs, promptTokens, completionTokens
});
observability.observeGraphRag({ mode, outcome, durationMs, cacheHit });
observability.recordHandover({ event:"requested", reason:"medical_safety" });
observability.recordOutboxDelivery({ outcome:"published" });
observability.setOutboxSnapshot(workerMetrics.total);
```

转人工原因会被归并到固定分类；不得把人工备注或客户原话作为指标标签。
Outbox 可使用 `registerOutboxWorkerCollector(observability, worker)` 将 worker 累计计数和积压快照接入，
该 collector 使用增量计算，不会因 Prometheus 重复采集而重复累计。

## 日志规范

推荐事件名使用稳定的点分命名，如：

- `http.request.completed`；
- `model.call.completed`；
- `graphrag.query.failed`；
- `handover.requested`；
- `outbox.delivery.failed`。

日志只记录分类、计数、耗时、状态码、稳定业务对象 ID 的不可逆内部标识。
禁止 `console.log(request.body)`、`console.error(error.stack)` 和记录完整下游响应。
生产 logger 默认不输出堆栈；手机号、邮箱、证件号、凭据和敏感字段会被二次脱敏。

## Trace 与请求标识

- 接受合法的 W3C `traceparent` 并保留 `trace_id`，每一跳创建新 `span_id`；
- 接受格式安全的 `X-Request-Id`，疑似手机号、证件号、token 或非法字符会被替换；
- 出站 HTTP 使用 `outboundTraceHeaders()` 同时传递 `traceparent` 和 `X-Request-Id`；
- 不得使用手机号、客户 ID、会话原文或 OpenID 充当 request ID；
- Prometheus label 不包含 `request_id` 或 `trace_id`，避免高基数。

当前实现提供上下文贯通和关联日志，不宣称完整分布式 tracing。若需要调用链瀑布图，
后续接入 OpenTelemetry Collector 时复用相同 W3C 上下文。

## 存活、就绪与指标端点

| 端点 | 鉴权 | 语义 |
| --- | --- | --- |
| `GET /healthz` | 无 | 只证明进程和 HTTP 事件循环存活；响应保持最小化 |
| `GET /readyz` | Bearer 或 `X-Metrics-Token` | 检查依赖是否可用；未就绪返回 503 |
| `GET /metrics` | Bearer 或 `X-Metrics-Token` | Prometheus 0.0.4 文本格式 |

生产 acquisition、canary acquisition 和 Outbox 分别使用
`HUAMEI_ACQUISITION_METRICS_TOKEN`、`HUAMEI_CANARY_ACQUISITION_METRICS_TOKEN`、
`HUAMEI_OUTBOX_METRICS_TOKEN`，每个不少于32个随机字符且彼此不复用；容器内均映射为
`HUAMEI_METRICS_TOKEN`。开发环境也不得少于24个字符。使用Vault、云密钥管理或
Docker/Kubernetes secret注入，不写入仓库和镜像。Prometheus模板拆成两个job，分别从
`huamei_acquisition_metrics_token`和`huamei_outbox_metrics_token`只读secret文件读取；
Outbox job只在启用`external-events` profile时启用。

`/readyz` 只返回依赖名称、布尔状态、枚举状态和延迟，异常消息、URL、路径和连接串会被丢弃。
Prometheus端点应只监听loopback或内部运维网络。生产Compose中的Outbox显式绑定
`0.0.0.0:9190`，但只`expose`到内部`backend`网络，不映射宿主端口；任何扩大网络范围都
需要单独准入和ACL。

## 核心指标

- `huamei_http_requests_total`、`huamei_http_request_duration_seconds`；
- `huamei_model_requests_total`、`huamei_model_request_duration_seconds`、`huamei_model_tokens_total`；
- `huamei_graphrag_queries_total`、`huamei_graphrag_query_duration_seconds`、`huamei_graphrag_cache_total`；
- `huamei_handovers_total`；
- `huamei_outbox_deliveries_total`、`huamei_outbox_events`、`huamei_outbox_oldest_backlog_seconds`；
- `huamei_dependency_ready`、`huamei_process_uptime_seconds`。

标签均为固定枚举或受限标识。禁止添加 tenant、customer、conversation、request、prompt、query 等高基数或敏感标签。

## 告警和仪表盘

`deploy/observability/huamei-alerts.yml` 提供初始告警：

- 服务连续 2 分钟无法采集；
- 依赖连续 2 分钟未就绪；
- HTTP 5 分钟错误率超过 5%；
- HTTP P95 连续 10 分钟超过 2 秒；
- 模型或 GraphRAG 失败率超过 10%；
- 人工接管 SLA 超时；
- Outbox 出现死信、最老积压超过 120 秒或持续存在过期租约。

`deploy/observability/grafana-dashboard.json` 包含请求量/错误、P95 延迟、模型和 GraphRAG、
转人工、Outbox、依赖状态六组面板。阈值应在压测和两周真实基线后按业务时段调整，
不得为了减少告警直接关闭死信或 SLA 告警。

## 基础设施依赖

上线前需要准备：

1. Prometheus 或兼容托管时序库，建议生产保存 30 天、长期聚合保存 180 天；
2. Grafana 和 Alertmanager，接入至少两个值班通知渠道；
3. 支持 JSON 的日志平台，设置访问控制、7 至 30 天留存和敏感日志巡检；
4. Secret Manager 或只读 secret 挂载，用于 metrics token；
5. 内部 DNS、网络 ACL、TLS 终止和可靠 NTP 时间同步；
6. 每个服务的存活/就绪探针与优雅下线配置。

## 上线门禁

- `node tests/observability.mjs` 通过；
- 未授权、错误 token 访问 `/metrics` 和 `/readyz` 均返回 401；
- 生产弱 token 启动失败；
- 用测试手机号、邮箱、证件号、API Key 和数据库 URL 做日志泄露扫描，结果为零；
- 模型、GraphRAG、转人工、Outbox 在 Grafana 上均能产生非零测试信号；
- 停止一个依赖后 `/healthz` 仍反映进程存活，`/readyz` 返回 503；
- Alertmanager 的死信和接管 SLA 演练能到达值班人员。
