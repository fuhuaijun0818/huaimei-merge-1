# 生产敏感字段加密与密钥轮换

版本：1.1  
更新日期：2026-08-26

## 1. 生产约束

正式环境必须由 Secret Manager 注入 `HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON`，不得将真实密钥写入代码、镜像、`.env`模板、命令行、工单或日志。密钥环格式为：

```json
{
  "active_key_id": "phase1-v2",
  "keys": {
    "phase1-v1": "<base64-encoded-32-byte-key>",
    "phase1-v2": "<base64-encoded-32-byte-key>"
  }
}
```

每个密钥使用独立的32字节强随机值。`active_key_id` 用于新写入；历史密钥在完成重加密和备份可恢复校验前必须保留。

生产环境缺失密钥环、密钥不是32字节、活动版本不存在、复用密钥材料或读到未加密旧值时，服务均 fail closed。开发环境未配密钥时保留明文兼容，但该模式不能通过生产 readiness。

## 2. 加密边界

统一使用 AES-256-GCM 信封。每次写入使用独立96位 IV，认证附加数据（AAD）至少绑定：

- `tenant_id`：防止密文跨租户复制后被解密。
- `scope`：防止会话正文、线索档案、授权证据等不同用途之间交换。
- `record_id`：防止密文在同租户、同类记录间被替换。复合业务键必须用带类型和字段名的规范JSON表示，不得用冒号等分隔符拼接。
- 数据类型与密钥版本：防止 JSON/text 混用或降级。

任何密文、认证标签、AAD、记录或租户被篡改，解密只返回通用失败码，不在日志中输出密文、密钥或原文。
规范复合ID保留 `channel`、`session_id`、`message_id`、`staff_id`等每个组件的边界；即使外部ID含有冒号，两个不同业务记录也不会产生相同AAD。

## 3. 已接入字段

| 数据域 | 加密内容 | AAD记录绑定 |
| --- | --- | --- |
| 会话 | `conversation_sessions.state` | `channel + session_id` |
| 会话 | `conversation_messages.content` | `channel + session_id + message_id` |
| 会话 | `metadata.session_snapshot` | `channel + session_id + inbound message_id` |
| 线索 | `leads.profile` | 租户域手机 HMAC |
| 未核验候选线索 | `lead_candidates.profile` | `candidate_id` |
| 授权 | `consents.evidence` | 主体HMAC + 授权类型 + 证据SHA-256 |
| 人工接管 | `handovers.snapshot`（含摘要、外部用户、完成说明） | `handover_id` |
| 人工工时 | `human_work.notes` | 会话 + 员工 + 记录时间 |
| 智能体运行 | `agent_runs.response`、`agent_runs.audit` | `run_id` |
| 个人信息权利 | `data_subject_requests.identity_evidence`、`scope`、`result` | `request_id` + 字段用途 |

加密开启时，`leads.display_name`、`primary_interest`和`interests`不再复制姓名或医疗兴趣，完整档案仅在加密 `profile` 中保留。`masked_mobile`仅是不能唯一还原原号的脱敏展示值，不是可解密联系方式，仍按个人信息执行租户隔离、最小权限和保留期。原手机号不落库，只保留租户域 HMAC 作为匹配索引。

Audit 和 Outbox 只保留状态、内部ID、不可逆摘要和处理标志，不复制消息、交接摘要、完成说明、人工备注或模型回复。线索审计中的外部 `session_id` 仅记录 SHA-256 参考值。

DSR的attestation token不落库。`data_subject_requests.identity_evidence`和`result`中只保存加密的最小核验/完成元数据；`privacy_identity_verifications`和`privacy_completion_verifications`是追加式防重放账本，仅保存租户域不可逆主体引用、内部证明ID、方法与时间，不保存手机号、证件、OTP、回拨内容或交付制品。

## 4. 仅更换密钥时的轮换步骤

本节只适用于AAD方案不变、仅更换AES密钥的常规轮换。AAD从分隔符v1升级为命名字段v2时，必须执行第5节的停写整组升级，不得使用本节的混合版本灰度方式。

