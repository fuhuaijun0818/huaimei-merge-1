# 华美一期：本地 JSON 到 PostgreSQL 数据迁移运行手册

版本：1.1
基线日期：2026-08-26  
适用范围：A-01 售前智能体的会话、线索、人工接管、任务、工时、知识发布、智能体运行及客户数据权利处理  
关联设计：[生产数据模型](../architecture/PRODUCTION_DATA_MODEL.md)  
当前结论：**NO-GO。PostgreSQL、RLS、字段加密和核心领域适配已形成开发/全新容器工程证据，但真实源数据迁移、正式知识、隐私删除/导出、生产恢复和签字仍未完成。完成第 4 节全部阻断项之前，不得切换生产写流量，也不得把迁移后的知识 release 激活为对客版本。**

## 1. 目的与迁移原则

本手册用于把当前本地 MVP 中的 JSON/进程内状态迁移到 PostgreSQL，并给出可审计、可校验、可停止、可回退的执行路径。它不是普通的“导入一次数据”，而是生产事实源切换。

迁移必须遵守以下原则：

1. PostgreSQL 是切换后的唯一业务事实源；JSON 仅保留为只读迁移证据。
2. 不猜测租户、不补造历史、不把缺失授权解释为已授权。
3. 原始文件先快照、后处理；任何清洗都发生在派生副本，不修改源文件。
4. 每个目标记录都能追溯到迁移批次、源文件 SHA-256 和 legacy 标识。
5. C2/C3 数据全程最小化、加密、脱敏展示；不得出现在命令输出、普通日志和对账表中。
6. 迁移可重复执行，同一批次重跑不得产生重复业务事实。
7. 迁移错误进入隔离清单，不得静默跳过、自动归租户或用当前时间填充关键事实。
8. 知识 release、批准记录集合和 GraphRAG 索引制品必须通过内容 SHA 绑定；仅凭版本号或记录数不能激活。
9. 切换后的新事实不得反向覆盖回 JSON。发生故障时优先停 AI、转人工和向前修复。
10. 授权撤回、导出、删除、法律保留和备份恢复后的删除重放是上线门槛，不是后补功能。

## 2. 范围边界

### 2.1 本次迁移范围

| 领域 | 当前来源 | 目标事实 | 备注 |
| --- | --- | --- | --- |
| 会话与最近轮次 | `.local-data/acquisition-sessions.json` | `conversation_sessions`、`conversation_messages` 及会话状态投影 | 现有会话仅保留最近 16 个来回；通用导入器当前只写会话状态，不代表消息历史已迁移 |
| 线索与客户快照 | `.local-data/acquisition-leads.json` | `leads`、`consents`及会话关联 | 现有快照含 AI 推断字段；通用导入器只允许已批准租户的受控批次 |
| 接管、任务、事件、工时 | `.local-data/acquisition-operations.json` | `handovers`、`tasks`、`human_work`、审计/领域事件 | 文件可能尚未生成，切换前必须再次盘点 |
| 知识发布 | `.local-data/knowledge-releases.json` | `knowledge_releases`、`knowledge_reviews`、批准记录清单SHA及GraphRAG manifest绑定 | 三审与绑定表/函数已存在；通用导入器拒绝自动导入旧release，原`active`不能继承 |
| 智能体运行 | `agent-runtime.mjs` 进程内 `runs` Map | `agent_runs`中的版本、响应、护栏、引用与审计快照 | PostgreSQL运行存储已存在；旧Map最多500条且仍没有受控全量导出能力 |
| 知识与索引制品 | 知识库 manifest、knowledge units、GraphRAG `current.json` 和索引目录 | 对象存储不可变制品、知识元数据及 release-index 绑定 | 索引是派生制品，不是知识事实源 |

### 2.2 不在本次范围

- 医师数字人 runtime、音视频、图片和上传文件。
- CRM、企业微信和预约系统中的权威历史数据；它们应通过独立接口或后续迁移批次接入。
- 无法从当前进程或源文件恢复的历史运行记录。禁止为补齐报表而伪造。

## 3. 当前源数据盘点基线

以下只是在 2026-08-26 工作区核对到的**动态快照**，不是切换清单。正式迁移必须在冻结窗口重新生成清单。

| 来源 | 当前观察 | 风险/处理 |
| --- | --- | --- |
| `acquisition-sessions.json` | 文件存在，version=1，当前 1 个 session 键 | 键形如 `tenant:channel:conversation`；仍须逐条验证键内租户与目标租户一致 |
| `acquisition-leads.json` | 文件存在，version=1，当前 2 条 lead | 当前样本均缺少 `tenant_id`；未经数据负责人书面指派不得迁移 |
| `acquisition-operations.json` | 当前未发现 | 不得等价为“历史为零”；记录文件不存在、检查时间和服务状态，切换冻结时复查 |
| `knowledge-releases.json` | 当前未发现 | 当前知识模式不能因此视为已审批；生产必须重新完成三审与 SHA 绑定 |
| 进程内 `runs` | 最多保存 500 条，服务重启即丢失 | 当前列表接口最多返回 100 条审计摘要，不能可靠导出全部响应、引用和模型调用 |

