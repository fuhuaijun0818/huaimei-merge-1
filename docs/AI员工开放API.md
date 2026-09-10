# 时代之美 AI 员工开放 API

版本：1.1.0  
运行方式：本地 Node.js 服务  
默认地址：`http://127.0.0.1:4173`

## 1. 能力与医疗边界

本 API 对外提供 6 个面向医美客户全生命周期的 AI 员工，支持项目一般信息讲解、需求澄清、预约推进、到院交接、普通随访、复购机会摘要和合规检查。

系统不提供：

- 医疗诊断、个体适用性判断、具体治疗方案或用药建议。
- 安全、效果、价格或恢复周期的绝对化承诺。
- 通过客户照片做面部诊断、颜值评分或项目适用性判断。
- 在缺少有效营销授权时进行邀约或复购对外触达。

当输入命中个体适用性、异常感受、用药或绝对化承诺等风险时，运行时返回 `handover_required` 或 `blocked`，不继续对外输出业务答案。

## 2. 智能体目录

| ID | slug | 岗位 | 阶段 | 执行级别 |
|---|---|---|---|---|
| A-01 | `acquisition-consultant` | AI获客顾问·小美 | 售前 | L2 受控执行 |
| A-02 | `appointment-specialist` | AI邀约专员·小美 | 售前 | L2 受控执行 |
| A-03 | `arrival-assistant` | AI接待助手·小华 | 售中 | L1 审批优先 |
| A-04 | `aftercare-assistant` | AI售后关怀·安安 | 售后 | L1 审批优先 |
| A-05 | `repurchase-advisor` | AI复购顾问·悦悦 | 售后 | L1 审批优先 |
| A-06 | `compliance-guardian` | 合规守门员 | 全阶段 | L4 强制门禁 |

## 3. 启动与安全配置

开发环境可直接启动：

```bash
npm start
```

本地演示默认密钥为 `hm_local_demo_key_2026`。该密钥不能用于任何真实环境。正式部署至少应配置：

```bash
HUAMEI_API_KEY=replace_with_a_long_random_secret \
HUAMEI_ALLOWED_ORIGINS=https://crm.example.com,https://workbench.example.com \
HUAMEI_API_RATE_LIMIT=60 \
npm start
```

| 环境变量 | 用途 | 默认值 |
|---|---|---|
| `HUAMEI_API_KEY` | API 密钥 | 本地演示密钥 |
| `HUAMEI_ALLOWED_ORIGINS` | 允许浏览器跨域调用的 Origin，逗号分隔 | 本地 4173 端口 |
| `HUAMEI_API_RATE_LIMIT` | 每个 API Key 每分钟调用上限 | 60，最低 10 |
| `HUAMEI_PUBLIC_WEB_RATE_LIMIT` | 获客顾问公开问答/留资每IP每分钟上限 | 20，最低 5 |
| `HUAMEI_LEAD_STORE_FILE` | 本地获客线索文件；测试可设为`:memory:` | `.local-data/acquisition-leads.json` |
| `HUAMEI_IDENTITY_PEPPER` | 手机号HMAC身份标识密钥；正式环境必须替换 | 本地演示值 |
| `HUAMEI_HOST` | 服务监听地址 | `127.0.0.1` |
| `PORT` | 本地服务端口 | 4173 |

默认只允许本机访问。如需在受控内网向CRM或企微中台开放，可设置 `HUAMEI_HOST=0.0.0.0`，但必须同时设置长度不少于24位且不等于演示密钥的 `HUAMEI_API_KEY`，否则服务拒绝启动。面向公网时需要在反向代理或API网关后终止TLS，不直接暴露Node.js端口。

### 3.1 大模型配置

服务启动时自动读取项目根目录的 `.env.local`。该文件已加入 `.gitignore`，不得提交、上传或通过API提供。

```dotenv
HUAMEI_LLM_ENABLED=true
HUAMEI_LLM_PROVIDER=aliyun_model_studio
HUAMEI_LLM_BASE_URL=https://example.com/compatible-mode/v1
HUAMEI_LLM_API_KEY=replace_with_your_secret
HUAMEI_LLM_MODEL=qwen3.7-flash
HUAMEI_LLM_TIMEOUT_MS=20000
HUAMEI_LLM_MAX_RETRIES=1
```

