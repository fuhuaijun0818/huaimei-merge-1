# B号开发交付规范｜客户与人工接待

基线：`team-baseline-20260910-v2`。先阅读同目录《共同交付规范.md》。

## 第一轮目标

- 后台人工回复真正到达前台；接管后AI不抢答
- 多客户未读与消息重连
- 客户、会话、会员查询和预约关联

## 文件范围

- `server/lead-store.mjs`
- `server/contact-vault.mjs`
- `server/integrations/`
- `server/appointment-`
- `server/local-conversation-store.mjs`
- `server/acquisition-operations-store.mjs`
- `server/persistence/postgres-lead-store.mjs`
- `server/persistence/postgres-operations-store.mjs`
- `server/persistence/postgres-contact-vault-store.mjs`
- `server/persistence/appointment-state-store.mjs`
- `src/conversation-unread.js`
- `src/customer-presentation.js`
- `src/member-check-display.js`
- `src/modules/reception/`
- `src/modules/customers/`
- `src/modules/appointments/`
- `server/routes/reception.mjs`
- `server/routes/customer.mjs`
- `server/routes/appointment.mjs`
- `tests/lead-store.mjs`
- `tests/contact-`
- `tests/member-`
- `tests/appointment-`
- `tests/conversation-unread.mjs`
- `tests/local-conversation-sync.mjs`
- `tests/customer-presentation.mjs`
- `tests/management-handover-ui.mjs`

实际文件归属按ownership.json中“共享优先、具体路径优先”判定。`src/app.js`和`server/api-router.mjs`仍是共用入口，不可整文件覆盖。

## 建议验证

- `npm run test:member-check`
- `npm run test:acquisition-orchestration`
- `npm run team:verify`
- 功能演示步骤、实际/预期结果及失败或blocked说明。

## 交付清单

- 增量代码bundle；自动manifest及SHA-256校验和。
- 填妥的report：功能、影响接口、测试、迁移、依赖/配置名称、限制与回退。
- 跨负责人文件逐项填写shared_changes；界面改动附模拟数据截图，可单独附在交付目录。
- 不提供真实生产账号、密钥、客户资料。

## 对接约定

为A提供有明确失败语义的业务回执；人工消息与AI共用会话标识。联系人/客户/会话关系稳定，前端只更新相关窗口。账号与数据权限使用C的能力。