### 3.1 冻结清单格式

迁移经理必须为每个来源生成一条不可修改的清单记录：

- `migration_batch_id`、环境、主机、服务版本/提交号。
- 绝对路径或对象 URI、文件是否存在、文件大小、mtime、权限所有者。
- SHA-256、JSON schema/version、顶层键。
- 总记录数、按租户计数、最早/最晚时间、状态分布。
- 敏感级别、数据负责人、保留期、法律保留状态。
- 读取结果：成功、空文件、缺失、损坏、无法读取。
- 盘点人、复核人、盘点时间和签名。

源清单中不得出现姓名、手机号哈希、会话正文、外部用户 ID 或消息预览。

### 3.2 源快照

1. 在写冻结生效后复制源文件和知识/索引 manifest 到只读迁移归档。
2. 归档使用独立私有桶或受限目录，服务端加密，迁移账号只读。
3. 对源文件和归档副本分别计算 SHA-256，必须完全一致。
4. 保存数据库备份/PITR 检查点、运行服务进程标识和冻结时间。
5. 归档对象禁止同名覆盖；任何重取都创建新批次。
6. 迁移工作目录在批次结束后按批准期限销毁，销毁动作写审计。

## 4. 切流前状态与阻断项

本节区分“代码/全新容器工程闭环”和“真实生产切流证据”。前者完成不等于后者通过；任一 P0 未关闭均不得切流。

### 4.1 已关闭的工程差距（E1/E2，不是生产签字）

| 工程项 | 当前实现与证据 | 当前判断 |
| --- | --- | --- |
| PostgreSQL领域适配 | 会话、线索、授权、接管、任务、工时、知识release、agent run、隐私请求均有PostgreSQL store；见`server/persistence/`及`tests/postgres-domain-integration.mjs` | 工程已关闭；预生产仍待验收 |
| 版本化schema与权限 | `db/migrations/001_initial_schema.sql`至`011_contact_vault.sql`；owner/migrator/runtime分离、全部租户表`FORCE RLS`；见`tests/postgres-migration-integration.mjs`、`tests/postgres-rls-integration.mjs` | 工程已关闭；生产角色与托管库仍待验证 |
| 多实例会话与协调 | PostgreSQL确定序号、同消息幂等、超时恢复、跨实例抢单；Redis原子限流/幂等；见`tests/postgres-session-consistency.mjs`、`tests/postgres-domain-integration.mjs`、`tests/redis-live-integration.mjs` | 工程已关闭；不等于HA故障切换通过 |
| Outbox | 领域写入、审计与Outbox事务闭环，含租约、重试和死信worker；见`tests/postgres-outbox-integration.mjs`、`docs/operations/OUTBOX_DELIVERY_RUNBOOK.md` | 工程已关闭；真实下游、积压告警和补偿待演练 |
| 字段加密 | 会话/消息、lead/candidate profile、授权、接管、工时、agent run和隐私请求采用AES-256-GCM，AAD绑定租户/用途/命名字段记录ID；提供停写窗口内v1→v2原子重包和发布清零门禁；见`tests/postgres-field-envelope-v2-migration-integration.mjs`、`docs/operations/FIELD_ENCRYPTION.md` | 工程已关闭；生产KMS和恢复密钥仍待接入 |
| 知识三审与索引绑定 | 三个不同审核人、批准记录清单、package/index/manifest SHA和official GraphRAG契约已落库；见`tests/postgres-knowledge-workflow-integration.mjs`及`graphrag-service/tests/` | 工程已关闭；当前没有正式active release |
| 数据主体请求 | 建单、身份核验、OIDC实名处理、双角色复核和租户隔离已实现；见`tests/postgres-privacy-rights-integration.mjs`、`tests/acquisition-service-privacy-integration.mjs` | 工程已关闭；实际处理政策与签字待华美确认 |
| 撤回与限制处理 | `008_privacy_execution_controls.sql`提供双人批准、用途抑制、授权撤回、未开始任务取消和审计/Outbox；见`tests/postgres-privacy-execution-integration.mjs` | 开发闭环；导出/删除不在此结论内 |
| legacy授权保护 | 通用导入器不把`serviceConsent/marketingConsent`布尔值写成有效`consents`，只在加密profile中保存“未核验主张”并报告`legacy_consent_flags_not_promoted`；见`scripts/migrate-local-json-to-postgres.mjs`及`tests/postgres-field-encryption-integration.mjs` | 工程已关闭；真实客户仍须重新授权或同步权威证据 |

### 4.2 仍阻断真实切流

