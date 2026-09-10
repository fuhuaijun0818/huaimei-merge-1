# A号开发交付规范｜智能体与前台对话

基线：`team-baseline-20260910-v1`。先阅读同目录《共同交付规范.md》。

## 第一轮目标

- 统一理解与任务推进、多轮语义及纠正
- 前台流式回复、输入连续性与异常恢复
- 对话评测集回归和结果归档

## 文件范围

- `apps/acquisition-advisor/`
- `server/acquisition-`
- `server/agent-runtime.mjs`
- `server/llm-client.mjs`
- `server/chat-contact-capture.mjs`
- `server/persistence/postgres-session-store.mjs`
- `tests/acquisition-`
- `tests/agent-runtime.mjs`
- `tests/llm-`
- `tests/natural-dialogue.mjs`
- `tests/presales-journey.mjs`
- `tests/chat-contact-capture.mjs`

实际文件归属按ownership.json中“共享优先、具体路径优先”判定。`src/app.js`和`server/api-router.mjs`仍是共用入口，不可整文件覆盖。

## 建议验证

- `npm run test:turn-planning`
- `npm run test:presales-dialogue`
- `npm run team:verify`
- 功能演示步骤、实际/预期结果及失败或blocked说明。

## 交付清单

- 增量代码bundle；自动manifest及SHA-256校验和。
- 填妥的report：功能、影响接口、测试、迁移、依赖/配置名称、限制与回退。
- 跨负责人文件逐项填写shared_changes；界面改动附模拟数据截图，可单独附在交付目录。
- 不提供真实生产账号、密钥、客户资料。

## 对接约定

向B调用留资、接管状态、预约能力；向C读取已发布知识。姓名手机号在本地处理，不能把业务成功状态交给模型臆测。不要直接修改B的客户库或C的发布逻辑。