LLM启用时的运行顺序：

1. 确定性规则执行输入合规检查和授权检查。
2. 命中医疗边界或禁用表达时直接转人工/阻断，不向模型发送请求。
3. 本地岗位规则产生事实草稿、可用动作和已批准引用。
4. 模型只接收已脱敏的任务、阶段、兴趣、已给出时段和少量需求字段，以JSON Object模式生成。
5. 响应经结构校验和确定性后检查后返回；超时、断网或无效JSON时降级为本地草稿。

## 4. 认证、幂等与限流

除健康检查、OpenAPI规范以及终端获客顾问的两个公开端点外，管理与合作系统接口都必须传入：

```http
X-API-Key: <secret>
```

调用接口建议每次传入唯一幂等键：

```http
Idempotency-Key: crm-event-20260810-0001
```

相同 API Key、路径和幂等键在 10 分钟内重放时返回同一结果，响应头含 `X-Idempotent-Replay: true`。限流状态通过 `X-RateLimit-Limit`、`X-RateLimit-Remaining` 和 `X-RateLimit-Reset` 返回。

## 5. 接口清单

| 方法 | 路径 | 作用 | 鉴权 |
|---|---|---|---|
| GET | `/api/health` | 健康检查 | 否 |
| GET | `/api/v1/openapi.json` | OpenAPI 3.1 规范 | 否 |
| POST | `/api/public/acquisition-chat` | 获客顾问项目知识问答与留资引导 | 否，按IP限流 |
| POST | `/api/public/acquisition-lead` | 授权留资，创建或合并客户360 | 否，按IP限流 |
| GET | `/api/local/acquisition-customers` | 管理端同步租户内获客客户快照 | 生产OIDC `customer:read` + `tenant_ids`；本地回环兼容 |
| GET | `/api/v1/agents` | 获取 6 个智能体 | 是 |
| GET | `/api/v1/model/status` | 获取不含密钥的模型运行时状态 | 是 |
| GET | `/api/v1/agents/{agentId}` | 获取智能体详情 | 是 |
| POST | `/api/v1/agents/{agentId}/invoke` | 指定智能体调用 | 是 |
| POST | `/api/v1/router/invoke` | 按意图和生命周期自动路由 | 是 |
| POST | `/api/v1/compliance/check` | 独立合规检查 | 是 |
| GET | `/api/v1/runs?limit=50&tenant_id=...` | 运行审计列表 | API Key + 生产OIDC `runs:read` + `tenant_ids` |
| GET | `/api/v1/runs/{runId}?tenant_id=...` | 单次运行详情 | API Key + 生产OIDC `runs:read` + `tenant_ids` |

### 5.1 终端留资与手机号同客识别

获客顾问回答完成后，`/api/public/acquisition-chat` 会返回 `lead_capture` 和 `profile_signals`。客户明确勾选本次咨询服务授权后，前端提交：

```json
{
  "name": "林女士",
  "mobile": "13812345678",
  "service_consent": true,
  "session_id": "web-session-id",
  "interests": ["热玛吉", "线雕提升"],
  "messages": [{ "role": "user", "content": "热玛吉和线雕有什么区别？" }]
}
```

服务端会校验11位中国大陆手机号格式，规范化手机号并生成租户内HMAC标识。客户同意本次咨询联系后立即保存线索和加密联系方式，手机号状态为`pending_manual`，由销售顾问回电时人工核对。公网统一返回HTTP 200的最小`accepted`回执，仅含待人工核号状态、脱敏手机号、不透明回执号和会话凭证。响应不返回客户ID、姓名、兴趣、阶段、管理路径、是否命中既有档案或院方查重结果。

## 6. 调用请求

```json
{
  "customer_id": "C-202608-001",
  "message": "我想了解热玛吉的一般流程，并看看周三是否能到院评估",
  "channel": "partner_api",
  "mode": "assist",
  "context": {
    "macro_stage": "售前",
    "micro_stage": "留资待预约",
    "interests": [{ "name": "热玛吉", "score": 92 }],
    "service_consent": true,
    "marketing_consent": true,
    "owner": "周妍",
    "available_slots": ["周三 12:20", "周四 15:30"]
  }
}
```

`mode` 支持：