| 等级 | 当前阻断项 | 所需关闭证据 | 负责人 |
| --- | --- | --- | --- |
| P0 | 尚未在冻结窗口生成真实源清单、归档SHA、租户指派和法律保留清单，也未完成两次同版本dry-run | 只读源快照、双人签字清单、两次控制总数/差异/隔离报告 | 数据迁移负责人、业务数据负责人 |
| P0 | 通用导入器当前只受控导入session状态和lead；不会恢复独立`conversation_messages`，并显式拒绝自动导入operations和knowledge release | 分领域专用导入批次、确定性映射、关联/去重/回放测试；或签字接受不可恢复范围 | 应用负责人、数据迁移负责人 |
| P0 | 历史进程内runs没有受控全量导出；最多500条且重启丢失 | 一次性受控导出并与`agent_runs`对账，或正式签署历史不可恢复差异 | 应用负责人、审计负责人 |
| P0 | 只有批次级manifest/计数；逐行`legacy_source/legacy_id/source SHA`映射与无明文quarantine尚未形成通用能力 | 每行来源映射、唯一约束、隔离复核、重跑与销毁证据 | 数据迁移负责人、DBA |
| P0 | 旧knowledge release没有批准的状态映射和专用导入器；当前正式official索引、三份实名回执和active release均不存在 | 旧`active`保持不可对客；重新三审、生成不可变official索引、绑定并在enforce模式激活 | 知识平台、业务/医务/合规三审人 |
| P0 | 部分legacy lead缺`tenant_id`，手机号HMAC/掩码不能恢复联系方式；正式联系目的、渠道身份和权威联系人来源未批准 | 逐条租户归属；从权威来源取得已授权且加密的联系方式；重新授权记录 | 数据负责人、隐私负责人 |
| P0 | 导出和删除当前只生成`manual_pending`计划；没有加密导出制品、第三方信息排除、物理删除、对象/下游回执、legal hold和备份删除重放 | 导出→交付→到期销毁，以及删除→缓存/对象/下游→备份恢复后重放的端到端演练 | 隐私负责人、运维负责人 |
| P0 | 尚无生产KMS、对象存储、托管PostgreSQL/Redis HA、PITR、正式备份及恢复库 | 密钥轮换、备份恢复、RPO/RTO、故障切换和权限审计报告 | 华美IT、DBA、安全负责人 |
| P0 | 尚未在预生产使用同一不可变镜像完成真实模型、正式知识、20并发持续30分钟、告警送达、停AI与回滚演练 | 绑定镜像/release/index/model的原始报告、监控窗口、演练时间线和责任人签字 | QA、SRE、发布负责人 |
| P0 | 枚举映射和历史截断仍需业务批准：handover `active→claimed`、priority文本→0–100，以及最多5,000 events/最近轮次缺口 | 批准映射、往返测试、不可恢复范围和差异签字 | 产品负责人、审计负责人 |

关闭阻断项时必须附：变更编号、环境、代码与镜像版本、原始报告SHA、责任人、复核人和关闭时间。口头确认、开发机通过或单一 happy-path 截图不构成生产关闭证据。

## 5. 角色与决策权

| 角色 | 主要责任 | 必须签字的门槛 |
| --- | --- | --- |
| 项目总负责人/变更指挥官 | 批准窗口、统一指挥、Go/No-Go、事件升级 | dry-run、最终切换、结束回滚窗口 |
| 数据迁移负责人 | 清点、转换、批次、隔离、对账、迁移报告 | 源清单、控制总数、差异解释 |
| 应用负责人 | PostgreSQL repository、冻结/切流开关、幂等、Outbox、运行持久化 | 影子验证、切流健康、应用回退方案 |
| DBA | DDL、RLS、备份/PITR、性能、迁移账号、回滚点 | schema ready、备份恢复演练、数据库校验 |
| 安全/隐私负责人 | 数据分级、KMS、脱敏、访问审批、撤回/导出/删除 | C2/C3 处理、客户权利演练、日志抽查 |
| 业务数据负责人 | 租户归属、客户/线索语义、状态和枚举映射 | 缺租户数据处置、业务抽样、active 接管 |
| 业务/医务/合规三审人 | 知识记录审查与 release 批准 | 三审、record list、对客激活 |
| GraphRAG/知识平台负责人 | 知识包、索引制品、SHA、binding、回滚版本 | SHA 验证、索引召回、release 切换 |
| QA 负责人 | dry-run、数据一致性、回归、跨租户/故障/恢复测试 | 所有自动与人工验收结果 |
| 运维/SRE | 监控、告警、队列、只读归档、切流和事件响应 | 依赖健康、观察窗口、备份/恢复/停 AI 演练 |

同一人可以兼任多个执行角色，但生产 Go 决策至少需要项目总负责人、DBA、应用、数据、隐私、知识三审和 QA 的独立确认；知识三审不得由同一账号代签三种角色。

## 6. 敏感数据保护

### 6.1 访问与运行环境

- 使用一次性迁移服务账号，只授予指定租户和目标表的最小权限；窗口结束立即停用。
- 迁移工作节点位于受控网络，不使用个人网盘、聊天工具、公共粘贴板或未批准模型处理源数据。
- 凭据只从密钥托管注入，不写入命令历史、脚本参数、日志、文档或迁移 manifest。
- 日志只输出批次 ID、legacy token、计数、错误码和摘要；错误样本正文写入加密隔离区并受限访问。
- 临时文件权限不高于 `0600`，临时目录不与应用容器或普通用户共享。

