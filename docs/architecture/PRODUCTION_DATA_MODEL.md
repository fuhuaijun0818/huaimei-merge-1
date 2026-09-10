# 华美一期生产数据模型

版本：1.0  
基线日期：2026-08-26  
适用范围：A-01售前智能体、网页首发渠道、人工接管、知识发布、运行审计及后续渠道适配  
当前状态：目标设计；现有本地JSON仍是迁移源，不是生产事实源

## 1. 目标

本文定义华美一期生产数据的：

- 领域对象与事实来源。
- 租户隔离和敏感级别。
- PostgreSQL、Redis和对象存储的职责。
- 建议保留期与恢复目标。
- Outbox事件和幂等消费。
- 客户导出、删除、授权撤回和法律保留路径。
- 现有JSON字段到新表的迁移映射。
- 知识release、知识包与GraphRAG索引的内容SHA绑定。

该模型优先支持“网页咨询 → 售前对话 → 留资 → 人工接管 → 工时记录 → 质量与业务验收”闭环，并为企业微信、CRM和预约系统保留稳定扩展边界。

## 2. 不可妥协的设计决定

1. PostgreSQL是一期业务事实的主事实源。
2. Redis只保存可重建的短期状态、缓存、幂等、锁和限流；Redis不是业务事实源。
3. 对象存储保存大对象、不可变知识制品、索引、导出包和备份，不直接承担关系型业务查询。
4. 审计事件只追加，不允许原地修改或覆盖；纠错通过追加更正事件完成。
5. 所有租户业务记录必须包含tenant_id，所有唯一键和外键均在租户作用域内约束。
6. 外部调用不得静默使用默认租户；默认租户只用于经批准的历史数据迁移和本地兼容。
7. 联系方式明文如必须保存，应加密并与检索哈希分离；应用列表只展示脱敏值。
8. 同意、撤回、删除和导出均是可审计事实，不以客户表上的一个布尔值代替。
9. 知识release必须绑定知识包SHA、批准记录集合SHA和索引制品SHA，三者不一致时禁止激活。
10. GraphRAG索引是派生制品，不是知识事实源；索引可重建，但不能脱离release被独立用于对客回答。
11. 重要状态变化与Outbox事件必须在同一数据库事务提交。
12. 删除客户数据时，不修改历史审计；保留最小化、不可逆的处理证明并追加删除完成事件。

## 3. 事实、投影与派生数据

### 3.1 事实

事实是已经发生且需要长期追溯的记录，例如：

- 客户授权或撤回授权。
- 收到或发送一条消息。
- 人工接管被创建、认领或完成。
- 人工登记实际付出分钟。
- 某知识版本经三审并被激活。
- 某次智能体运行使用了哪一个模型、规则、知识release和证据。
- 某个客户提出导出或删除请求。

事实写入PostgreSQL；大正文可以加密存放在对象存储，但PostgreSQL仍保存事实元数据、摘要哈希和对象引用。

### 3.2 当前投影

当前投影用于快速展示和决策，例如：

- 会话当前阶段。
- 当前已知项目、关注点、预算和时间偏好。
- 当前打开的人工接管。
- 客户当前负责人和下一最佳动作。
- 当前激活的知识release。

投影写入PostgreSQL并可缓存到Redis。投影必须能够由事实事件重新计算；投影损坏不得造成事实丢失。

### 3.3 派生数据

派生数据包括：

- GraphRAG索引和倒排词项。
- 会话摘要、意图和风险标签。
- 业务指标和聚合报表。
- 模型质量评分和Bad Case标签。
- 搜索缓存、速率桶和短期会话状态。

派生数据必须记录来源版本和生成时间。删除或重建派生数据不应破坏事实。

## 4. 数据敏感级别

本文采用以下工程分级，最终名称和处理规则需与华美数据分类制度对齐。

| 级别 | 定义 | 示例 | 默认存储 | 默认访问 |
| --- | --- | --- | --- | --- |
| C0 公开 | 经批准可对客公开 | 已发布项目通识、公开地址 | PostgreSQL/对象存储/索引 | 对客服务只读 |
| C1 内部 | 经营和技术内部信息 | 模型版本、运行指标、内部配置元数据 | PostgreSQL/监控 | 授权员工 |
| C2 个人信息 | 可关联自然人的一般信息 | 姓名、手机号、渠道账号、城市 | PostgreSQL加密列 | 最小角色，列表脱敏 |
| C3 敏感个人/医疗表达 | 身体情况、咨询正文、影像、风险和投诉 | 对话原文、医疗异常、私密项目诉求 | PostgreSQL加密或私有对象存储 | 严格角色、完整审计 |
| C4 安全秘密 | 可获得系统访问权的秘密 | API Key、数据库密码、KMS密钥 | 专用密钥托管 | 服务身份或安全管理员 |

处理要求：

- C2/C3不得进入普通日志、错误信息、指标标签或Outbox正文。
- C4不得进入数据库业务表、代码、容器镜像、审计正文或导出包。
- C3发送外部模型前必须执行字段白名单、脱敏和数据出域策略。
- 对客知识索引只包含C0及经批准的C1片段，不得包含聊天记录、前后对比、客户明细等受限素材。

## 5. 存储职责

| 存储 | 主要职责 | 不得承担 |
| --- | --- | --- |
| PostgreSQL | 租户、身份映射、授权、会话、消息事实、线索、接管、工时、知识release、运行与审计元数据、Outbox | 大型媒体文件、服务密钥 |
| Redis | 短期会话投影、幂等键、分布式锁、速率限制、熔断、查询缓存 | 唯一业务事实、唯一接管任务、唯一授权记录 |
| 对象存储 | 私有附件、加密导出包、知识包、不可变索引、归档和备份 | 直接作为客户、会话或任务数据库 |
| GraphRAG本地卷/只读挂载 | 当前已批准不可变索引的运行副本 | 独立发布事实、未经release批准的对客知识 |
| 密钥托管 | API Key、数据库凭据、加密密钥、签名密钥 | 普通业务字段和运行日志 |
| 指标/日志平台 | 脱敏技术日志、指标、追踪和告警 | 客户主档、完整对话、授权事实 |

## 6. 租户隔离

### 6.1 租户主键

