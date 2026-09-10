# 华美一期个人信息权利处理手册

## 支持范围

系统支持访问、导出、更正、删除、限制处理和撤回授权六类请求。客户提交手机号后，系统只生成按租户隔离的 HMAC 主体引用，工单、日志和事件中均不保存明文手机号。

请求默认进入“待身份核验”。任何读取、导出、更正、撤回、限制或删除动作前必须通过华美批准的核验渠道确认本人身份。受控执行采用两步制：`privacy.processor` 实名账号准备范围，另一个 `privacy.approver` 实名账号复核。终态复核人必须同时不同于执行准备人和身份核验人；不能通过换一个prepare人让身份核验人再做终态批准。

## 处理步骤

1. 客户入口或人工客服提交请求，系统返回 `dsr_` 请求编号。
2. 华美批准的核验适配器通过OTP、已验证回拨、已验证渠道或线下证件流程确认本人，签发最长15分钟的attestation。证明必须绑定租户、主体HMAC、`request_id`、`verification_id`和到期时间；处理人不能通过请求体自行声明`verified`。
3. 处理人提交可信attestation后将工单推进为 `in_progress`。系统在同一事务写入防重放账本和加密核验元数据；空证明、未知方法、错租户/主体/请求、过期、篡改或重放一律拒绝。
4. 撤回同意或限制处理必须在原请求的 `scope.purposes` 明确用途，不根据备注或历史行为猜测。处理人调用 `/execution/prepare`，独立复核人调用 `/execution/approve`。
5. 撤回同意会更新对应用途的授权事实、建立抑制，并按已批准映射取消未开始的待办；其中明确撤回全部授权的`withdraw_consent + all`可以自动执行。联系限制只对`service`和`marketing`自动化：`marketing` 只取消明确营销/主动外联，`service` 才可取消未开始的服务回访、预约回电和待接管工单。已被坐席接管的工作和已开始任务不会被强制中止。
6. `restrict + photo/medical_data/privacy/all` 不能用联系抑制冒充“已限制数据处理”。`all`包含当前尚未自动化的数据处理路径，因此不能解释为只限制联系。一期会将这些范围转为`manual_pending`，要求数据类别清单、真实处理路径停用门禁、下游处理者回执、legal hold/保留期复核和独立完成证据。在这些条件齐备前，工单保持`in_progress`，不写联系抑制，也不得标记`fulfilled`。
7. `access`和`correct`进入`fulfilled`或`partially_fulfilled`前，必须由独立执行/交付适配器签发completion attestation，绑定租户、主体、请求类型、目标状态、`evidence_id`和实际`action_reference`。人工填写任意`action_reference`不能将请求标记完成。
8. 导出和删除在本期只会生成 `manual_pending` 计划。导出必须先具备第三方信息排除、加密对象存储、受控交付和到期销毁；删除必须先具备保留期矩阵、legal hold审查、全系统清单、备份重放方案和下游回执。删除清单必须显式覆盖 `contact_vault_entries`、contact KEK版本和恢复后删除清单重放。当前服务不会自动生成导出制品，也不会物理删除任何数据。
9. 复核结果、执行状态和计数证据进入审计和Outbox，不复制手机号、主体HMAC、attestation token、核验说明、客户正文或模型输出。

## 重要边界

- 当前实现不会在收到“删除”二字后自动物理删除，避免冒名请求和误删法定保留记录。
- `contact_suppressions` 是当前用途抑制投影。PostgreSQL 留资授权写入和主动联系任务写入必须经过同一个主体级事务门禁；门禁与隐私审批共用 tenant + subject 锁，避免“审批撤回的同时又新建授权/任务”。已有 active suppression 不能被普通留资再次同意直接覆盖；必须先通过另行批准、审计化的 release suppression 流程。
- 受控联系方式查看也必须在同一主体锁下实时检查当前 service consent 与 `service`/`all` suppression；撤回/限制生效后，即使保险库密文仍因法定保留存在，也不得再显示或用于回访。加密、双角色、浏览器边界和删除步骤见 `CONTACT_VAULT_RUNBOOK.md`。
- 客户当前入站会话的一般回复不走主动联系门禁。客户本轮明确请求人工、`medical_emergency` / `critical_risk_continuity` 紧急安全接管可作为窄范围豁免，任务必须记录 `contact_purpose` / `contact_initiation` / `privacy_gate_exemption`；该豁免不等于后续回访或营销授权。未关联已核验主体的主动任务一律 fail-closed。
- 任何新增的主动发送器、排程器或任务类型都必须在创建及发送前复用 `postgres-contact-suppression-guard.mjs`，并实时查询 suppression；不得只依赖旧缓存或只查 consent。
- 数据权利工单状态、安全事件、法律义务等必要通知使用独立目的 `privacy_rights_status` 或 `legal_obligation`，不得标记为营销，也不受营销/服务联系抑制阻断。该例外只允许必要状态通知，不得夹带推荐或促销内容。
- 华美需书面确定会话、线索、授权、接管、工时、审计、备份和模型供应商侧数据的保留/删除规则。
- 备份中的已删除数据按备份生命周期自然到期；恢复历史备份时必须重新应用恢复点之后的删除清单。
- 模型供应商、日志平台和对象存储若处理个人信息，也必须纳入同一请求范围和处理记录。

## 告警与审计

- 临近 `due_at` 未完成：运营告警；逾期：严重告警并升级合规负责人。
- 同一请求编号对应不同主体或类型：HTTP 409，按安全事件排查。
- 身份未核验或attestation篡改/过期/重放、人工自报完成、单角色尝试完成、跨租户读取：系统拒绝并保留不含敏感正文的安全日志。
- 每月抽样核对工单、执行证据、审计事件、备份删除清单和供应商处理记录。

## 上线前由华美提供/批准

- 在企业身份系统中建立至少两个不同实名账号，分别授予 `privacy.processor` 和 `privacy.approver`；测试、共享或机器账号不得承担复核。
- 为隐私后台注册独立的服务调用方，仅授予 `privacy:read`/`privacy:process`；不与网页公开网关共用secret。
- 业务、合规和运营共同签字确认“用途→任务类型”映射；新增任务类型默认不会被自动取消，必须先审批、开发和补测。
- 明确客户联系、工单状态和法定通知的发送渠道；所有主动联系工作者必须在发送前实时读取 `contact_suppressions` 或消费 `contact.suppressed` Outbox并提供幂等回执。
- 由法务/合规批准保留期矩阵、legal hold流程、删除系统清单和备份重放方案；在此前删除保持 `manual_pending`。
- 提供私有加密对象存储、短期下载、销毁任务和审计回执；在此前导出保持 `manual_pending`。
- 提供可信身份核验适配器（OTP/已验证回拨/已验证渠道/线下证件）和独立执行/交付适配器；两者必须能签发短期、可防重放、按请求绑定的attestation。
- 由Secret Manager/KMS注入互不复用的 `HUAMEI_IDENTITY_PEPPER`、`HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON`、`HUAMEI_CONTACT_VAULT_KEYRING_JSON`、`HUAMEI_PRIVACY_VERIFICATION_SECRET`、`HUAMEI_PRIVACY_CANCELLATION_SECRET` 和 `HUAMEI_PRIVACY_COMPLETION_SECRET`，并按密钥手册演练轮换与备份恢复。联系方式KEK必须属于独立密钥域。取消工单仅接受可信主体撤回适配器签发的短期attestation，普通结构化说明不构成取消依据。