### 6.2 字段处理

| 数据 | 迁移处理 |
| --- | --- |
| 会话/消息正文 | 按 C3 处理；迁移时加密或写入私有对象存储，数据库保存受控引用、SHA 和脱敏预览 |
| 姓名、城市、渠道 ID | 按 C2 处理；列表默认脱敏，外部 ID 加密并生成租户域内检索 HMAC |
| 手机号 | 当前源只有 HMAC 和掩码，按原样迁移为 legacy identity 线索；不得生成或猜测明文 |
| AI 推断的兴趣/痛点/风险 | 标记 `legacy_ai_inference`、来源和置信度；允许人工更正，不当作客户自述事实 |
| 授权 | 缺法律文本版本/时间/证据的一律标 `legacy_asserted` 或无效，不授予主动触达能力 |
| 审计 | 只保存最小化事实和不可逆摘要；不得复制完整正文到 `audit_events.details` |
| 知识制品 | 只把已批准 C0/允许的 C1 内容放入对客索引；聊天记录和客户材料不得进入 GraphRAG |

### 6.3 完成后的清理

- 销毁未加密工作副本、查询导出、临时日志和隔离区中已处置副本。
- 对源归档、迁移报告、隔离记录分别应用批准的保留期和法律保留策略。
- 通过扫描确认应用日志、指标标签和追踪中没有手机号、姓名、外部用户 ID 或消息正文。

## 7. 迁移批次与可重复执行约定

在开始开发迁移器前，数据库必须补齐以下最小控制结构或等价能力：

### 7.1 `migration_batch`

至少保存：批次 ID、环境、源/目标版本、代码提交号、状态、开始/结束时间、执行人、复核人、冻结时间、切换时间、总数摘要和报告 URI。

状态建议：`planned → inventoried → snapshotted → dry_run_passed → importing → validated → cutover → observing → completed`，失败进入 `failed` 或 `rolled_back`。状态只能通过受审计动作推进。

### 7.2 `migration_source_artifact`

至少保存：批次 ID、源类型、路径/URI、存在状态、大小、mtime、SHA-256、schema version、敏感级别、记录数和归档 URI。

### 7.3 `migration_legacy_map`

至少保存：批次 ID、租户、源制品 SHA、源集合、legacy ID/token、目标表、目标 ID、转换版本和目标摘要。对同一源 SHA + legacy ID 建唯一约束，保证重跑幂等。

### 7.4 `migration_quarantine`

至少保存：批次 ID、源 token、错误码、字段路径、数据分类、加密证据引用、处置状态、处置人和处置说明。隔离记录不得存明文敏感内容。

## 8. 确定性映射与隔离规则

详细字段映射以生产数据模型第 17 节为准。运行时必须额外遵守以下规则：

### 8.1 租户

- JSON 明确有 `tenant_id`：规范化后必须存在于批准租户映射表。
- session 对象键含租户：键内租户、记录内租户和批次目标租户必须一致。
- 缺少 `tenant_id`：进入 `TENANT_ASSIGNMENT_REQUIRED`；仅在业务数据负责人书面确认“整个源制品只属于指定租户”后按批次映射。
- 禁止使用运行环境的默认租户静默补齐。

### 8.2 会话与消息去重

优先业务键：`tenant_id + channel + external_conversation_id`。消息优先使用稳定外部 message ID；没有时，以规范化的 `conversation + direction + occurred_at + content_sha256 + source_position` 生成迁移专用确定性 ID。

session turns 与 lead conversations 重复时：

1. 外部 message ID 一致则合并。
2. 无 ID 但方向、规范时间、内容 SHA 一致则合并并保留两个 legacy 来源。
3. 内容一致但时间冲突，或时间一致但内容不同，进入 `MESSAGE_IDENTITY_CONFLICT`，不得自动覆盖。
4. 缺失 occurred_at 的消息进入隔离；只有非关键展示数据可在批准后使用源 mtime，并显式标记 `time_inferred_from_source`。

### 8.3 lead 与授权

- `phone_hash` 记录原 pepper 版本；未知时标 `legacy_unknown`，不能与新 pepper 的哈希直接比较。
- `customer.mobile` 只是脱敏显示值，不是联系方式。
- `serviceConsent=true` 不能产生有效 service consent；仅形成“历史系统声称授权”的受限迁移事实。
- `marketingConsent=false` 可保存为拒绝/禁止营销线索；`true` 若无证据仍不得营销。
- 线索中的 AI 推断字段保存来源和版本，不覆盖人工确认字段。

### 8.4 operations 枚举

必须由产品负责人批准以下映射表后才能实施，未列值全部隔离：