- tenant.id使用3至64位规范化租户编号，与现有tenant_id规则兼容。
- 除全局只读字典外，所有业务表tenant_id均为NOT NULL。
- 所有自然唯一键均包含tenant_id，例如：
  - tenant_id + channel + external_conversation_id。
  - tenant_id + channel + external_message_id。
  - tenant_id + contact_type + identity_hash + pepper_version。
  - tenant_id + knowledge_release_id。
- 所有子表通过复合外键同时引用tenant_id和父对象ID，防止跨租户错误关联。

### 6.2 PostgreSQL隔离

- 对租户表启用Row Level Security。
- 每个事务显式设置当前tenant_id，并通过策略限制读写。
- 连接池必须在事务结束时清理租户上下文，不能把上一个请求的租户带到下一个请求。
- 生产应用角色不得拥有BYPASSRLS。
- 迁移、备份和安全审计等特权角色必须独立、限时并记录审批。
- 跨租户运营分析使用专用脱敏汇总库或受控ETL，不直接放宽在线库RLS。

### 6.3 Redis隔离

- 所有键以产品环境和tenant_id为命名空间。
- 会话、幂等、限流、缓存和锁的键均包含tenant_id。
- GraphRAG缓存键还必须包含知识release_id和index_artifact_id。
- 禁止把外部conversation_id、手机号哈希或客户ID作为无租户前缀的单独键。
- Redis集群按环境隔离；高敏或大客户场景可按租户使用独立实例。

### 6.4 对象存储隔离

- 对象路径至少包含environment/tenant_id/data_class/object_type。
- 生产、预生产和开发使用不同账号或不同桶，不只依赖前缀。
- 使用私有桶、服务端加密和短期签名URL。
- 知识和导出包记录内容SHA，上传后禁止无痕覆盖同一版本。

### 6.5 身份哈希

- 联系方式去重哈希必须包含tenant_id。
- 保存pepper_version，便于密钥轮换。
- 新旧pepper轮换期可同时计算两个版本，完成迁移后下线旧版本。
- 不得依赖脱敏手机号作为唯一标识。
- 跨租户不得使用同一哈希判断同一客户。

## 7. 领域对象总览

| 领域 | 核心对象 | 事实源 | 敏感级别 | 主存储 |
| --- | --- | --- | --- | --- |
| 租户与权限 | tenant、app_user、role、permission、user_role | 身份与管理系统 | C1/C2 | PostgreSQL |
| 客户身份 | customer、contact_point、channel_identity | 授权留资和渠道映射 | C2 | PostgreSQL加密 |
| 授权 | consent_event、contact_preference | 客户明确动作/正式流程 | C2/C3 | PostgreSQL |
| 会话 | conversation、message、message_delivery | 渠道收发事实 | C2/C3 | PostgreSQL/对象存储 |
| 对话理解 | conversation_state、slot_observation、entity_link | 智能体运行派生 | C1/C3 | PostgreSQL，Redis缓存 |
| 线索与动作 | lead、customer_interest、next_action、journey_enrollment | 客户行为和业务确认 | C2/C3 | PostgreSQL |
| 人工协作 | handover、handover_event、operation_task、human_work_log | 坐席与系统动作 | C1/C3 | PostgreSQL |
| 智能体运行 | agent_run、model_call、citation、guardrail_decision | 每次运行 | C1/C3 | PostgreSQL/对象存储 |
| 知识治理 | knowledge_package、record、review、release、index_artifact、binding | 发布流程 | C0/C1 | PostgreSQL/对象存储 |
| 审计与事件 | audit_event、outbox_event、inbox_receipt | 业务事务 | C1/C3 | PostgreSQL，归档对象存储 |
| 数据权利 | data_subject_request、export_artifact、deletion_action、legal_hold | 客户请求/合规决定 | C2/C3 | PostgreSQL/对象存储 |

## 8. PostgreSQL逻辑模型

以下为逻辑表名和关键字段。物理DDL应在实现阶段补充数据类型、索引、分区、RLS策略和迁移脚本。

### 8.1 租户、账号与权限

#### tenant

- id
- display_name
- status
- deployment_mode
- data_region
- default_timezone
- created_at
- suspended_at

#### app_user

- id
- tenant_id
- external_subject
- display_name
- status
- last_login_at
- created_at

#### role、permission、user_role

- 全部带tenant_id。
- 生产部署、知识审核、医务审核、合规审核、坐席、只读审计和安全管理员职责分离。
- 全局平台运维角色单独建模，不与租户业务角色混用。

### 8.2 客户、联系方式与渠道身份

#### customer

- id
- tenant_id
- origin
- display_name
- gender
- age_band或经批准的age
- city
- owner_team_id
- macro_stage
- micro_stage
- stage_entered_at
- score
- health_score
- status
- created_at
- updated_at
- row_version

说明：

- display_name不作为身份匹配字段。
- 不在主表保存可检索的明文手机号。
- score和health_score属于派生值，必须保存计算版本和更新时间。

#### contact_point

- id
- tenant_id
- customer_id
- type
- encrypted_value
- masked_value
- identity_hash
- pepper_version
- verification_status
- verified_at
- status
- created_at
- revoked_at

说明：

- encrypted_value使用信封加密，解密权限与普通客户查询权限分离。
- identity_hash用于租户内去重。
- 撤回联系不代表自动删除所有历史事实；状态和用途由consent_event控制。

#### channel_identity

- id
- tenant_id
- customer_id
- channel
- external_user_id_hash
- external_user_id_encrypted
- status
- linked_at
- unlinked_at

### 8.3 授权与联系偏好

#### consent_event

- id
- tenant_id
- customer_id
- contact_point_id
- purpose
- decision
- legal_text_version
- channel
- source_message_id
- actor_type
- actor_id
- occurred_at
- evidence_digest
- predecessor_event_id

purpose至少区分：

- consultation_service。
- marketing。
- photo_or_case。
- model_processing或其他经批准目的。

decision至少包含granted、withdrawn、expired、corrected。

授权当前状态由事件投影计算，不允许只在customer上覆盖一个布尔值。

#### contact_preference

- tenant_id
- customer_id
- allowed_channels
- quiet_hours
- do_not_contact
- effective_from
- source_consent_event_id
- updated_at

该表是当前投影，consent_event才是事实。

### 8.4 会话和消息

#### conversation

- id
- tenant_id
- channel
- external_conversation_id
- customer_id
- external_user_identity_id
- status
- current_mode
- owner_team_id
- started_at
- last_message_at
- closed_at
- created_at
- updated_at
- row_version

