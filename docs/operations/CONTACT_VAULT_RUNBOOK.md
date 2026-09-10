# 华美一期联系方式保险库运行手册

## 目标与数据边界

联系方式保险库保存客户为本次咨询服务主动提交、格式校验通过并授权回访的手机号。一期默认采用内建 PostgreSQL 保险库；未来可以把 `contact_reference` 指向外部受控系统，但普通线索、客户 profile、接管列表、浏览器存储、应用日志和审计事件均不得出现可逆联系方式。

手机号格式、当前会话和服务联系授权通过后，线索、授权和保险库密文必须在同一个 PostgreSQL 事务内提交，状态记为 `pending_manual`；任一写入失败时，接口不得返回已受理，也不得生成电话回访动作。销售顾问在回电中人工核对号码，院方查重结果不能替代该人工核号。

## 加密与密钥

- `HUAMEI_CONTACT_VAULT_KEYRING_JSON` 必须由 Secret Manager/KMS 注入，不能写入镜像、仓库、Compose 文件或日志。
- 该 keyring 是独立的联系方式 KEK 域，不得与 `HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON` 复用任何 32 字节密钥材料。生产预检会逐个密钥指纹比对并失败关闭。
- 每次写入随机生成一个 256 位数据密钥（DEK）。手机号使用 DEK 进行 AES-256-GCM 加密；DEK 再由当前 contact KEK 使用独立 IV、认证标签和独立 AAD 层进行 AES-256-GCM 包装。
- AAD 绑定租户、`contact_reference`、线索记录 UUID、主体 HMAC、联系方式类型、用途、算法、key id 和加密层。跨租户、跨记录或跨用途搬运密文会认证失败。
- 轮换时先向 keyring 加入新版本并切换 `active_key_id`；旧 key 保留只读解密能力，直到所有旧 envelope 完成受控重包并通过抽样恢复验证。不得在重包完成前删除旧 key。
- 生产 `/ready` 和发布预检必须同时确认独立 keyring 有效、PostgreSQL 表存在且依赖可用。

## 受控查看流程

查看接口只能由用户显式点击触发，不允许列表预加载：

`POST /api/admin/acquisition/handovers/{handoverId}/contact-reveal`

每次点击生成新的 8–128 字符 `Idempotency-Key`。网关保留同源/CSRF边界并原样转发 OIDC Bearer；内部服务调用方必须有 `contact:reveal`。人员令牌必须同时具备 `operations.agent` 和 `contact:reveal`，`tenant_ids` 必须逐项枚举，且令牌 `sub` 必须等于该 `claimed` 接管任务的当前 `assignee`。

服务在持有当前接管任务行锁和主体级隐私锁时，实时检查：联系方式仍为 active、主体绑定一致、当前 service consent 仍有效、`service`/`all` 抑制不存在。通过后才解密，并追加不含手机号和主体 HMAC 的 attempted/success 审计；拒绝和解密失败也写脱敏原因码审计。

成功和失败响应均为 `Cache-Control: no-store`。浏览器客户端不得把返回值写入 localStorage、sessionStorage、IndexedDB、离线缓存、状态持久化或错误遥测；仅可在本次页面内短暂展示或发起 `tel:` 点击拨号，页面切换或任务完结后立即移除。

## 撤回、限制、保留与删除

- `service` 或 `all` 撤回/限制一经两人隐私流程批准，`contact_suppressions` 立即阻断后续查看，即使密文仍处于法务保留期内也不能继续用于回访。
- 一期不擅自设定固定保留天数。上线前由华美法务、合规、业务和信息安全共同签字确认客户联系方式的业务必要期限、起算点、法律保留、投诉/纠纷保全和备份自然到期规则，并形成版本化保留期矩阵。
- 删除请求继续进入 `manual_pending`。执行清单必须明确包含 `contact_vault_entries`、当前及历史 contact KEK 版本、审计最小证据、备份和所有下游处理者；完成 legal hold 复核与独立批准前不得声称已删除。
- 获准执行时应先使记录不可查看并建立删除清单，随后执行经批准的密文删除或密码学擦除；审计只保留请求编号、记录引用、审批人、策略版本、执行时间和结果摘要，不保留手机号、主体 HMAC、密文或密钥。
- 历史备份按批准生命周期自然到期。恢复到删除前时间点时，恢复流程必须重放删除/抑制清单，完成前禁止启动查看接口。

## 运维告警与核对

- `contact_vault` readiness 非 ready：阻断发布并禁止受理新的可回访线索。
- `CONTACT_VAULT_DECRYPTION_FAILED`：按密钥版本、部署版本和数据库恢复时间排查；不得把 envelope 或请求正文复制到工单。
- 同一查看请求重放、非接管人、跨租户、缺少任一角色或已撤回：均视为安全事件信号，按 actor、tenant、handover 和脱敏原因码关联调查。
- 每月抽样核对：留资回执唯一性、待人工核号状态、密文结构、KEK/字段密钥无复用、RLS/ACL、服务授权、抑制实时生效、审计无手机号/HMAC、浏览器无持久化。

## 上线前华美需提供

- 独立的 KMS/Secret Manager contact keyring，并完成生成、双人授权、轮换、吊销和灾备恢复演练。
- 企业 OIDC 中同时授予 `operations.agent` 与 `contact:reveal` 的最小人员组；共享账号、机器人账号和全租户通配符禁止使用。
- 网页网关调用方的独立 `contact:reveal` 服务权限；公共渠道连接器默认不得取得此权限。
- 已批准的联系方式保留期矩阵、legal hold流程、删除清单、备份重放流程、下游处理者清单与月度抽检责任人。