| JSON | PostgreSQL 建议值 |
| --- | --- |
| handover `pending` | `pending` |
| handover `claimed` 或 `active` | `claimed`，同时保持 `ai_suspended=true` |
| handover `completed` | `completed` |
| priority `urgent` | 100 |
| priority `high` | 80 |
| priority `normal` | 50 |
| task `active` | `in_progress` |

open handover 导入前必须满足每个租户+会话最多一条；冲突不能通过任意选择“最新”解决，须业务负责人确认。

### 8.5 runs

- 有真实导出时，保留 `run_id/request_id`，关联 tenant、conversation、message、release、index binding 和 citations。
- 只有审计摘要而没有响应/引用时，标记 `legacy_partial`，不得补造引用或知识版本。
- 无导出时，报告不可恢复的进程时间范围和重启事实，目标系统从第一条真实持久化 run 开始计数。
- 当前接口不能完整枚举最多 500 条 Map 内容，因此**迁移历史 runs 前必须先实现受控的一次性全量导出，或正式接受“历史不可恢复”差异**。

## 9. Dry-run

Dry-run 必须在预生产的生产同版本 schema 上执行，不写生产表，不调用外部营销/消息接口，也不激活知识 release。

### 9.1 输入固定

1. 获取源快照并锁定每个制品 SHA。
2. 锁定迁移器提交号、转换规则版本、租户映射版本和枚举映射版本。
3. 锁定目标 schema migration 版本。
4. 为 dry-run 创建独立批次和独立数据库/schema，不复用上次残留。

### 9.2 执行顺序

1. 读取与 schema 校验，不做转换。
2. 生成租户/标识/时间/枚举/授权问题清单。
3. 导入 tenant 和批准的基础字典。
4. 导入 lead/客户受限投影与授权线索。
5. 导入 conversation、message 和 session state。
6. 导入 handover、task、human work 和最小事件。
7. 导入知识 package/record/review/release 候选与索引候选。
8. 导入可恢复的 runs；部分记录显式标记。
9. 生成审计和 legacy mapping；不发送真实 Outbox 消息。
10. 执行控制总数、引用、外键、RLS、敏感数据、客户权利和性能校验。

### 9.3 Dry-run 输出

- 源清单与 SHA 文件。
- 每领域输入、成功、去重、隔离、拒绝和目标计数。
- 全部差异及逐条原因，不含敏感正文。
- 租户指派清单和书面批准引用。
- 枚举/时间/授权/重复冲突清单。
- 知识 SHA 与 binding 报告。
- 抽样结果、RLS/加密/撤回/导出/删除测试结果。
- 耗时、峰值数据库连接、锁等待、失败重试和估计冻结窗口。
- `DRY-RUN PASS/FAIL` 结论及各负责人签字。

同一固定输入连续执行两次，目标控制摘要和记录 ID 必须一致；否则迁移器不具备确定性，dry-run 失败。

## 10. 知识 release、记录集合与索引 SHA

### 10.1 需要保存的摘要

每个可激活 release 必须至少绑定：

- `package_manifest_sha256`：知识包 manifest 原始字节或批准的规范化表示。
- `source_knowledge_sha256`：作为索引输入的 knowledge units 制品摘要。
- `approved_record_set_sha256`：三审批准记录清单的规范摘要。
- `index_source_package_sha256`：索引声称的源知识包摘要。
- `index_admitted_record_set_sha256`：索引允许记录集合摘要。
- `index_content_sha256`：不可变索引制品内容摘要。
- `admission_snapshot_sha256`：共享候选索引下，release 白名单快照摘要。

### 10.2 记录集合规范

为避免不同语言/平台生成不同结果，record set 的规范输入固定为：

1. 每条记录使用 `record_id` 和该版本的 `content_sha256`。
2. 两个字段均为 UTF-8、去除首尾空白；SHA 为小写 64 位十六进制。
3. 按 `record_id` 的 UTF-8 字节序升序排序；重复 ID 直接失败。
4. 每行格式为 `record_id<TAB>content_sha256<LF>`，文件无 BOM，最后一行也有 LF。
5. 对完整字节流计算 SHA-256，得到 `approved_record_set_sha256`。

三审签署的是 record list 文件本身的 SHA，不只签署数量或页面截图。

### 10.3 索引内容规范

索引不得对目录 tar 包的非确定性时间戳直接计算摘要。应生成不可变 file manifest：

1. 排除临时文件、日志、锁、`current` 指针和操作系统元数据。
2. 路径统一使用 `/`，相对索引根目录，按 UTF-8 字节序排序。
3. 每行格式为 `relative_path<TAB>size_bytes<TAB>file_sha256<LF>`。
4. 对 manifest 字节计算 SHA-256，得到 `index_content_sha256`。
5. manifest 和索引制品一起写入版本化私有对象存储，禁止覆盖。

### 10.4 激活判定

只有同时满足以下条件才允许在一个事务中激活：