唯一约束：tenant_id + channel + external_conversation_id。

#### message

- id
- tenant_id
- conversation_id
- channel
- external_message_id
- direction
- sender_type
- sender_id
- content_ciphertext或content_object_id
- content_preview_masked
- content_sha256
- sensitivity_class
- occurred_at
- received_at
- created_at
- deleted_at
- deletion_reason

唯一约束：tenant_id + channel + external_message_id。

要求：

- C3原文使用加密列或私有对象存储。
- 调试界面默认展示脱敏预览。
- AI输出也作为message事实写入，保留关联run_id。
- 删除原文后保留不可逆摘要哈希和最小投递事实，具体以华美批准政策为准。

#### message_delivery

- id
- tenant_id
- message_id
- channel
- delivery_status
- provider_receipt_id
- attempted_at
- delivered_at
- failed_at
- error_code
- retry_count

每次投递状态变化追加记录或使用状态表加不可变delivery_event，不能只在消息上覆盖最终结果。

### 8.5 会话理解与状态

#### conversation_state

- tenant_id
- conversation_id
- dialogue_stage
- last_intent
- active_critical_risk
- summary_ciphertext
- turn_count
- completed_count
- handover_required_count
- blocked_count
- grounded_count
- state_version
- derived_from_message_at
- updated_at

说明：

- 属于可重建投影。
- Redis可缓存相同字段，但PostgreSQL保存最新持久投影。
- counters可以从agent_run重算，不作为独立不可变事实。

#### slot_observation

- id
- tenant_id
- conversation_id
- slot_name
- normalized_value
- display_value_masked
- source_message_id
- source_run_id
- confidence
- status
- observed_at
- supersedes_id

适用于budget、time_preference、style_preference、concern等。修正槽位时新增记录并指向supersedes_id。

#### entity_link

- id
- tenant_id
- conversation_id
- entity_type
- entity_key
- display_name
- source_message_id
- source_run_id
- confidence
- first_seen_at
- last_seen_at
- status

entity_type包括project、doctor、concern、body_part等。

### 8.6 线索、兴趣和下一动作

#### lead

- id
- tenant_id
- customer_id
- source
- status
- interaction_count
- first_conversation_id
- latest_conversation_id
- created_at
- updated_at

#### customer_interest

- id
- tenant_id
- customer_id
- project_key
- score
- trend
- source_run_id
- first_seen_at
- updated_at

#### customer_signal

- id
- tenant_id
- customer_id
- signal_type
- value
- source
- confidence
- observed_at

用于pains、itches、delights和profile字段。AI推断必须标记source=ai_inference和confidence，允许人工更正。

#### next_action

- id
- tenant_id
- customer_id
- conversation_id
- action_type
- title
- reason
- owner_team_id
- channel
- due_at
- status
- guardrail
- source_run_id
- created_at
- completed_at

#### journey_enrollment

- id
- tenant_id
- customer_id
- journey_key
- node_key
- status
- started_at
- stopped_at

一期只保存最小旅程事实，不在售前服务内建设完整旅程平台。

### 8.7 人工接管、任务和工时

#### handover

- id
- tenant_id
- conversation_id
- trigger_message_id
- task_id
- team
- reason
- priority
- current_status
- ai_suspended
- summary_ciphertext
- sla_due_at
- assignee_user_id
- created_at
- claimed_at
- completed_at
- resolution
- row_version

唯一约束：同一tenant_id + conversation_id在open状态下最多一个接管。

#### handover_event

- id
- tenant_id
- handover_id
- event_type
- actor_type
- actor_id
- message_id
- reason_code
- details
- occurred_at

event_type包括requested、claimed、inbound_received、sla_breached、completed、reopened、cancelled。

handover_event只追加；handover是当前投影。

#### operation_task

- id
- tenant_id
- type
- aggregate_type
- aggregate_id
- title
- team
- priority
- status
- due_at
- assignee_user_id
- created_at
- updated_at
- completed_at

#### human_work_log

- id
- tenant_id
- conversation_id
- handover_id
- staff_user_id
- work_type
- minutes
- occurred_at
- created_at
- source
- correction_of_id

工时更正通过新增反向或更正记录，不原地覆盖已验收工时。

### 8.8 智能体运行、模型与引用

#### agent_run

- id
- tenant_id
- request_id
- conversation_id
- message_id
- customer_id
- agent_id
- agent_version
- status
- mode
- channel
- primary_intent
- dialogue_stage
- precheck_decision
- postcheck_decision
- compliance_gate_version
- intent_engine_version
- conversation_style_version
- knowledge_release_id
- knowledge_index_binding_id
- input_preview_masked
- output_preview_masked
- input_digest
- output_digest
- started_at
- completed_at
- created_at

#### model_call

- id
- tenant_id
- agent_run_id
- provider
- model
- request_region
- prompt_template_version
- used
- fallback
- fallback_reason
- prompt_tokens
- completion_tokens
- latency_ms
- provider_request_id
- started_at
- completed_at

完整模型输入输出如确需保留，放入加密对象存储并执行更短保留期；agent_run只保存最小摘要、哈希和对象引用。

#### guardrail_decision

- id
- tenant_id
- agent_run_id
- phase
- rule_id
- category
- decision
- matched_terms_masked
- critical
- occurred_at

#### run_citation

- id
- tenant_id
- agent_run_id
- knowledge_record_id
- knowledge_release_id
- index_artifact_id
- source_relative_path
- excerpt_digest
- rank
- score
- requires_verification

引用必须能证明该record在运行时所属release中被批准。

### 8.9 知识包、审核、release和索引

#### knowledge_package

- id
- tenant_id或global_scope
- package_name
- package_version
- manifest_sha256
- knowledge_units_sha256
- record_count
- source_root_ref
- object_uri
- status
- imported_at
- imported_by

#### knowledge_record

- id
- tenant_id或global_scope
- package_id
- source_record_id
- record_type
- title
- content_object_id或content_ciphertext
- content_sha256
- sensitivity_class
- source_relative_path
- verification_required
- valid_from
- valid_until
- status

#### knowledge_review

- id
- tenant_id
- package_id
- record_id或release_id
- review_type
- decision
- reviewer_user_id
- reviewed_at
- comment_digest
- predecessor_review_id

review_type为business、medical、compliance。

