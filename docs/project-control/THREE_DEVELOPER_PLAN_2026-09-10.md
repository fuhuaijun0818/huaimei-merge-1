# 华美项目三人并行开发与整合方案

本方案依据 2026-09-10 当前代码结构制定，是待执行的协作方案。本次仅梳理分工，没有建立新分支、移动源码、提交代码或创建远程仓库。

## 一、分工原则

使用一个完整仓库，三名开发者各自克隆到独立目录、使用独立功能分支。每人负责一条业务线的界面、接口和测试，通过合并请求向项目负责人汇总。完整仓库保证每个人能独立启动项目；文件归属用于约束修改范围，不是删掉其他人的模块。

| 人员 | 业务线 | 负责的结果 | 建议技能 |
|---|---|---|---|
| A | 售前智能体与前台对话 | 理解客户问题、记住上下文、规划下一步、自然回答和前台体验 | 大模型应用、Node.js、React |
| B | 客户、会话与人工接待 | 从聊天留资到客户档案、会员查询、人工回复及预约登记形成闭环 | 全栈、实时通信、数据库 |
| C | 知识、资料、正式发布与岗位权限 | 已审核内容可靠供 AI 使用，不同岗位按权限操作和查看数据 | 全栈、知识检索、权限与数据治理 |

项目负责人保管集成分支、共用入口和发布权限，并负责跨模块验收。可以由当前 Codex 协助审查和整合，不需要额外增加第四名专职开发者。

## 二、现有代码归属

### A：售前智能体与前台对话

主要文件：
- `apps/acquisition-advisor/`：客户聊天页面、输入框、消息展示、资料引用、前台预约表单外壳。
- `server/agent-runtime.mjs`、`server/llm-client.mjs`：模型调用、答复生成与审核。
- `server/acquisition-turn-plan.mjs`、`server/acquisition-intent.mjs`、`server/acquisition-semantic-policy.mjs`、`server/acquisition-concern-understanding.mjs`：统一理解与意图。
- `server/acquisition-session.mjs`、`server/acquisition-choice-slots.mjs`、`server/acquisition-presales-dialogue.mjs`：对话记忆、偏好与任务状态。
- `server/acquisition-conversation-style.mjs`、`server/acquisition-emotion.mjs`、`server/acquisition-answer-routing.mjs`：表达和答复路由。
- `server/acquisition-domain-service.mjs`、`server/acquisition-orchestration.mjs`：调用业务能力、生成待确认动作；不实现客户库或预约库的写入逻辑。
- `server/chat-contact-capture.mjs`：姓名和联系方式的本地识别、调用留资能力、承接回执。
- `server/persistence/postgres-session-store.mjs`：对话状态持久化。

测试归属：统一规划、自然对话、语义追问、售前旅程、会话状态、模型客户端、对话风格；负责完整业务评测集的对话质量部分。

首轮任务：使用现有 80 例评测集建立质量基线并修复高优先级问题；补充主题切换、纠正、多问题和拒绝场景；完善流式响应、取消和异常恢复。不要另起一套聊天状态系统。

### B：客户、会话与人工接待

主要文件：
- `server/lead-store.mjs`、`server/contact-vault.mjs`：客户档案、留资、联系方式保存及授权展示。
- `server/integrations/member-repeatcheck-*.mjs`：院方已有客户记录查询。
- `server/appointment-intake-store.mjs`、`server/appointment-time.mjs`、`server/persistence/appointment-state-store.mjs`：到院意向登记与改期。
- `server/local-conversation-store.mjs`、`server/acquisition-operations-store.mjs`：会话归档、人工接管及接待任务。
- `server/persistence/postgres-lead-store.mjs`、`server/persistence/postgres-operations-store.mjs`、`server/persistence/postgres-contact-vault-store.mjs`：对应业务持久化。
- `src/conversation-unread.js`、`src/customer-presentation.js`、`src/member-check-display.js`：接待和客户展示。
- 拆分后的客户、接待和预约后台页面及 API 客户端。

测试归属：客户留资与去重、会员状态、预约登记、会话同步、消息未读、人工接管、客户数据权限消费端。