- business、medical、compliance 三类审核均为有效 `approved`，审核人具备当时权限。
- `approved_record_count` 等于规范 record list 的唯一记录数。
- release package SHA 与 index source package SHA 一致。
- 租户专属索引：release record-set SHA 与 index admitted-record-set SHA 完全一致。
- 共享候选索引：release 记录全部属于索引允许集合，且 admission snapshot 已生成并绑定。
- 运行时挂载的索引按 file manifest 重算后等于 `index_content_sha256`。
- GraphRAG 缓存键包含 tenant、release ID、index artifact ID、index content SHA 和 admission snapshot SHA。
- 抽样引用能证明每条 record 在该 release 中被批准。

任何一项不一致：release 保持 `draft/blocked/pending_rebind`，对客服务 fail closed 或转人工；不得退回 preview 模式绕过。

现有 JSON 中的 `active` 必须先迁为 `pending_rebind`。完成重新计算、三审复核和 binding 后创建一个新的生产 release 激活动作，保留旧状态仅作审计。

## 11. 校验与对账

### 11.1 控制总数

每个租户、每个源制品、每个领域分别比较：

- 输入数 = 成功数 + 去重数 + 隔离数 + 经批准拒绝数。
- 目标新增数与 legacy map 唯一数一致。
- 会话数、消息数、用户/AI 方向分布、最早/最晚时间。
- lead 数、缺租户数、身份哈希数、授权状态分布。
- handover/task 状态分布、open 数、紧急数、SLA 时间范围。
- human work 记录数与分钟总和；分钟合计必须精确到两位小数一致。
- release/review/record 数、三审状态、所有 SHA 和 active 数。
- run 状态、agent/model/fallback/guardrail/citation 分布；不可恢复数量单列。

允许差异只包括已签字的去重、隔离、无效授权限制和不可恢复 runs。**未解释差异必须为 0。**

### 11.2 关系与安全校验

- 所有业务行有合法 `tenant_id`，不存在孤儿或跨租户引用。
- 应用账号在 RLS 下无法读取/写入其他租户，连接复用后租户上下文不串用。
- 每条 message 关联有效会话；每条 handover/task/work 关联有效会话和同租户父记录。
- 每条 run 关联消息、release 和引用；legacy partial 例外有明确标记。
- 生产日志和审计 details 不含 C2/C3 正文。
- 数据库、对象存储、备份和传输加密状态符合安全批准。
- 重跑同一批次不产生重复行或重复 Outbox 业务动作。

### 11.3 抽样

按租户和领域分层抽样，至少覆盖：正常会话、留资、重复客户、高风险、人工接管、工时、授权拒绝/撤回、三类知识项目及一条历史 partial run。生产小批量时全量核对。

抽样展示只使用脱敏预览；需要查看原文时执行临时授权并记录审计。

### 11.4 性能与恢复

- 迁移时长低于批准冻结窗口的 70%，保留故障处置余量。
- 导入不造成连接池耗尽、长期锁或线上副本延迟超阈值。
- 从切换前备份恢复到隔离环境，能够再次运行校验。
- 恢复旧备份后能够重放删除台账、授权撤回和 Outbox/inbox 状态。

## 12. 授权撤回、导出与删除

### 12.0 当前实现边界

- 已实现：租户隔离的数据主体请求台账、身份核验状态、敏感字段加密、处理人与复核人职责分离；撤回/限制处理可按明确`purpose`更新授权投影、建立联系抑制、取消批准范围内尚未开始的任务，并写审计和Outbox。开发证据见`tests/postgres-privacy-execution-integration.mjs`。
- 尚未实现：自动生成和交付导出包、物理删除数据库/对象/下游数据、法律保留裁决、供应商删除回执，以及从旧备份恢复后自动重放删除台账。`export`和`delete`当前只生成`manual_pending`计划，**不得写成“已导出”或“已删除”**。
- 正式切流前仍必须按本节完成真实数据、对象存储、供应商和备份范围的端到端演练，并由华美隐私/安全负责人签字。

### 12.1 迁移前的待处理请求

1. 从全部权威来源取得未完成的撤回、导出、删除、限制处理和法律保留清单。
2. 写冻结前先执行已到期请求；无法完成的迁入目标请求台账并保持最高限制。
3. 营销撤回立即生效，不能等迁移完成；服务联系撤回后停止新联系。
4. subject 身份未能可靠关联时进入人工核验，不能误删或继续使用。
5. 删除对象的身份墓碑只在华美批准目的和期限内保留，内容必须不可逆且不能用于营销。

### 12.2 撤回

- grant 和 withdraw 都是不可变事件；当前状态由事件投影计算。
- 撤回后使相关联系渠道、定时任务、队列、缓存和下游营销同步失效。
- 已进入队列但尚未发送的触达必须取消；取消结果写审计。
- 撤回不自动篡改历史审计，但历史正文按保留/删除政策最小化。

### 12.3 导出

1. 验证请求人身份、租户和客户归属。
2. 导出该客户可访问的会话、线索、授权、接管和相关 AI 运行信息，排除他人信息、内部安全规则和秘密。
3. 记录导出范围、查询时间点和内容 SHA。
4. 导出包加密写入私有对象存储，使用一次性短链，默认不超过 7 天（最终以华美批准为准）。
5. 下载/过期/销毁均写审计；不得从 Redis 缓存或供应商日志直接拼装导出。