1. 在 Secret Manager 中新建独立32字节密钥，保留当前旧版本。
2. 将新版本设为 `active_key_id`，先在预生产验证新写入、旧读取、AAD拒绝和篡改拒绝。
3. 灰度发布。此时新数据用新密钥，旧密文仍可由密钥环解密。
4. 使用受控离线批次按 `needsRotation` 扫描和重加密。批次只输出租户、表、计数、密钥版本和错误码，不输出行内容。
5. 对主库、只读副本、最新备份和恢复演练库检查旧 `key_id` 已清零。
6. 经安全负责人和DBA双人复核后，才可在后续发布中移除旧密钥。删除前必须保存符合保留策略的可恢复密钥备份。

## 5. AAD分隔符v1→命名字段v2受控切换

旧应用不识别v2信封，不能读取已重包的数据。因此这不是可向后兼容的普通灰度，必须在一个经批准的停写窗口内完成：

1. 先完成数据库备份和隔离恢复校验，在Secret Manager中同时保留所有实际使用的v1旧key和v2活动key。缺任一旧key时禁止开始apply。
2. 网关切换到`Caddyfile.stop-ai`，停止app、acquisition、conversation-recovery、人工后台及其他可能写入受保护字段的进程。不得只停页面流量而保留后台写入。
3. 由Secret Manager向一次性runner注入`HUAMEI_MIGRATION_DATABASE_URL`和完整keyring，先执行默认dry-run：

   ```bash
   npm run data:field-envelopes:v2:dry-run
   ```

   dry-run逐行使用准确旧`legacyRecordId`认证v1，并使用命名字段AAD认证已有v2。任何明文、未知信封、损坏/篡改v2或缺失旧key都必须fail-closed。
4. DBA和安全复核dry-run只包含表/字段计数和失败码，且写入已经确认停止后，执行：

   ```bash
   npm run data:field-envelopes:v2:apply
   ```

   apply必须以`huamei_migrator`登录并在单一事务中切换`huamei_owner`；它获取全局咨询锁和受保护表写锁。任一行失败时整批回滚，日志不输出行ID、密文或原文。
5. 使用升级后的同一组镜像替换所有读写进程。禁止让v1旧稳定副本与v2 canary共用数据库，也禁止将v2数据库切回只识别v1的旧镜像。
6. 保持网关停AI，运行`release-preflight`。`field_encryption_v2_cutover`会由owner视角盘点全13个字段；只有v1信封总数为0才能返回ready。空的首次上线库自然通过，部分迁移、盘点字段不完整或查询失败都阻断切流。
7. 完成新应用读回、AAD篡改/碰撞反测、备份可恢复和发布预检后，才恢复入口。旧key仍需保留到备份保留策略和恢复演练证明不再需要它。

迁移完整覆盖：会话state、消息content/session snapshot、lead/candidate profile、consent evidence、handover snapshot、human work notes、agent run response/audit、DSR `identity_evidence/scope/result`。

## 6. 其他迁移和校验

`migrate-local-json-to-postgres.mjs --apply` 必须同时满足：

- 显式提供 `--tenant`，一个批次只能写入该租户。
- 使用 `HUAMEI_MIGRATION_DATABASE_URL` 以 `huamei_migrator` 登录，事务内显式切换 `huamei_owner`。
- 密钥环由 Secret Manager 注入；正式环境不允许明文迁移。
- 批次记录保存源文件 SHA-256、控制计数、加密模式及 `current_user/session_user` 权限分离证据，不保存原文。

上线前必须在全新 PostgreSQL 16 库中完成以下检查：

- 应用当前全部迁移后，用 runtime 账号写入会话、线索、授权、交接、工时和智能体运行。
- 直接扫描上述业务表、`audit_events`、`outbox_events`和迁移批次，测试姓名、手机号、兴趣、消息、交接、备注和模型内容均不存在明文。
- 用正确AAD可解密；改租户、用途、记录ID或密文任一项后解密失败。
- 旧密钥写入、新旧密钥环读取、JSON及 text 旧版检测和重加密全部通过。

## 7. 当前边界

本期已加密上述核心售前正文和客户档案，但下列数据面需在实际启用对应功能前完成独立分级与加密评审：

- 知识三审的评论和证据当前按治理记录保存，禁止审批人填入客户信息。
- 未启用的 PostgreSQL `idempotency_records.response_body`。日后接入前必须加密或仅保存不含正文的参考。
- 照片、音视频、医疗文件、对象存储制品、备份/PITR及其密钥恢复流程不在本数据库字段加密实现范围内。

上述边界不得被视为允许存放C3正文；在闭环前应保持功能禁用、限制至最小权限或使用不含客户内容的参考值。
