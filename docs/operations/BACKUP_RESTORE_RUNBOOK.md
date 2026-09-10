# 华美一期备份与恢复演练手册

## 目标与上线门禁

备份存在不等于可恢复。上线前必须在与生产隔离的恢复环境完成一次全量恢复，保存恢复时长、校验报告和责任人签字；之后至少每季度演练一次，并在重大数据库变更后补做。

华美与部署方需共同确认最终 RPO、RTO、保留周期和法定保全规则。当前工程建议值是：数据库 RPO 不超过 15 分钟、核心服务 RTO 不超过 2 小时；这只是实施基线，不替代华美书面决策。

## 备份范围

- PostgreSQL：连续日志/PITR、每日全量快照、发布前逻辑备份。
- GraphRAG：正式索引目录、`manifest.json`、三审回执和知识包，全部按不可变版本保存。
- 对象与交付制品：容器镜像、部署配置模板、告警规则、评测报告和发布证据。
- Redis：只承载可重建的限流、幂等短状态和缓存；启用 AOF 以缩短故障窗口，但不把 Redis 当唯一业务事实来源。
- 密钥不进入普通备份；由 KMS/密钥管理系统独立托管和恢复。

所有备份必须加密、版本化、访问受控，并存放在与生产故障域隔离的位置。生产数据库账号、应用运行账号和备份账号必须分离。

## 自动备份策略

优先使用云数据库或企业数据库平台的持续日志与时间点恢复。若使用自建 PostgreSQL，必须由运维平台配置 WAL 归档、每日基准备份、加密上传、校验和与生命周期策略；禁止只复制正在运行的数据目录。

每次备份作业至少记录：

- 备份 ID、数据库实例和起止时间；
- PostgreSQL 版本、应用版本和最新迁移名；
- 加密密钥版本、对象版本 ID、大小和 SHA-256；
- 成功/失败、重试、保留到期时间和告警状态。

备份日志不得包含连接串、手机号、会话正文或模型密钥。

### 签名备份manifest

每个准备用于恢复或演练的PostgreSQL备份必须同时生成外置`huamei.postgres-backup-manifest.v1`。manifest与备份对象使用相同不可变backup ID，至少包含：

- `backup_id`、源数据库实例ID、备份开始/完成时间和可恢复`restore_point`；
- 备份对象version ID、对象字节SHA-256和大小；
- `tenants`、会话/消息、线索/授权、加密联系方式保险库、接管/任务/工时、知识release/review、审计/Outbox/幂等、隐私请求与回执等全部关键表的事务一致count；
- 全部active知识release的租户、release/index、package/record-list/index checksum；
- 每个active租户在恢复点前的审计锚点`tenant_id + event_id + occurred_at`。

manifest必须由独立备份操作人以Ed25519签名。公钥通过外置`HUAMEI_RESTORE_BACKUP_TRUSTED_SIGNERS_B64`注册表提供，角色固定为`backup_operator`、`allowed_kinds=["postgres_backup_manifest"]`。私钥只在备份runner/KMS短时挂载，不进入数据库、备份对象、通用部署`.env`或恢复库。最小签名流程：

```bash
export HUAMEI_BACKUP_MANIFEST_SIGNER_ID=<backup-operator-id>
export HUAMEI_BACKUP_MANIFEST_SIGNING_KEY_PATH=/run/backup-keys/backup-manifest-ed25519.pem

npm run backup:manifest:sign -- \
  --input=/absolute/backup/backup-manifest.unsigned.json \
  --input-sha256=<unsigned-manifest-sha256> \
  --output=/absolute/backup/backup-manifest.json
```

签名后重新计算文件SHA并与backup ID、对象version ID一起写入受控恢复工单。没有签名manifest、只有作业“成功”日志或只有空库schema，均不能证明备份可恢复。

### 将manifest绑定到实际备份对象

恢复校验必须且只能选择一种对象证明方式，不能只相信恢复操作人在环境变量里填写的checksum：

- `local_file`：将本次实际恢复使用的不可变备份文件只读挂载给校验器。校验器以`O_NOFOLLOW`打开普通文件，流式计算SHA-256和大小，并在哈希前后核对文件身份，结果必须与manifest完全一致。
- `signed_storage_attestation`：备份位于对象存储、无法挂载时，由独立存储校验runner读取对象version和provider checksum，生成`huamei.backup-storage-artifact-attestation.v1`并以Ed25519签名。其注册角色必须为`backup_storage_verifier`、`allowed_kinds=["backup_storage_artifact"]`，且签名人ID和公钥指纹均不得与manifest的`backup_operator`相同。attestation中的backup ID、object version、SHA-256和大小必须与manifest完全一致。

存储证明的私钥及可信公钥注册表必须由独立运维/安全域管理，不能由恢复操作人临时自报，attestation文件内自带的公钥也不可信。两种模式缺失、混用、路径不是绝对路径、文件为符号链接、内容在哈希时变化、对象version或签名不匹配，都会在首次查询恢复数据库前失败关闭。