#### knowledge_release

- id
- tenant_id
- release_version
- package_id
- package_manifest_sha256
- source_knowledge_sha256
- approved_record_set_sha256
- approved_record_count
- status
- effective_at
- expires_at
- activated_at
- activated_by
- superseded_by_release_id
- revoked_at
- revoke_reason

#### knowledge_release_record

- tenant_id
- release_id
- knowledge_record_id
- record_content_sha256
- admission_policy_version

approved_record_set_sha256按排序后的knowledge_record_id + record_content_sha256规范串计算，不能只对数量做校验。

#### knowledge_index_artifact

- id
- tenant_id或shared_scope
- index_version
- engine
- engine_version
- source_package_id
- source_package_manifest_sha256
- source_knowledge_sha256
- admitted_record_set_sha256
- index_content_sha256
- manifest_object_uri
- index_object_uri
- document_count
- entity_count
- relationship_count
- built_at
- built_by
- status

#### knowledge_release_index_binding

- id
- tenant_id
- release_id
- index_artifact_id
- release_package_sha256
- release_record_set_sha256
- index_source_package_sha256
- index_admitted_record_set_sha256
- index_content_sha256
- admission_snapshot_sha256
- status
- bound_at
- bound_by
- unbound_at

激活规则：

1. package_manifest_sha256必须与索引的source_package_manifest_sha256相等。
2. release的approved记录必须全部存在于索引允许集合。
3. 如果构建租户专属索引，approved_record_set_sha256必须与admitted_record_set_sha256完全相等。
4. 如果使用共享候选索引，必须生成不可变admission_snapshot，绑定release白名单和共享索引内容SHA。
5. index_content_sha256、release_id和admission_snapshot_sha256同时进入GraphRAG缓存键和agent_run。
6. 任一SHA不一致，release状态只能是draft或blocked，不得active。

当前GraphRAG清单已有source_sha256，但缺少批准记录集合SHA和完整索引内容SHA。现有索引只能迁为candidate artifact，补齐并验证SHA后才能与生产release绑定。

知识release不原地改写。下架、过期、撤销和替换分别追加状态事件，并保留旧release用于审计和回滚。

### 8.10 审计、Outbox与幂等收件箱

#### audit_event

- id
- tenant_id
- event_type
- aggregate_type
- aggregate_id
- actor_type
- actor_id
- request_id
- event_version
- payload_minimized
- payload_digest
- previous_event_digest
- occurred_at
- recorded_at
- retention_class
- legal_hold_id

要求：

- 只允许INSERT。
- 数据库角色禁止UPDATE和DELETE。
- 需要纠错时追加audit.corrected事件并引用原事件。
- 可通过链式摘要、签名、WORM归档或等价机制提供防篡改能力。
- 客户删除后，审计仅保留最小化的不可逆subject_token和处理证明，不保留非必要原文。

#### outbox_event

- id
- tenant_id
- aggregate_type
- aggregate_id
- event_type
- event_version
- payload_minimized
- data_class
- occurred_at
- available_at
- published_at
- publish_attempts
- last_error_code
- trace_id

#### inbox_receipt

- consumer_name
- tenant_id
- outbox_event_id
- processed_at
- result_digest

Outbox和领域事实在同一事务写入。发布器采用至少一次投递，消费者必须用inbox_receipt幂等。

### 8.11 数据导出、删除与法律保留

#### data_subject_request

- id
- tenant_id
- customer_id
- request_type
- status
- requester_identity_verified
- scope
- requested_at
- due_at
- approved_by
- completed_at
- rejection_reason

request_type包括access、export、correction、withdraw_consent、delete、restrict_processing。

#### export_artifact

- id
- tenant_id
- request_id
- object_uri
- content_sha256
- encrypted
- expires_at
- downloaded_at
- destroyed_at

#### deletion_action

- id
- tenant_id
- request_id
- system_name
- data_category
- action
- record_count
- completed_at
- evidence_digest
- retry_status

#### legal_hold

- id
- tenant_id
- customer_id或case_reference
- scope
- reason
- approved_by
- effective_at
- released_at

法律保留会暂停相关删除，但不得继续用于营销或非原目的处理。

## 9. Redis数据模型

建议键空间：

| 用途 | 键组成 | 建议TTL | 持久事实位置 |
| --- | --- | ---: | --- |
| 会话投影 | env:tenant:conversation:state | 30分钟 | PostgreSQL conversation_state |
| 最近轮次缓存 | env:tenant:conversation:recent | 30分钟 | PostgreSQL message |
| 幂等响应 | env:tenant:idempotency:scope:key | 10分钟或接口约定 | PostgreSQL业务事实/审计 |
| 分布式锁 | env:tenant:lock:aggregate:id | 5至30秒 | 无，锁过期可恢复 |
| 限流 | env:tenant:rate:subject:window | 窗口长度 | PostgreSQL不保存每个桶 |
| GraphRAG缓存 | env:tenant:release:index:query_digest | 5分钟 | 知识release和索引制品 |
| 熔断状态 | env:provider:circuit:service | 30秒至5分钟 | 技术指标 |
| 短期任务协调 | env:tenant:job:id | 任务时限 | PostgreSQL任务/独立队列 |

规则：

- Redis清空后，系统可以从PostgreSQL和对象存储恢复核心业务。
- 不允许只在Redis保存授权、接管、工时、知识release、客户、线索或审计。
- Redis故障时应限流、降级或转人工，不得静默放宽医疗和合规门禁。
- 如果选用Redis Streams承载队列，仍需持久Outbox和消费幂等；更推荐独立托管队列。

## 10. 对象存储模型

建议对象类型：

| 对象类型 | 敏感级别 | 是否不可变 | PostgreSQL引用 |
| --- | --- | --- | --- |
| 知识包manifest与knowledge_units | C1/C0 | 是 | knowledge_package |
| GraphRAG索引与manifest | C1 | 是 | knowledge_index_artifact |
| 消息大正文或附件 | C3 | 按保留策略 | message |
| 模型完整输入输出 | C3 | 短期、按批准 | agent_run/model_call |
| 客户数据导出包 | C3 | 是，短期 | export_artifact |
| 审计归档 | C1/C3 | WORM优先 | audit_event批次 |
| 数据库备份 | C2/C3 | 是，按备份周期 | 备份目录/恢复清单 |

