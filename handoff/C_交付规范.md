# C号开发交付规范｜知识发布与岗位权限

基线：`team-baseline-20260910-v1`。先阅读同目录《共同交付规范.md》。

## 第一轮目标

- 资料审核、发布生效、撤回与回滚闭环
- 知识引用版本和时效性
- 五岗位的菜单、接口、数据三层权限及登录登出

## 文件范围

- `server/knowledge-`
- `server/huamei-knowledge.mjs`
- `server/runtime-knowledge-index.mjs`
- `server/graphrag-client.mjs`
- `graphrag-service/`
- `knowledge/`
- `src/project-knowledge.js`
- `src/knowledge-catalog-import.js`
- `src/admin-session.js`
- `src/role-catalog.js`
- `assets/admin-login.`
- `server/platform/management-accounts.mjs`
- `server/platform/admin-browser-session.mjs`
- `server/platform/phase-one-role-policy.mjs`
- `server/platform/postgres-object-acl-policy.mjs`
- `server/persistence/knowledge-`
- `server/persistence/postgres-knowledge-`
- `src/modules/knowledge/`
- `src/modules/administration/`
- `server/routes/knowledge.mjs`
- `server/routes/administration.mjs`
- `tests/knowledge-`
- `tests/huamei-knowledge`
- `tests/admin-browser-`
- `tests/phase-one-role-policy.mjs`
- `tests/management-role-navigation.mjs`
- `tests/superadministrator-policy.mjs`

实际文件归属按ownership.json中“共享优先、具体路径优先”判定。`src/app.js`和`server/api-router.mjs`仍是共用入口，不可整文件覆盖。

## 建议验证

- `npm run test:admin-session`
- `npm run test:phase-one-boundary`
- `npm run team:verify`
- 功能演示步骤、实际/预期结果及失败或blocked说明。

## 交付清单

- 增量代码bundle；自动manifest及SHA-256校验和。
- 填妥的report：功能、影响接口、测试、迁移、依赖/配置名称、限制与回退。
- 跨负责人文件逐项填写shared_changes；界面改动附模拟数据截图，可单独附在交付目录。
- 不提供真实生产账号、密钥、客户资料。

## 对接约定

为A提供发布版本、证据及撤回状态，为B提供统一权限能力。公开开发子集不等于正式发布数据。共用鉴权入口调整单独申报并要求A/B回归。