首轮任务：把后台人工回复真正发送到客户前台；确保接管期间 AI 停止答复；完成并发会话未读和消息重连；保证客户、会话、留资和预约记录相互关联。人工回复按钮是否可用，以真实发送回执为验收条件。

### C：知识、资料、发布与岗位权限

主要文件：
- `server/knowledge-intake-store.mjs`、`server/knowledge-publication.mjs`、`server/knowledge-release-policy.mjs`、`server/knowledge-governance-overview.mjs`：资料入库、审核、评测、激活、回滚。
- `server/huamei-knowledge.mjs`、`server/runtime-knowledge-index.mjs`、`server/knowledge-media.mjs`：AI 可用知识和资料引用。
- `src/project-knowledge.js`、`src/knowledge-catalog-import.js`：现有知识数据结构及导入。
- `server/persistence/knowledge-intake-persistence.mjs`、`server/persistence/postgres-knowledge-release-store.mjs`：知识持久化。
- `server/platform/management-accounts.mjs`、`server/platform/admin-browser-session.mjs`、`server/platform/management-authorization.mjs`、`server/platform/phase-one-role-policy.mjs`、`server/platform/postgres-object-acl-policy.mjs`：账号、登录、岗位与数据权限。
- `src/admin-session.js`、`src/role-catalog.js`、`assets/admin-login.*`：后台登录和角色展示。
- 拆分后的知识、发布、账号和权限管理页面及接口。
- 如后续批准启用 GraphRAG，C 负责检索服务、索引和证据准入，A 负责调用与问答效果；当前未启用的服务不应抢占首轮业务闭环任务。

测试归属：资料生命周期、知识发布、检索证据、跨进程生效、登录登出、五岗位权限、跨租户和对象级权限。

首轮任务：已发布知识在 AI 中实际生效，撤回或回滚后立即失效；明确资料版本与引用；验证五岗位的菜单、接口、数据三层权限。发布链路优先，现有账号能力以修复和回归为主，避免本轮范围过大。

## 三、先处理共用文件

当前 `src/app.js` 约 4,225 行，`server/api-router.mjs` 约 1,899 行，业务代码集中，直接让三个人同时编辑会产生大量冲突。

建议在并行开发前做一次保持行为不变的抽取，以下目录为建议新增目录，并非当前已完成结构：

```
src/modules/
  reception/        # B：会话、人工接待
  customers/        # B：客户
  appointments/     # B：预约管理
  knowledge/        # C：资料、审核、发布
  administration/   # C：账号与岗位
src/api/
  reception.js      # B
  customers.js      # B
  appointments.js   # B
  knowledge.js      # C
  administration.js # C
server/routes/
  public-chat.mjs   # A
  customer.mjs      # B
  reception.mjs     # B
  appointment.mjs   # B
  knowledge.mjs     # C
  administration.mjs # C
```

抽取后的入口文件只注册模块；鉴权、租户、错误处理继续走统一中间层。不能因拆文件而跳过原有权限检查。页面模块的样式使用自己的作用域文件，避免全局选择器相互覆盖。

负责人统一管理或批准变更的文件：`src/app.js`、`src/subpages.js`、`src/store.js`、`src/operations-client.js`、`src/management-runtime.js`、`styles.css`、`server/api-router.mjs`、`server.mjs`、`server/acquisition-service-server.mjs`、共用鉴权/租户中间层、`package.json` 与锁文件、`db/migrations/`、部署与 CI 配置。

C 维护权限领域实现，但对共用鉴权入口的签名或行为修改，需要负责人审查并要求 A/B 回归。数据库迁移由各业务开发者提出，合并前由负责人统一分配迁移编号和顺序；禁止修改已应用的迁移。共享入口变更单独提交，合并后其他分支同步。

## 四、跨模块接口先定契约