## 隔离恢复演练

1. 新建独立网络、独立数据库名和临时恢复账号，不得覆盖生产或预生产实例。
2. 从指定备份或时间点恢复 PostgreSQL；恢复 GraphRAG 和知识制品时保持原版本路径，不得改写 `manifest.json`。
3. 禁止在校验前启动对客服务，先确认 PostgreSQL 版本和三个数据库角色存在。
4. 在受控恢复工单中确定预期backup ID、要求恢复到的时间点和批准的最大RPO。以`huamei_migrator`连接恢复库，挂载签名manifest并执行只读校验：

   ```bash
   HUAMEI_RESTORE_DATABASE_URL='postgresql://huamei_migrator:<secret>@<restore-host>/<restore-db>' \
   HUAMEI_RESTORE_EXPECTED_DATABASE='<restore-db>' \
   HUAMEI_RESTORE_DRILL_CONFIRM_ISOLATED=true \
   HUAMEI_RESTORE_BACKUP_MANIFEST_PATH='/controlled/backup-manifest.json' \
   HUAMEI_RESTORE_BACKUP_MANIFEST_SHA256='<signed-manifest-sha256>' \
   HUAMEI_RESTORE_BACKUP_TRUSTED_SIGNERS_B64='<external-public-key-registry-base64>' \
   HUAMEI_RESTORE_ARTIFACT_VERIFICATION_MODE='local_file' \
   HUAMEI_RESTORE_BACKUP_ARTIFACT_PATH='/controlled/postgres-backup.dump.enc' \
   HUAMEI_RESTORE_EXPECTED_BACKUP_ID='<approved-backup-id>' \
   HUAMEI_RESTORE_REQUIRED_POINT_IN_TIME='<approved-ISO-8601-point>' \
   HUAMEI_RESTORE_MAX_RPO_SECONDS='900' \
   node scripts/verify-restored-database.mjs
   ```

   若使用对象存储证明，将上面的`local_file`两项替换为：

   ```bash
   HUAMEI_RESTORE_ARTIFACT_VERIFICATION_MODE='signed_storage_attestation' \
   HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_PATH='/controlled/storage-attestation.json' \
   HUAMEI_RESTORE_BACKUP_ARTIFACT_ATTESTATION_SHA256='<attestation-file-sha256>' \
   HUAMEI_RESTORE_BACKUP_ARTIFACT_TRUSTED_SIGNERS_B64='<independent-storage-verifier-registry-base64>'
   ```

5. 校验器会在查询恢复库前先校验manifest绝对路径、外部文件SHA、Ed25519签名、backup ID、RPO以及实际备份文件/独立对象存储证明；然后逐表精确比对manifest count、active release和审计锚点。恢复库少一行、多一行、关键表为空、active release/审计锚点缺失或恢复点超过批准RPO都失败关闭。
6. 数据内容门禁通过后，还必须通过：迁移及校验和一致、全部租户表开启FORCE RLS、审计防修改触发器存在、关键外键无孤儿、活动知识版本绑定完整。输出`huamei.restore-verification.v2`，保存其中的manifest SHA、签名人SPKI指纹、实测RPO和验证SHA。
7. 使用运行账号执行RLS、知识三审、会话幂等、Outbox、个人信息权利和领域集成测试。
8. 用只读挂载恢复对应GraphRAG制品，校验manifest SHA、release ID、三审回执和approved record list SHA。
9. 记录恢复耗时、数据时间点、验证SHA、未恢复项目和最终RPO/RTO；演练环境验证后按受控流程销毁。

## 判定和处置

- 外置签名manifest缺失/验签失败、backup ID错配、关键表count不一致、空恢复、active release或审计锚点缺失、RPO超标：恢复失败，禁止上线。
- 任一迁移校验和不一致、FORCE RLS缺失、跨租户可见、活动知识绑定缺失或审计保护失效：恢复失败，禁止上线。
- 实际恢复时间超过批准 RTO：增加自动化、提高备份频率或调整容量后重演。
- 备份对象损坏或密钥不可用：按 P0 事件升级，暂停发布并验证上一可用恢复点。
- 恢复成功也不得直接接入真实客户；仍需生产配置预检、烟测和发布审批。

`tests/backup-manifest-restore.mjs`仅证明上述签名、对象绑定、RPO和逐项比对逻辑在本地会失败关闭，不是生产备份、隔离恢复或RPO/RTO达标证据。当前对象绑定证明“指定备份对象真实存在且未被替换”；正式上线还应由受控恢复runner记录实际`pg_restore`或云恢复API使用的object version，防止恢复操作者绕开该对象。正式上线仍须保存真实对象version、恢复执行回执、真实恢复库报告和DBA/安全/业务签字。