对象必须记录content_sha256、加密状态、创建时间、保留策略和删除状态。索引、知识release和导出包不得覆盖原对象；新内容必须生成新版本和新SHA。

## 11. Outbox事件目录

建议一期事件：

### 会话与消息

- conversation.created
- conversation.state_changed
- message.received
- message.reply_generated
- message.delivery_requested
- message.delivered
- message.delivery_failed

### 客户、授权与线索

- customer.created
- customer.updated
- contact_point.verified
- consent.granted
- consent.withdrawn
- contact.suppressed
- lead.created
- lead.updated
- next_action.created
- next_action.completed

### 人工协作

- handover.requested
- handover.claimed
- handover.inbound_received
- handover.sla_breached
- handover.completed
- human_work.recorded
- human_work.corrected

### 智能体与安全

- agent_run.completed
- agent_run.blocked
- agent_run.handover_required
- guardrail.critical_triggered
- model.fallback_used
- bad_case.created

### 知识

- knowledge.package_imported
- knowledge.review_approved
- knowledge.index_built
- knowledge.release_bound
- knowledge.release_activated
- knowledge.release_superseded
- knowledge.release_revoked

### 数据权利

- subject_request.created
- subject_export.completed
- subject_consent.withdrawn
- subject_deletion.started
- subject_deletion.completed
- legal_hold.applied
- legal_hold.released

Payload规则：

- 只传业务接收方需要的最小字段。
- C2/C3正文使用对象ID或记录ID引用，不在事件正文复制。
- 包含schema_version和event_version。
- 包含tenant_id、aggregate_id、occurred_at、trace_id和幂等event_id。
- 外部消费者不得用事件推断未授权的客户身份。

## 12. 保留期建议

以下是工程建议，不构成法律或医疗记录保留结论。华美法务、医务、合规和安全必须在上线前逐项批准或替换。

| 数据类别 | 建议在线保留 | 建议归档/总保留 | 到期动作 | 说明 |
| --- | --- | --- | --- | --- |
| 匿名未留资会话原文 | 180天 | 不额外归档或按批准 | 删除/不可逆脱敏 | 用于质检和Bad Case |
| 已留资售前会话原文 | 180天 | 最长2年，待华美确认 | 删除正文，保留最小摘要 | 不等同病历 |
| 结构化会话摘要/槽位 | 1年 | 最长2年 | 删除或匿名化 | AI推断可由人工更正 |
| 联系方式加密值 | 有效咨询期 | 最后互动后1年建议 | 删除加密值，保留去重墓碑需批准 | 营销撤回应立即停用 |
| 身份去重哈希 | 有效咨询期 | 最后互动后1年或删除后最小墓碑 | 删除或不可逆墓碑 | 需决定是否保留防重复联系 |
| 服务/营销授权事件 | 2年在线 | 5年建议 | 归档最小证据 | 需法务确认 |
| 人工接管、任务和工时 | 2年 | 2年 | 删除或匿名汇总 | 支撑一期收益审计 |
| 智能体运行完整输入输出 | 90天 | 不额外归档，严重事件除外 | 删除正文 | 元数据可保留更久 |
| 智能体运行元数据和引用 | 2年 | 2年 | 删除或聚合 | 不含非必要原文 |
| 普通应用日志 | 30天 | 最长90天 | 删除 | 必须脱敏 |
| 安全与关键审计 | 1年在线 | 5年建议 | WORM归档后到期删除 | 需安全/法务确认 |
| Outbox/Inbox在线记录 | 30天 | 1年最小事件摘要 | 分区删除 | 业务事实保留在领域表 |
| 知识包、review、release和SHA | active期间 | 失效后5年建议 | 归档 | 支撑历史回答追溯 |
| GraphRAG索引 | active及回滚窗口 | 失效后1年建议 | 删除索引，保留manifest/SHA | 可由知识包重建 |
| 客户导出包 | 最多7天 | 无 | 自动销毁 | 单次、加密、短链 |
| 删除请求和处理证明 | 2年在线 | 5年建议 | 保留最小不可逆证明 | 不保留被删除正文 |
| 数据库连续备份 | 35天 | 月度备份12个月建议 | 到期销毁 | 删除在备份到期后传播 |

覆盖规则：

- 法律保留、重大投诉、安全事件或监管要求可延长保留，但须有批准、范围和解除时间。
- 撤回营销授权后立即停止营销，不等待数据保留期结束。
- 数据到期后必须从主库、对象、搜索索引、缓存和可控副本中处理。
- 备份中的删除按备份轮转执行；恢复旧备份后必须重新应用删除台账。

## 13. RPO与RTO建议

以下为一期试点建议目标，最终由华美IT和项目委员会批准。

| 组件/能力 | 建议RPO | 建议RTO | 恢复方式 |
| --- | ---: | ---: | --- |
| PostgreSQL业务事实 | 不高于5分钟 | 不高于30分钟 | 主备/PITR、恢复校验 |
| 审计与Outbox | 不高于5分钟 | 不高于30分钟 | 同PostgreSQL，必要时WORM归档 |
| Redis缓存和短期投影 | 允许丢失缓存 | 不高于10分钟 | 从PostgreSQL重建 |
| Redis幂等/限流 | 尽量不丢，故障时安全降级 | 不高于10分钟 | 高可用切换，必要时收紧流量 |
| 可靠消息队列 | 不高于1分钟 | 不高于15分钟 | 高可用、持久化、Outbox重放 |
| 知识包和索引对象 | 不高于24小时，发布制品应0丢失 | 不高于60分钟 | 对象版本/跨区副本/重新挂载 |
| 应用与智能体服务 | 无业务事实存于本地 | 不高于15分钟 | 多副本、不可变镜像重建 |
| 模型供应商 | 不适用 | 立即降级 | 本地安全答复、替代模型或人工 |
| 整体试点服务 | 不高于5分钟 | 不高于30分钟 | 降级人工、恢复核心服务 |

恢复验收必须核对：

- 租户隔离未被破坏。
- 消息未重复发送。
- 接管和任务未丢失或重复创建。
- 授权与撤回状态正确。
- 知识release和索引SHA绑定仍有效。
- 审计链和Outbox未断裂。

## 14. 授权撤回路径

### 14.1 服务联系授权撤回