| 调用方 → 提供方 | 能力 | 必须固定的结果 |
|---|---|---|
| A → B | 保存联系信息 | tenant/conversation/message 标识、姓名/手机号；保存回执 accepted/invalid/failed、脱敏展示、客户关联；重复请求不重复建档 |
| B → A | 人工状态与消息 | agent/pending/human 状态、状态版本、消息 ID、发送回执；人工接管后禁止迟到 AI 回复覆盖 |
| A → B | 预约登记 | 模型只提意向；客户确认后返回登记 ID、版本、期望时间及待确认状态；登记不等于锁定医生名额 |
| A → C | 知识查询 | 查询、租户、发布版本；返回证据 ID、正文、公开范围、时效与引用；无结果时明确为空 |
| C → A | 发布版本变化 | 新旧版本号、撤回状态、索引就绪状态；保证撤回内容不能继续被回答或引用 |
| B/A → C | 权限与身份 | 统一 principal、岗位、租户及数据范围；前端菜单隐藏不能代替后端鉴权 |

契约可以放入新的 `contracts/` 目录，配套请求/响应示例和双方都运行的契约测试。先定义字段、错误码、身份传递、超时、重试和幂等语义，再各自实现。A 已使用内部留资回调，优先在现有接口上收敛，不重复造接口。

必须继承的业务约束：
- 客户主动提供手机号，格式通过后保存，不增加短信 OTP 前置验证；后续人工核对。
- 会员查询 `true` 表示已有记录，`false` 表示未找到记录；失败、超时、未查询必须单独表示，不能算作 `false`，也不能代表手机号归属已验证。
- 模型不能凭一段回复伪造保存、预约、付款或接送成功。
- 只有批准并正式发布的内容进入对客知识；院方价格、排班、政策缺少依据时不得编造。

## 五、代码汇总流程

当前工作分支为 `refactor/langchain-langgraph`，检查时有 186 项未提交变更。先梳理源码、测试、文档、运行数据和私密配置，验证后提交实际最新代码并打基线标签；不能仅从旧主分支复制一份代码给开发者，也不能把所有本地文件无差别提交。

建议流程及命名（待创建）：

```
已验证的共同基线
        ↓
integration/huamei-vnext  ← 项目负责人维护的集成分支
        ├─ feature/a-dialogue-001
        ├─ feature/b-reception-001
        └─ feature/c-knowledge-001
```

1. 每人从同一个基线取得完整项目；各自使用独立环境、临时测试数据库和模拟客户数据。
2. 一项功能一条短期分支；尽量每 1～2 个工作日交付一次可运行增量，不等全部功能结束再交代码。
3. 开发者先通过自己的模块测试和契约测试，再提交合并请求。提交前同步最新集成分支，先在自己分支解决冲突。
4. 负责人按依赖顺序整合：共用契约/模块抽取 → C 的权限/知识接口与 B 的业务接口（互不依赖者先后均可）→ A 的对接 → 跨模块验收。每次只合一个请求，保留可定位的提交记录。
5. 集成通过后，开发者再次同步新的集成基线；负责人统一生成候选版本、备份、迁移、发布和回滚。

每个合并请求至少带：功能说明、涉及接口及目录、测试结果、可复现演示步骤、数据库迁移、环境变量名称变化、已知限制和回退方法。配置提交模板，不提交本机密钥、生产密码或真实客户数据。

如果暂时无法共用远程仓库，可使用 Git bundle 或提交补丁移交，必须带基线提交号和提交历史，仍在负责人集成分支合并；不要用三份目录互相覆盖作为整合流程。

## 六、负责人跨模块验收清单

- 前台新咨询出现在后台同一会话，用户和 AI 消息顺序一致。
- 姓名手机号进入客户档案，会员查询状态正确；失败不丢失客户资料。
- 人工接管后 AI 不抢答，人工发送的内容到达原客户窗口；并发咨询的未读提示准确。
- 期望到院时间可登记、更正与取消，客户、会话及预约互相可追溯。
- 新发布知识可在对话中引用；撤回、回滚和跨租户隔离有效。
- 五岗位分别验证菜单、接口和数据范围；登出后不能继续使用旧会话访问后台。
- 原有关键对话评测不退化，模型不可用时业务保存和错误提示仍正确。

## 七、建议执行顺序

准备阶段：整理最新基线 → 抽离最容易冲突的页面和路由 → 确认接口及文件负责人 → 建立三人的独立环境。

第一轮并行：A 做对话质量和前台交互，B 做人工消息与留资预约闭环，C 做知识发布生效与权限回归。

第一轮整合：按上述清单做前后台联合演示并冻结候选版本。下一轮再根据缺陷和评测结果分配性能、渠道和运维工作。