### 12.4 删除/限制处理

删除计划必须覆盖 PostgreSQL、对象存储、Redis、GraphRAG/搜索派生数据、消息/任务下游、模型供应商可控留存、导出包和备份删除重放台账。

- 删除或不可逆匿名化姓名、联系方式、非必要消息正文、模型正文和个人推断。
- 保留最小不可逆处理证明，不保留被删除的原始值。
- 与公共知识无关的客户内容本来就不得进入 GraphRAG；若发现进入，立即下架相关索引并按安全事件处理。
- 法律保留暂停指定删除，但同时停止营销和非原目的处理；释放后继续删除流程。
- 备份中的删除随轮转传播；每次恢复旧备份先重放删除/撤回台账，再允许业务访问。

切流前必须完成至少一次“授权撤回 → 停止触达”“客户导出 → 加密下载 → 到期销毁”“客户删除 → 缓存/对象/备份重放”的端到端演练。

## 13. 选定切换策略

当前 JSON 存储没有可靠版本号、变更日志和全领域双写，因此一期首次切换采用：

**多次 dry-run + PostgreSQL 影子读取比对 + 短时写冻结 + 最终全量/增量导入 + 一次性切流。**

在实现带事务/Outbox 的双写和修复队列前，不以“临时双写”代替冻结；无校验的双写会制造两个事实源。

### 13.1 切换前 T-7 天至 T-1 天

- 所有 P0 阻断关闭，生产同版本 dry-run 至少连续两次通过。
- 应用已能从 PostgreSQL 读取全部目标领域；在影子模式比较返回摘要，不向客户返回影子结果。
- 完成 20 并发、故障、RLS、备份恢复、客户权利和知识 fail-closed 测试。
- 公布窗口、维护提示、人工承接容量和回退方案。
- 确认队列或维护页不会丢失冻结期新消息；无法保证时不得开始。

### 13.2 T-30 分钟：进入冻结

1. 变更指挥官宣布窗口开始，记录统一时间。
2. 停止会话、留资、接管、知识发布和运维写入；入口进入可恢复排队或维护模式。
3. 暂停后台任务和 Outbox 发布器，但保留监控。
4. 记录当前进程、服务版本和 runs 可恢复范围；执行一次性 runs 导出或签署不可恢复差异。
5. 对全部 JSON 和知识制品生成最终清单、快照与 SHA。
6. 创建 PostgreSQL 备份/PITR 检查点和当前 release 回滚制品。

### 13.3 最终导入与 Go/No-Go

按 tenant → lead/授权 → conversation/message → operations/work → knowledge → runs/audit 的顺序导入。导入期间知识始终不可激活，Outbox 不得向外发送。

Go 条件：

- 所有必需依赖健康，schema 版本准确，迁移批次状态为 `validated`。
- 未解释差异、跨租户引用、SHA 不一致和未处置 P0 隔离均为 0。
- active handover、高风险会话、撤回和法律保留状态逐条通过。
- 新生产知识 release 三审、binding 和运行时索引重算通过。
- QA、数据、DBA、隐私、应用、知识三审和变更指挥官共同签字。

任一条件不满足即 No-Go：保持入口冻结或恢复旧服务，禁止部分租户/部分表擅自切换。

### 13.4 切流

1. 把服务持久化后端设置为 PostgreSQL、共享协调设为 Redis，清除所有生产 JSON store 配置。
2. 知识审批使用 `enforce`；绑定并激活经过三审的新 release。
3. 先启动一个 canary 副本，执行真实依赖 readiness、只读查询和受控合成写入。但AAD v1→v2是明确例外：旧应用不能读v2，必须按`FIELD_ENCRYPTION.md`停AI/停写/原子迁移/整组升级，禁止v1/v2混合canary。
4. 逐步增加副本；每一步确认错误率、延迟、连接池、锁、Outbox 积压和数据一致性。
5. 恢复入口和后台发布器；冻结期消息按原 message ID 幂等回放。
6. JSON 归档改为只读，应用账号无权写入；不得删除源快照。
7. 进入至少 60 分钟强化观察和 7 天迁移观察期。

## 14. 回滚与止损

### 14.1 触发条件

- 数据丢失、跨租户泄露、授权撤回失效或 C2/C3 明文泄露。
- active handover/高风险会话丢失或 AI 在人工接管后继续回复。
- 知识 binding/SHA 不一致、未批准记录参与对客回答。
- 错误率、P95、数据库连接/锁、队列积压超过批准阈值且不能在 15 分钟内恢复。
- 控制总数出现新增的未解释差异。

### 14.2 止损顺序

