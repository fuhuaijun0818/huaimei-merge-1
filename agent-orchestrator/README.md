# LangGraph 编排服务（P0-A）

这是华美售前智能体的独立编排进程。它只接受已由 Node 网关完成认证、租户绑定、入站去重和顺序分配后的最小化请求，并只返回可校验的 `TurnDecision`。

P0-A 的边界是明确的：不接入真实客户数据、不调用 Qwen、不读取企业知识、不执行预约/工单/人工接待、不投递任何渠道消息。Node 仍以 Legacy 引擎作为唯一对客权威。

## 本地验证

```bash
./agent-orchestrator/.venv/bin/python -m unittest discover -s agent-orchestrator/tests -v
npm run test:langgraph-contract
npm run test:langgraph-live
```

启动前必须通过环境变量提供独立的 `HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET`。可复制 `.env.example` 后填入本地随机值；不得复用网关、Qwen、GraphRAG 或数据库密码。

`HUAMEI_LANGGRAPH_ENABLE_DURABLE_CHECKPOINTS` 在 P0-A 必须保持 `false`。后续只有完成独立 Checkpoint Schema、最小权限角色、租户隔离、保留/删除策略和迁移演练后，才能在审批通过的环境中启用。

## 数据与信任边界

- `thread_id` 由 Node 根据租户、渠道、会话和独立密钥派生；不包含手机号或外部会话 ID。
- 原始消息和 `authorization_context` 仅作为一次运行时上下文传入，不写入 LangGraph durable state。
- 图状态只保留不含原文的运行标识、路由/风险结论及 schema 化决策。
- `TurnDecision` 不是客户可见回复。Node 只有在顺序、状态版本和 fencing token 的 compare-and-set 成功后才能提交；该提交和任何外发仍在后续 R1/R2 实现。