1. 验证客户身份和租户。
2. 写入consent_event，decision=withdrawn。
3. 在同一事务更新contact_preference，设置相应用途不可联系。
4. 取消尚未执行的自动联系next_action和operation_task。
5. 写入Outbox事件consent.withdrawn和contact.suppressed。
6. 渠道和下游系统幂等应用停止联系状态。
7. 追加audit_event，记录文本版本、渠道、操作者和时间。

### 14.2 营销授权撤回

- 只停止营销不应阻断客户主动发起的本次服务咨询。
- 所有主动触达在发送前实时读取当前授权，不依赖旧缓存。
- Redis授权缓存必须通过事件立即失效。

### 14.3 图片/案例授权撤回

- 一期默认不把前后对比或客户案例进入通用知识和对客索引。
- 如果后续启用案例授权，撤回时需从展示、搜索、生成上下文和派生制品撤下。
- 历史审计保留最小处理证明，不保留非必要影像副本。

## 15. 客户数据导出路径

1. 创建data_subject_request，类型为export。
2. 通过华美批准的流程验证请求人身份和代理权限。
3. 确定租户、客户和导出范围，排除第三方信息、内部安全规则和他人隐私。
4. 从PostgreSQL读取一致性快照，并查询对象存储引用。
5. 生成结构化清单、会话、授权、线索和处理记录。
6. 对导出包加密，写入私有对象存储，记录content_sha256和最迟7天过期时间。
7. 通过短期受控方式交付，记录下载。
8. 到期自动销毁并追加subject_export.completed或destroyed审计。

导出不得直接复制Redis缓存、模型供应商日志或未验证归属的外部数据。

## 16. 删除与限制处理路径

1. 创建data_subject_request并完成身份核验。
2. 检查法律保留、投诉、安全事件、合同和医务记录边界。
3. 立即限制非必要处理和主动触达。
4. 生成删除计划，覆盖PostgreSQL、对象存储、搜索/GraphRAG、缓存、下游和导出。
5. 删除联系方式加密值和非必要会话正文，或按批准策略不可逆匿名化。
6. 删除/失效Redis缓存和GraphRAG相关派生内容。
7. 向下游发出subject_deletion.started事件并等待幂等回执。
8. 写入deletion_action逐系统记录。
9. 追加subject_deletion.completed审计；审计记录本身不原地修改。
10. 将删除台账加入备份恢复流程，确保恢复旧备份后重新执行删除。

审计保留原则：

- 保留请求ID、租户、时间、处理范围、结果、批准人和不可逆subject_token。
- 不保留已删除的手机号、姓名、完整消息或模型正文。
- 如果需纠正审计信息，追加audit.corrected事件，不更新旧记录。

## 17. 现有JSON到生产表迁移

### 17.1 迁移源

一期相关迁移源：

- .local-data/acquisition-sessions.json。
- .local-data/acquisition-leads.json。
- .local-data/acquisition-operations.json，当前文件可能尚未生成，但字段由现有服务定义。
- .local-data/knowledge-releases.json，当前文件可能尚未生成，但字段由现有服务定义。
- agent-runtime中的进程内runs，只能在进程存活时导出；重启后的历史无法恢复。
- 华美智能体知识库manifest和knowledge_units。
- GraphRAG current.json及每个索引manifest。

医师数字人runtime和媒体不属于A-01一期生产迁移，保持独立工作包。

### 17.2 迁移通用规则

- 迁移前暂停写入或启用明确的双写和最终增量同步。
- 对每个源文件记录文件路径、大小、mtime和SHA-256。
- 原JSON复制到只读迁移归档，不在原文件上改写。
- 每条导入记录保存legacy_source、legacy_id和migration_batch_id。
- 无tenant_id记录不得自动猜测；仅在华美书面确认后映射到指定默认租户。
- 所有时间统一转换为UTC timestamptz，保留原时区信息。
- 所有引用在提交前验证租户一致性。
- 导入后比较记录数、唯一键、状态分布、时间范围和抽样内容SHA。
- 迁移错误进入隔离表，不允许静默丢弃或补造。

### 17.3 acquisition-sessions.json映射

源结构：version + sessions对象。

| JSON字段 | 目标表/字段 | 转换规则 |
| --- | --- | --- |
| sessions的对象键 | conversation.external_conversation_id和migration legacy key | 尝试解析tenant:channel:conversation；无法解析时进入待确认队列 |
| session.id | conversation_state legacy_session_id | 保留原值，不作为跨租户唯一键 |
| createdAt | conversation.started_at、conversation_state创建时间 | 毫秒时间戳转UTC |
| updatedAt | conversation.last_message_at、conversation_state.updated_at | 毫秒时间戳转UTC |
| turns[].role | message.direction、sender_type | user映射inbound/customer；assistant映射outbound/ai |
| turns[].content | message.content_ciphertext、content_sha256、masked preview | 迁移时加密；现有内容已脱敏不代表可公开 |
| turns[].at | message.occurred_at | ISO时间；缺失进入隔离或使用源文件时间并标注 |
| turns[].status | agent_run.status或message metadata | 仅assistant轮存在；无run细节时标legacy_unknown |
| projects[] | entity_link，type=project | 生成legacy entity observation |
| doctors[] | entity_link，type=doctor | 生成legacy entity observation |
| concerns[] | entity_link，type=concern | 生成legacy entity observation |
| knownSlots.budget | slot_observation，slot_name=budget | source=legacy_session |
| knownSlots.time_preference | slot_observation | source=legacy_session |
| knownSlots.style_preference | slot_observation | source=legacy_session |
| lastIntent | conversation_state.last_intent | 作为迁移投影，不作为不可变事实 |
| dialogueStage | conversation_state.dialogue_stage | 作为迁移投影 |
| activeCriticalRisk | conversation_state.active_critical_risk | 同时生成legacy风险审计事件 |
| counters.completed | conversation_state.completed_count | 可导入投影，但需与run数量核对 |
| counters.handover_required | conversation_state.handover_required_count | 可导入投影 |
| counters.blocked | conversation_state.blocked_count | 可导入投影 |
| counters.grounded | conversation_state.grounded_count | 可导入投影 |

现有session键通常由tenant_id + channel + external conversation拼接。迁移器必须使用同一规范解析，并验证键中的tenant与目标tenant相同。

### 17.4 acquisition-leads.json映射

源结构：version + leads数组。

当前实际样本中可能缺少tenant_id。这类记录只能在以下条件下迁移：