1. 立即关闭 AI 自动回复，保留人工接管和客户安全提示。
2. 停止入口新写或进入可靠排队；暂停 Outbox 外发。
3. 保全数据库、日志和迁移批次证据，不执行破坏性清理。
4. 知识问题激活上一份**已验证 binding** 的 release；不能只修改 `current.json` 指针。
5. 应用问题回滚到支持同一 PostgreSQL schema 的上一应用版本。
6. 数据问题优先使用修复迁移或 PITR 到隔离库核对，由 DBA 和变更指挥官决定恢复路径。

### 14.3 不允许的回滚

- 一旦接收任何切流后的新生产事实，不得把旧 JSON 恢复为写入主库；否则会丢失新会话、授权撤回和接管状态。
- 不得把 PostgreSQL 全表导回 JSON 再启动旧版本。
- 不得删除审计、迁移批次、隔离和错误证据以“恢复通过”。
- 不得用 preview 知识模式绕过 binding 故障。

如果在开放入口前、尚无任何新生产写入且最终校验失败，可撤销本次切换并恢复冻结前 JSON 服务。此决定必须有数据库无新写证据、指挥官批准和审计记录。

## 15. 审计事件与交付物

### 15.1 最小审计事件

- `migration.inventory_completed`
- `migration.snapshot_created`
- `migration.dry_run_started/completed/failed`
- `migration.tenant_assignment_approved`
- `migration.import_started/completed/failed`
- `migration.record_quarantined/resolved`
- `migration.validation_passed/failed`
- `knowledge.release_rebound/activated/rolled_back`
- `migration.cutover_started/completed/aborted`
- `migration.rollback_started/completed`
- `data_subject.withdrawal_applied`
- `data_subject.export_created/destroyed`
- `data_subject.deletion_completed`
- `migration.temporary_data_destroyed`
- `migration.observation_closed`

审计至少包含 tenant、批次、actor、request/trace、动作、结果、时间、资源 token 和最小化 details；不得包含正文或秘密。

### 15.2 必须归档的交付物

- 批准的迁移方案、窗口和 RACI。
- 源清单、源/归档 SHA、schema/代码版本。
- dry-run 与正式迁移控制总数、差异、隔离及处置报告。
- 租户指派、枚举映射、保留期和不可恢复 runs 的批准。
- RLS、加密、客户权利、知识 SHA、20 并发、故障和恢复测试报告。
- Go/No-Go 签字、切流时间线、监控截图/导出和事件记录。
- 临时数据销毁证明、JSON 只读证明和 7 天观察关闭报告。

## 16. 完成门槛

只有全部满足，迁移批次才能标记 `completed`：

- [ ] 第 4 节全部 P0/P1 阻断已关闭并有证据。
- [ ] 源清单、归档 SHA 与正式批次绑定，原始 JSON 未被改写。
- [ ] 所有目标行可追溯到批次、源 SHA 和 legacy token。
- [ ] 未解释计数差异、跨租户引用、未处置 P0 隔离均为 0。
- [ ] 工时合计、active handover、高风险会话、撤回和法律保留逐条一致。
- [ ] lead 缺租户记录均有书面归属或被明确隔离；没有使用默认租户猜测。
- [ ] legacy consent 没有被错误提升为有效营销/服务授权。
- [ ] agent runs 从切流第一条开始完整持久化；历史不可恢复范围已签字披露。
- [ ] knowledge package、record list、index 与 admission snapshot SHA 全部一致。
- [ ] 生产仅有一个经过三审且 binding 有效的 active release，知识模式为 enforce。
- [ ] 撤回、导出、删除、法律保留和备份删除重放演练通过。
- [ ] RLS、加密、幂等、Outbox、备份恢复和多副本测试通过。
- [ ] 生产 JSON 配置已移除，归档只读，应用无法回写。
- [ ] 切流后 60 分钟强化观察无 P0/P1 事件，7 天内无迁移相关未解释差异。
- [ ] 临时敏感数据已销毁，审计与迁移报告已归档。
- [ ] 项目总负责人、数据、应用、DBA、安全隐私、知识三审、QA 和运维共同签字。

## 17. 迁移执行记录模板

| 项目 | 记录 |
| --- | --- |
| migration_batch_id |  |
| 环境/租户 |  |
| 应用提交号/schema 版本 |  |
| 源清单 SHA/URI |  |
| 冻结开始/结束 |  |
| 导入开始/结束 |  |
| 切流时间 |  |
| 输入/成功/去重/隔离/拒绝 |  |
| 未解释差异 | 必须为 0 |
| active handover/高风险校验 |  |
| 知识 release/binding/index SHA |  |
| runs 可恢复范围/缺口 |  |
| 撤回/导出/删除演练 |  |
| 备份/PITR 检查点 |  |
| 观察窗口结果 |  |
| Go/No-Go 决策 |  |
| 回滚是否发生及原因 |  |
| 临时数据销毁 |  |
| 执行人/复核人/批准人 |  |

最终报告必须把“没有源文件”“源文件为空”“历史不可恢复”“数据被隔离”和“数据成功迁移”作为五种不同结论记录，不能统一写成“0 条”。