- `assist`：内部辅助，默认值。
- `reply`：对当前客户消息生成回复。
- `outbound`：主动对外触达；A-02 和 A-05 会强制校验 `marketing_consent` 并可能进入人工审批。

`context` 是客户360与渠道系统向智能体传入的最小上下文，建议仅传入当次任务必需字段，不传照片原图、证件号或无关医疗记录。服务端会再次构建白名单上下文，不将姓名、手机号原值、照片和未允许profile字段发送给模型。

## 7. 调用响应

```json
{
  "request_id": "req_...",
  "run_id": "run_...",
  "agent": {
    "id": "A-01",
    "slug": "acquisition-consultant",
    "name": "AI获客顾问·小美",
    "version": "3.4.0"
  },
  "status": "completed",
  "output": {
    "message": "...",
    "structured_data": {},
    "recommended_actions": [],
    "handover": { "required": false },
    "citations": []
  },
  "guardrails": {
    "medical_diagnosis_allowed": false,
    "suitability_judgement_allowed": false,
    "consent_checked": false,
    "compliance_gate_version": "4.1.0",
    "precheck_decision": "allow",
    "postcheck_decision": "allow",
    "llm_used": true,
    "model_output_validated": true
  },
  "usage": {
    "provider": "aliyun_model_studio",
    "model": "qwen3.7-flash",
    "prompt_tokens": 620,
    "completion_tokens": 120,
    "total_tokens": 740,
    "latency_ms": 2300,
    "input_characters": 15,
    "output_characters": 61
  },
  "created_at": "2026-08-10T00:00:00.000Z"
}
```

| `status` | 含义 | 调用方建议 |
|---|---|---|
| `completed` | 调用完成 | 按业务场景展示或执行建议动作 |
| `approval_required` | 需人工审批 | 创建审批任务，审批前不对外发送 |
| `handover_required` | 需人工/专业人员接管 | 停止 AI 对外执行并按 `handover.to_team` 分配 |
| `blocked` | 合规或授权门禁拦截 | 不发送，进入合规改写或授权核实 |

HTTP 200 表示 API 成功完成了业务决策；业务上是否允许继续必须以 `status` 和 `output.handover` 为准。

## 8. 调用示例

指定 A-01：

```bash
curl -X POST http://127.0.0.1:4173/api/v1/agents/A-01/invoke \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: hm_local_demo_key_2026' \
  -H 'Idempotency-Key: lead-001' \
  -d '{"message":"请介绍热玛吉的一般流程","mode":"assist","context":{"interests":["热玛吉"]}}'
```

自动路由：

```bash
curl -X POST http://127.0.0.1:4173/api/v1/router/invoke \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: hm_local_demo_key_2026' \
  -d '{"message":"周三几点可以预约到院？","context":{"macro_stage":"售前","marketing_consent":true}}'
```

单独合规检查：

```bash
curl -X POST http://127.0.0.1:4173/api/v1/compliance/check \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: hm_local_demo_key_2026' \
  -d '{"message":"这个项目保证安全、一定有效而且永久"}'
```

## 9. 错误格式

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数校验失败",
    "details": [{ "field": "message", "message": "message为必填字符串" }]
  },
  "request_id": "req_..."
}
```

常见状态码：`400` 参数或 JSON 错误、`401` 密钥无效、`403` Origin 不允许、`404` 资源不存在、`413` 请求体超过 64KB、`429` 超过限流。所有响应均带 `X-Request-Id`。

## 10. 当前 MVP 边界与生产化要求

当前运行时已接入OpenAI兼容大模型，并保留确定性规则门禁和本地降级。运行记录、限流桶和幂等结果保存在当前 Node.js 进程内存中，重启后清空，不适用于多实例生产环境。

生产化时需要增加：

- API 网关、客户端凭证管理、OAuth2 或等价机制、密钥轮换与密钥托管。
- 多租户数据隔离、最小权限、出口 IP 策略和服务间身份校验。
- 持久化审计数据库、分布式限流与幂等存储、不可篡改留痕。
- 知识向量检索、提示词版本、模型评测门槛、多模型路由、回退与灰度。
- 外部模型服务的数据处理协议、地域与日志留存策略，以及真实客户数据上线前的医院安全评审。
- 告警、链路追踪、容灾、数据保留/删除策略和医院安全合规验收。

系统的机器可读规范以 `/api/v1/openapi.json` 为准。