1. 华美确认该文件只属于一个指定租户。
2. 迁移批次显式配置target_tenant_id。
3. 生成tenant_assignment审计。
4. 迁移后通过租户隔离抽查。

| JSON字段 | 目标表/字段 | 转换规则 |
| --- | --- | --- |
| lead.tenant_id | 各目标表tenant_id | 缺失时不得自动使用环境默认值 |
| phone_hash | contact_point.identity_hash | 记录原pepper版本；当前默认pepper若不安全需重新获取联系方式后轮换 |
| created_at | lead.created_at、customer.created_at | ISO转UTC |
| updated_at | lead.updated_at、customer.updated_at | ISO转UTC |
| interactions | lead.interaction_count | 数值校验 |
| customer.id | customer.id或legacy_customer_id | 保留稳定ID并加租户复合唯一 |
| customer.origin | customer.origin | 枚举映射 |
| customer.name | customer.display_name | C2，按权限展示 |
| customer.age | customer.age或age_band | 空值保留，不推断 |
| customer.gender | customer.gender | 待补充映射null或unknown |
| customer.mobile | contact_point.masked_value | 仅脱敏值，不能反推出明文或视为已验证联系方式 |
| customer.city | customer.city | 待补充映射null或unknown |
| source/firstChannel/latestChannel | lead.source、conversation.channel metadata | 标准化渠道字典 |
| owner | customer.owner_team_id | 映射组织表，找不到进入待分配 |
| agent | lead source metadata | 映射agent_id |
| macroStage/microStage | customer阶段投影 | 保存原值和标准化值 |
| stageEnteredAt | customer.stage_entered_at | ISO转UTC |
| sla | 不直接迁为事实 | 解析后生成next_action/task或标为legacy display |
| score/health | customer.score/health_score | 标记算法版本legacy_v1 |
| photo/photoConsent/photoUpdatedAt | 独立media/consent对象 | 当前null或未上传不创建媒体 |
| tags[] | customer_tag | 标准化并去重 |
| interests[] | customer_interest | name、score、trend拆列 |
| pains/itches/delights | customer_signal | signal_type分别保存，source=legacy_ai_inference |
| profile.budget | slot_observation | source=legacy_profile |
| profile.decision | customer_signal | 非结构化值，需后续字典化 |
| profile.contact | contact_preference备注或customer_signal | 不能据此证明合法授权 |
| profile.style | slot_observation | source=legacy_profile |
| profile.concern | customer_signal/slot_observation | source=legacy_profile |
| profile.confidence | customer_signal.confidence | 数值校验 |
| nextAction.* | next_action | dueAt转UTC；owner映射组织 |
| journeys[] | journey_enrollment | id/name/node/status映射 |
| serviceConsent | consent_event候选 | 只标legacy_asserted；无文本版本和时间时不能直接视为生产有效授权 |
| marketingConsent | consent_event候选 | false可迁为拒绝；true如无证据必须重新获取授权 |
| timeline[] | legacy_timeline_event或audit_event候选 | 不把AI生成描述当正式审计，保留来源标识 |
| conversations[].id | conversation.legacy/external id | 关联customer |
| conversations[].channel | conversation.channel | 标准化 |
| conversations[].status/mode | conversation当前投影 | 映射枚举 |
| conversations[].messages[] | message | from、text、at分别映射 |
| task.* | operation_task | dueAt转UTC，assignee映射组织/用户 |

重要限制：

- 现有文件不保存明文手机号，只保存HMAC和脱敏显示值。迁移后不能据此执行电话联系；如生产需要联系，必须通过已授权渠道重新获取或从权威CRM同步加密联系方式。
- serviceConsent布尔值缺少授权文本版本、明确发生时间和证据摘要时，只能作为迁移线索，不能独立通过授权验收。

### 17.5 acquisition-operations.json映射

源结构：version、handovers、tasks、events、human_work_logs。

#### handovers

| JSON字段 | 目标字段 |
| --- | --- |
| id | handover.id |
| task_id | handover.task_id |
| tenant_id | handover.tenant_id |
| channel + conversation_id | 解析并关联conversation |
| external_user_id | channel_identity，必须加密/哈希 |
| customer_id | handover.customer_id |
| trigger_message_id | handover.trigger_message_id |
| team | handover.team |
| reason | handover.reason |
| priority | handover.priority |
| status | handover.current_status |
| ai_suspended | handover.ai_suspended |
| summary | handover.summary_ciphertext |
| known_slots | slot_observation或handover快照JSON |
| projects | handover快照/实体链接 |
| created_at | handover.created_at |
| sla_due_at | handover.sla_due_at |
| claimed_at | handover.claimed_at |
| completed_at | handover.completed_at |
| assignee | app_user/团队映射 |
| completed_by | app_user/actor映射 |
| resolution | handover.resolution |
| updated_at | handover.updated_at |

#### tasks

id、tenant_id、type、handover_id、title、team、priority、status、due_at、created_at、updated_at和assignee映射到operation_task。

#### events

每条events记录迁为handover_event或audit_event。现有events只保留最近5,000条，不能视为完整历史；迁移报告必须披露截断风险。

#### human_work_logs

id、tenant_id、conversation_id、handover_id、staff_id、work_type、minutes、occurred_at、created_at映射到human_work_log。minutes需校验大于0且不高于1,440。

### 17.6 knowledge-releases.json映射

源结构：version、releases、audit_events。

| JSON字段 | 目标表/字段 | 转换规则 |
| --- | --- | --- |
| release.id | knowledge_release legacy id | 保留原ID |
| tenant_id | knowledge_release.tenant_id | 必填 |
| package_version | knowledge_package.package_version | 必须找到并校验实际包 |
| approved_record_ids[] | knowledge_release_record | 每条需验证存在和内容SHA |
| approved_record_count | 派生计数 | 与明细重算一致 |
| reviews.business/medical/compliance | knowledge_review | reviewer、decision、reviewed_at拆行 |
| status | knowledge_release.status候选 | 原active迁为pending_rebind，不能直接active |
| effective_at/expires_at | knowledge_release | 转UTC |
| activated_at/activated_by | knowledge_release | 保留迁移来源 |
| superseded_at | release状态事件 | 追加superseded事件 |
| audit_events[] | audit_event | 标记legacy source |

现有release缺少package_manifest_sha256、source_knowledge_sha256、approved_record_set_sha256和index_content_sha256。因此：

- 所有迁移release初始状态必须为pending_rebind。
- 重新计算知识包、记录集合和索引SHA。
- 重新验证业务、医务、合规审核人与权限。
- 创建knowledge_release_index_binding。
- 通过事务激活新release后，旧JSON状态只作为历史参考。

### 17.7 agent-runtime进程内runs映射

现有runs只保存在进程内Map，最多500条，服务重启后丢失。

如果迁移时能从运行中的服务安全导出：

| 当前字段 | 目标字段 |
| --- | --- |
| run_id、request_id | agent_run.id、request_id |
| created_at | agent_run.created_at |
| agent_id、agent_version | agent_run |
| tenant_id | agent_run.tenant_id |
| customer_id | agent_run.customer_id |
| channel、mode | agent_run |
| input_preview | agent_run.input_preview_masked |
| status、decision | agent_run.status、precheck_decision |
| matched_rule_ids | guardrail_decision |
| caller | agent_run metadata |
| provider、model、llm_used | model_call |
| response.output.citations | run_citation |
| response.guardrails | agent_run/guardrail_decision |
| response.usage | model_call使用量 |

如果没有导出文件，不得伪造历史run。迁移报告记录“不可恢复的进程内历史范围”，新系统启用后从第一条真实运行开始持久化。

### 17.8 知识包与GraphRAG索引迁移

1. 计算知识包manifest文件SHA和knowledge_units文件SHA。
2. 导入knowledge_package和knowledge_record元数据。
3. 校验record_count、record_id唯一性、source_relative_path和敏感级别。
4. 导入现有GraphRAG manifest为candidate knowledge_index_artifact。
5. 校验现有source_sha256是否等于实际knowledge_units文件SHA。
6. 为批准记录集合计算规范SHA。
7. 对索引目录或制品包计算index_content_sha256。
8. 创建release-index binding。
9. 在enforce模式下执行抽样和全量准入验证。
10. 激活release并将current指针更新视为部署动作，而非事实源变更。

## 18. 迁移执行顺序

### Phase 0：盘点和冻结

- 记录所有源文件和SHA。
- 确认租户映射、数据敏感级别和迁移范围。
- 备份现有JSON和知识索引。
- 确认停写窗口或双写方案。

### Phase 1：基础字典

- tenant、组织、用户、角色、项目、医生和渠道字典。
- 建立默认租户映射审批记录。

### Phase 2：客户和授权

- 导入customer、contact_point、channel_identity和lead。
- 对缺少授权证据的数据标legacy_asserted，禁止主动触达。

### Phase 3：会话和消息

- 导入conversation、message、state、slot和entity。
- 按租户和渠道检查唯一性。

### Phase 4：人工协作

- 导入handover、event、task和human_work。
- 检查open handover唯一约束和SLA时间。

### Phase 5：知识

- 导入package、record、review、release和index artifact。
- 重新计算SHA并完成binding。

### Phase 6：运行和审计

- 导入可获取的run。
- 创建迁移audit_event和Outbox初始事件。

### Phase 7：校验

- 记录数、状态、总工时、会话轮数、知识记录数和SHA一致。
- 抽样核对客户、会话、接管和知识引用。
- 执行跨租户访问、重复消息、幂等和删除路径测试。

### Phase 8：切换

- 完成最终增量同步。
- 将生产读写切换PostgreSQL。
- 禁止JSON继续作为写入源。
- 保留只读迁移归档和回滚窗口。
- 回滚不得把新产生的生产事实覆盖回旧JSON。

## 19. 迁移验收

迁移必须满足：

- 所有导入行可追溯到source SHA和migration_batch。
- 无未解释的tenant_id缺失。
- 无跨租户外键或缓存键。
- 会话、消息、线索、接管和工时记录数差异有明细解释。
- 工时合计与源文件一致。
- active接管、授权撤回和高风险状态未丢失。
- 知识release与索引SHA绑定通过。
- 所有生产active release来自新系统重新激活。
- 旧JSON已转只读，不再接受生产写入。
- 备份恢复后可重新执行删除台账和Outbox。

## 20. 需华美确认的数据保留决策

以下决策在W2前至少确认原则，在生产影子模式前完成书面批准：

1. 匿名未留资会话原文保留180天是否可接受。
2. 已留资售前会话原文保留180天、最多归档2年是否可接受。
3. 联系方式在最后互动后保留多久；撤回服务联系后是立即删除还是仅停止使用。
4. 为防重复联系或重复建档，删除后是否允许保留不可逆身份墓碑及保存多久。
5. 服务授权、营销授权和撤回证据需要保留2年还是5年。
6. AI完整输入输出是否允许保留90天；哪些高风险场景可以延长。
7. 人工接管、任务和工时记录需要保留多久以支持一期收益和劳动管理。
8. 普通日志、安全审计和关键业务审计的在线及归档期限。
9. 知识包、审核、release、索引manifest和历史回答证据需要保留多久。
10. 客户导出包自动销毁期限是否采用7天。
11. 数据库备份采用35天连续备份和12个月月度备份是否符合制度。
12. 恢复旧备份后重新执行客户删除台账的责任人和时限。
13. 投诉、法律争议、安全事件和医务事件的legal hold触发人、范围和解除流程。
14. 外部模型供应商对输入输出的实际保留期，目标是否要求零保留或不高于30天。
15. 会话中涉及医疗表达的内容是否按一般售前记录管理，哪些情况必须进入华美现有医疗记录体系。
16. 客户撤回营销授权后，历史营销分析数据是否允许保留不可逆聚合。
17. 合同终止、SaaS转买断或买断退出时，数据导出、迁移、验证和销毁时限。

在这些决策完成前，本文保留期只能用于容量估算，不能直接作为生产数据策略。

## 21. 实施时需要补充的工程制品

- PostgreSQL物理ERD和DDL。
- RLS策略与跨租户自动化测试。
- 数据库迁移、回退和索引脚本。
- JSON迁移器、隔离表和对账报告。
- 知识record集合SHA规范及验证工具。
- 索引目录规范打包和index_content_sha256工具。
- Outbox发布器和Inbox幂等消费者。
- 数据导出、删除、撤回和legal hold API。
- 保留期分区清理、对象生命周期和备份删除作业。
- 数据字典、字段级敏感分类和模型出域白名单。
- 备份恢复、删除重放和release-index恢复演练。

