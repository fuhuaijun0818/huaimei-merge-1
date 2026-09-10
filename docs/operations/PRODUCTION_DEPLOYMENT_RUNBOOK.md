# 华美一期服务器安装、升级、灰度、回滚与停 AI Runbook

版本：1.2
更新日期：2026-08-26
适用：华美一期预生产、生产试点、买断部署

## 1. 上线不可破坏的条件

任何发布只有同时满足以下条件，才能对客切流：

1. 所有应用、GraphRAG、PostgreSQL、Redis 和 Caddy 镜像都使用 `@sha256:<digest>`，禁止 `latest` 或可变 tag。
2. 镜像内的全部 SQL 迁移与 `schema_migrations` 的名称、数量和 SHA-256 完全一致。
3. 应用数据库连接用户必须是 `huamei_runtime`，不得是 owner、migrator 或超级用户。
4. 全部租户表开启 `ENABLE RLS + FORCE RLS`，运行账号没有 `BYPASSRLS`、建表权、数据库创建权或表 owner 身份。
5. 每个对客租户恰好有一个生效中的正式知识 release，业务、医务、合规三审人不同且回执有效。
6. GraphRAG `/ready` 返回的 tenant、release ID、index version 和 manifest SHA 与数据库 active release 完全一致。
7. PostgreSQL、Redis、GraphRAG、售前智能体和 Web/API 全部 ready。
8. `LITELLM_LOCAL_MODEL_COST_MAP=True`，禁止 LiteLLM 启动时隐式下载成本表；真实模型访问只能通过已批准的 `GRAPHRAG_API_BASE`/模型网关出网。
9. 对客服务必须启用真实 LLM，并通过 HTTPS 访问已批准出网主机；LLM 和 GraphRAG 模型密钥必须独立且不是示例值。
10. 通用字段加密 keyring 有效，app 和 acquisition `/ready` 均确认真实 LLM 与字段加密已就绪；发布预检的`field_encryption_v2_cutover`还必须确认全库v1信封总数为0。
11. 001–011迁移完整；联系方式保险箱使用与通用字段密钥材料完全不同的独立AES-256-GCM keyring，`contact_vault_entries`已启用FORCE RLS，app/acquisition就绪检查与发布预检均确认保险箱可用。
12. 生产管理端运行配置必须为`delivery_mode=handover_only`且`demo_mutations_enabled=false`。页面只展示真实接管工作台；认领、显式查看联系方式、完成和工时写入均可与数据库及审计对账。
13. GraphRAG `/metrics` 使用与服务调用密钥不同的独立token；Prometheus服务发现包含每个稳定副本，启用canary时也包含全部灰度副本，正式查询按实例汇总。
14. 完整镜像在预生产完成启用真实 LLM 的正式评测与 20 人/30 分钟容量验收，GraphRAG只接收安全业务分类词，报告使用净化查询SHA和跨副本监控原始导出；契约见 [RELEASE_EVIDENCE_SCHEMA.md](./RELEASE_EVIDENCE_SCHEMA.md)。
15. 生产发布预检返回 `status=ready` 且退出码为 0。

不得通过改数据库 release 状态、关闭 RLS、复用密钥、切回 preview 知识、启用演示管理操作、漏采GraphRAG副本或跳过预检来解决上线阻塞。

## 2. 部署角色与职责

| 角色 | 最小职责 |
| --- | --- |
| 发布负责人 | 确认发布号、镜像 digest、变更窗口、预检和切流 |
| 数据库负责人 | 备份、迁移、锁和容量风险、恢复决策 |
| 知识发布人 | 三审回执、release 激活、GraphRAG manifest 绑定 |
| 值班人 | 灰度观察、告警、停 AI 和回滚操作 |
| 安全/合规 | 密钥、出网、数据使用和上线批准 |
| 7类正式证据签名人 | 分别承担盲测保管、评测执行、评分评审、评测报告签发、压测执行、SRE证明、容量报告签发；`signer_id`和SPKI公钥指纹均互异 |

发布人不得同时代替三个知识审核角色。

## 3. 服务器和目录准备

生产至少需要：

- 64 位 Linux、Docker Engine 和 Docker Compose v2。
- 私有镜像仓库，支持 digest 拉取和镜像保留。
- 只向网关暴露 443；4173、4180、4191、5432、6379 只在内网。
- 模型/OIDC/已批准外部事件端点的显式出网白名单。Compose 的 `approved-egress` 网络不代替主机防火墙或出网代理。
- `/opt/huamei/deploy` 仅对发布组可写，`.env` 权限为 `0600`。
- 时钟同步、磁盘容量告警和宿主机安全基线已开启。

将以下文件放入部署目录，并保留原版本：

- `deploy/docker-compose.example.yml`
- `deploy/docker-compose.canary.example.yml`
- `deploy/Caddyfile`
- `deploy/Caddyfile.stop-ai`
- 由 `deploy/env.example` 生成的 `.env`

## 4. 构建和登记不可变制品

### 4.1 构建规则

1. 从通过审核的 Git commit 构建。
2. `NODE_IMAGE` 和 `PYTHON_IMAGE` 在正式构建时也必须使用 digest；Dockerfile 中的版本 tag 只是本地兼容默认值。
3. 构建参数写入 `HUAMEI_BUILD_REVISION` 和 `HUAMEI_BUILD_CREATED`。
4. 推送后从仓库解析 `RepoDigest`，将完整 digest 写入 `.env`。
5. 保留这个发布使用的应用、GraphRAG 和基础镜像 digest，不得覆盖。

示例仅展示参数结构；`<...>` 必须由发布系统注入：

```bash
docker build \
  --build-arg NODE_IMAGE='node:22.22.1-bookworm-slim@sha256:<node-base-digest>' \
  --build-arg HUAMEI_BUILD_REVISION='<git-commit>' \
  --build-arg HUAMEI_BUILD_CREATED='<utc-time>' \
  -t '<registry>/huamei-app:<release-id>' .

docker build \
  --build-arg PYTHON_IMAGE='python:3.12.11-slim-bookworm@sha256:<python-base-digest>' \
  --build-arg HUAMEI_BUILD_REVISION='<git-commit>' \
  --build-arg HUAMEI_BUILD_CREATED='<utc-time>' \
  -f graphrag-service/Dockerfile \
  -t '<registry>/huamei-graphrag:<release-id>' .
```

不要将 `docker image inspect` 的全部环境字段作为发布证据，避免回显构建时密钥。只保留镜像 ID、RepoDigest、OCI revision 和扫描/SBOM 结论。

## 5. 首次安装

### 5.1 配置

1. 从 `deploy/env.example` 复制生成 `.env`，权限设为 `0600`。
2. 填写独立密钥、OIDC、域名、知识目录和 GraphRAG 不可变索引目录。`HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON`与`HUAMEI_CONTACT_VAULT_KEYRING_JSON`由KMS/Secret Manager分别注入，任何版本的实际密钥材料都不得重复。
3. 五个正式镜像变量都写入 digest：`HUAMEI_APP_IMAGE`、`HUAMEI_GRAPHRAG_IMAGE`、`HUAMEI_POSTGRES_IMAGE`、`HUAMEI_REDIS_IMAGE`、`HUAMEI_CADDY_IMAGE`。
4. `HUAMEI_RELEASE_ID` 在一次发布内不变，`HUAMEI_RELEASE_TENANT_IDS`列出本次对客租户，`HUAMEI_EVIDENCE_ENVIRONMENT`明确填写`preproduction`或`production`。环境值来自受控发布配置，不能由评测报告自行选择。当前一个 GraphRAG 实例只绑定一个租户/release；多租户必须先建立独立端点映射。
5. `HUAMEI_CANARY_TOKEN` 使用至少 32 位的独立随机值。生产的`HUAMEI_ACQUISITION_METRICS_TOKEN`、`HUAMEI_GRAPHRAG_METRICS_TOKEN`、`HUAMEI_OUTBOX_METRICS_TOKEN`、`HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN`必须四者互异；启用canary时，`HUAMEI_CANARY_ACQUISITION_METRICS_TOKEN`和`HUAMEI_CANARY_GRAPHRAG_METRICS_TOKEN`还必须与生产四枚及彼此互异。以上值不得复用LLM、GraphRAG服务、API、调用方、数据库、身份pepper、会话、隐私或加密密钥。
6. `HUAMEI_GRAPHRAG_READINESS_RECORD_ID` 选择当前正式release中一条稳定、已三审的不可变record ID。就绪探针必须从official GraphRAG返回该记录，并校验标题、来源、正文和内容SHA；空证据或仅服务可达不得判为ready。
7. 没有真实外部事件接收端时，保持 `HUAMEI_OUTBOX_DELIVERY_ENABLED=false`，不启动 `external-events` profile。
8. 将8份容量/评测文件放入`HUAMEI_RELEASE_EVIDENCE_HOST_PATH`：7份已签名证据`blind-dataset.json`、`evaluation-raw.json`、`evaluation-scorecard.json`、`capacity-raw.json`、`capacity-attestation.json`、`evaluation.json`、`capacity.json`，以及1份由SHA和SRE attestation绑定的`capacity-prometheus.json`。全8份文件分别登记SHA-256；容量链还必须绑定GraphRAG查询模型和独立配额。直连GraphRAG只是非正式延迟/饱和探测，不得用它声称查询多样性达标，也不得注入合成变体或nonce。主链路正式容量必须使用已审批签名taxonomy manifest中的entry ID，以GraphRAG响应的净化查询SHA-256证明多样性；不得把客户原话、联系方式、病史、自由文本或客户原话hash发给GraphRAG/query-model。
9. 将受控`huamei.formal-evaluation-endpoint-registry.v1`文件以只读绝对路径挂载给正式评测runner和一次性`release-preflight`，分别登记`HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_PATH`与文件SHA。注册表按tenant+environment唯一绑定exact HTTPS origin、部署ID、release、两份镜像、知识release、index和manifest；普通`HUAMEI_ACQUISITION_SERVICE_URL`或命令行地址不能替代它。
10. 一次性`release-preflight`只注入外置公钥注册表`HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64`。正式证据私钥和任何`*_SIGNING_KEY_PATH`不得写入部署`.env`、Compose或长期服务；签名只在受控runner/KMS短时、只读挂载中完成。
10a. 正式容量压测另行封存`huamei.formal-load-taxonomy-manifest.v1`，重新计算签名后SHA，并在变更记录中保存manifest ID、SHA、签名人、signed payload SHA、catalog SHA、release/index绑定和有效时窗。只在该窗口使用`docker-compose.formal-capacity.example.yml` override；公网gateway不得获得`formal-load:execute`或通配权限。压测结束立即移除override并重建acquisition，确认开关回到`false`。
11. 在IdP中为首期生产接管工作台建立最小角色：所有坐席需`operations.agent`；允许显式查看回访电话的坐席还必须同时具有`contact:reveal`。每个实名账号的`tenant_ids`必须枚举具体租户，人员令牌不得使用`*`。`customer:read`、`service:read`、`runs:read`或头像等其他管理API角色仅在另行批准的用途下授予，不会让演示模块在生产出现。生产管理API同时校验OIDC签名、issuer、audience、时效、全部要求角色和租户，并把OIDC `sub`写入追加式审计。人工接管BFF只向后端转发同一Bearer，服务密钥只由网关从密钥管理器读取，不得返回浏览器。Caddy管理路由必须原样透传身份代理注入的`Authorization: Bearer ...`，不得用共享Basic凭据覆盖实名身份。
12. 生产浏览器登录采用受支持的外部OIDC Authorization Code + PKCE身份代理（在`HUAMEI_ADMIN_IDENTITY_PROXY_PRODUCT`登记实际产品）：由代理完成`state`、`nonce`、PKCE、Origin/CSRF校验、回调和OIDC登出，使用`HttpOnly; Secure; SameSite=Lax/Strict`会话Cookie，加密session必须存入共享Redis，且至少两副本或等价托管HA。浏览器只持有Cookie；代理必须丢弃客户端`Authorization`并在转发管理HTML和API时注入已验证Bearer，Node依然独立验签。代理健康端点必须通过HTTPS返回`X-Huamei-Identity-Proxy-Contract: oidc-code-pkce-v1`，发布预检与应用readiness会主动请求该路径。禁止坐席手工粘贴token，也禁止将token存入`localStorage`或`sessionStorage`。
13. Caddy的80/443宿主机映射必须通过`HUAMEI_EDGE_BIND_ADDRESS`绑定到`127.0.0.1`或批准的私有接口，禁止`0.0.0.0`、`::`和通配地址。公共域与管理域都由批准的OIDC/WAF边缘代理进入；公共顾问路径可匿名转发，管理域必须先登录。主机防火墙/安全组只允许该代理来源访问私有edge地址，并保存规则导出作为发布证据。直接以管理SNI连接Caddy必须不可达；若代理跨主机，还需使用专用私网或mTLS。正常与停AI两份Caddy配置都不得使用Basic覆盖Bearer。
14. 将每个稳定GraphRAG副本写入`deploy/observability/graphrag-targets.example.json`的受控生产副本，或使用等价服务发现；不能只填一个负载均衡VIP来代替逐副本可见性。确认`up{job="huamei-graphrag"}`中的健康实例数与实际副本数相等。正式容量和告警查询必须按服务跨`instance`求和，保留PromQL/query reference和原始导出；启用canary时对灰度副本使用独立token与可区分标签。
15. 通过OIDC实名登录管理域后读取受保护的`runtime-config.js`，确认`delivery_mode="handover_only"`、`demo_mutations_enabled=false`且`Cache-Control: no-store`。页面只能进入真实接管工作台；演示客户、虚构角色、全局搜索和头像/客户/服务等演示变更不可见，也不得通过构造事件调用。认领、查看联系方式、完成和工时需与服务端记录、数据库和审计逐项对账。

本地`npm run dev`会为同一进程树临时生成`HUAMEI_LOCAL_ADMIN_BRIDGE_SECRET`，网关以它对固定`local-admin`主体、租户、路由、方法和30秒时效签名后调用4180。密钥不写磁盘、不发给浏览器，生产环境无条件禁用该通道。

生产和canary Compose均已移除共享`env_file`。命令中的`docker compose --env-file .env`只为Compose变量插值提供输入，不会把`.env`整体注入容器；每个服务只能接收Compose中显式列出的环境变量。新增变量必须逐服务审核后加入白名单，不得用共享环境文件绕过边界。

先做静态解析：

```bash
docker compose --env-file .env -f docker-compose.example.yml config --quiet
docker compose --env-file .env -f docker-compose.example.yml pull
```

`config --quiet` 失败时不得继续。不得执行会把完整 Compose 环境展开到公共日志的命令。

### 5.2 首次创建数据库角色

`provision-db` 只属于 `bootstrap` profile，不会在日常发布中自动重跑。使用数据库 bootstrap 凭据执行：

```bash
docker compose --env-file .env -f docker-compose.example.yml \
  --profile bootstrap run --rm provision-db
```

该步骤不是“角色已存在就跳过”，而是每次都把三个固定角色的登录/超级权限/RLS绕过/继承/复制/角色设置、数据库与schema权限以及membership拓扑归一化。唯一允许的成员边是`huamei_owner <- huamei_migrator`，并且必须精确为`admin_option=false`、`inherit_option=false`、`set_option=true`；任何历史ADMIN授权都失败关闭。`huamei_owner`不可登录，`huamei_runtime`不能SET ROLE到任何角色。执行期间使用session advisory lock；若返回`POSTGRES_ROLE_PROVISIONING_LOCKED`，说明另一个角色配置任务正在运行，禁止并发重试。

归一也会撤销`PUBLIC`、`huamei_migrator`和`huamei_runtime`在所有现存业务表、序列和应用函数上的直授权限，再按库内审批矩阵重授。`huamei_runtime`不得拥有`DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER`，序列仅有`USAGE`/`SELECT`；`huamei_migrator`不得有直授DML或函数执行权；`PUBLIC`不得有业务对象权限。函数必须精确匹配完整签名白名单，`public`中发现任何未批准的`SECURITY DEFINER`都以`POSTGRES_SECURITY_DEFINER_REMEDIATION_REQUIRED`失败关闭，禁止自动放行。

若发现runtime或migrator历史遗留对象所有权，脚本会先保留已经完成的权限收紧，再以`POSTGRES_ROLE_OWNERSHIP_REMEDIATION_REQUIRED`失败。DBA必须核对报告中的对象类别和数量，逐项决定改owner或清理；禁止自动`REASSIGN OWNED`掩盖未知对象。处理后重新运行，只有退出码0才可继续迁移。

记录成功结论，不记录 URL、密码或容器完整环境。使用托管 PostgreSQL 时，按同样的 owner/migrator/runtime 权限模型由 DBA 执行，不在应用网络长期保留 bootstrap 连接权。CI中的`npm run test:postgres-role-provisioning`会先制造脏SUPERUSER、历史membership、PUBLIC CREATE/TEMP和runtime-owned对象，验证锁、失败关闭、DBA修复及幂等归一化；它不替代生产DBA复核。

### 5.3 迁移

```bash
docker compose --env-file .env -f docker-compose.example.yml run --rm migrate
```

迁移使用 PostgreSQL advisory lock，已应用文件必须 checksum 一致。出现 `MIGRATION_CHECKSUM_MISMATCH` 立即停止；不得更改 `schema_migrations`。

当前正式inventory必须连续包含`001`至`011_contact_vault.sql`。迁移后以migrator/DBA核对：`contact_vault_entries`存在、开启ENABLE/FORCE RLS，密文字段拒绝`value/mobile/phone/plaintext`键，runtime只有SELECT/INSERT/UPDATE而没有DELETE/TRUNCATE。不要查询或导出密文内容作为发布日志。

迁移可能创建新表、序列或函数，因此每次完成迁移及重放校验后，必须在停写窗口内再执行一次`provision-db`或由DBA执行等价归一，然后再运行发布预检。不得在“迁移已完成但对象ACL未再归一”的混合状态启动canary或对客服务。

### 5.4 启动首次知识控制面

```bash
docker compose --env-file .env -f docker-compose.example.yml up -d postgres redis
docker compose --env-file .env -f docker-compose.example.yml up -d --no-deps acquisition
```

首次安装尚未生成official索引、也未激活正式知识release。此时`acquisition`只提供内网知识控制面，`/ready`应保持失败，因此不得启动app或公网切流。4180不得映射到宿主机。

### 5.5 激活正式知识

严格按 [KNOWLEDGE_GOVERNANCE_RUNBOOK.md](./KNOWLEDGE_GOVERNANCE_RUNBOOK.md) 使用私有一次性`knowledge-governance`容器完成：

1. release manager 创建 draft，绑定 package SHA、record-list SHA 和 index version。
2. 业务、医务、合规三个不同 OIDC 实名主体对同一 scope checksum 审核。
3. index manager 绑定 GraphRAG `manifest.json` 和 manifest SHA。
4. publisher 激活 release。
5. publisher激活release，正常启动GraphRAG、acquisition和conversation-recovery，确认`admission`与`/ready`绑定同一release。

治理调用方与公众网页调用方必须使用不同密钥；OIDC token和payload只能从`0700`受控目录中的`0600`普通文件只读挂载。不得开放4180，不得用SQL直接把`is_active`改为true。

### 5.6 启动入口并执行发布预检

```bash
docker compose --env-file .env -f docker-compose.example.yml up -d app caddy
docker compose --env-file .env -f docker-compose.example.yml \
  --profile release-check run --rm release-preflight
```

预检只输出检查名、结果、安全错误码和非敏感绑定 ID，不回显连接串或请求密钥。将 JSON 报告作为发布证据保存到受控变更记录。

预检会按外置绝对路径读取8份证据制品（7份签名证据和1份Prometheus原始导出）以及受控endpoint注册表，先校验各自登记SHA，再用外置可信签名人注册表验证5份真实来源证据和两份v2最终报告的Ed25519签名、证据类型、职责、7个签名人ID与7个实际SPKI DER SHA-256指纹互异及发行绑定。实际来源验签结果（含公钥指纹）必须与最终报告`verified_sources`逐字段一致；评测raw和最终报告中的endpoint注册表SHA、exact origin、entry ID和部署ID还必须与预检重新读取的受控注册表完全一致。同一key多alias、重定向、错误origin、虚构摘要或缺任一源文件都会失败关闭。

容量预检还必须确认Prometheus导出覆盖完整压测窗口并来自全部实际副本。GraphRAG检索/缓存、查询模型调用/成功/token和`huamei_formal_load_taxonomy_total`必须按副本采集后汇总；taxonomy applied总数必须等于请求数，rejected必须为0，distinct entry必须等于请求数，且manifest SHA/签名人/catalog绑定与raw完全一致。多样性由受控runner从每个服务响应收集的完整sanitized-query SHA列表重算；Prometheus的per-query-hash标签保持高基数上限，只作诊断，不得为了压测调高到十万/百万级。任一副本缺失、指标token复用、entry复用、查询SHA来自客户原话或只提供单实例自报结果，都保持`blocked`。

## 6. 日常升级

1. 确认变更窗口、值班人、回滚负责人和灰度范围。
2. 按 [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) 完成升级前备份和可恢复性证据。
3. 登记新 release ID 和全部新 digest，先 `pull`，不切换稳定镜像变量。
4. 阅读新迁移。扩展必须先于删除，且在灰度期同时兼容旧、新应用。唯一例外是不向后兼容的字段加密AAD v1→v2切换：该发布禁止混合灰度，必须按[FIELD_ENCRYPTION.md](./FIELD_ENCRYPTION.md)停AI、停全部写入、原子迁移并整组升级。联系方式保险箱轮换时可以在keyring中暂存新旧版本，但新key必须独立生成；所有旧信封完成受控重加密和抽样验证前不得删除旧key。
5. 运行 `migrate`。变更后不做数据库 down migration；失败优先前向修复。
6. 先按第 7 节启动 canary，再更新稳定镜像 digest。
7. 更新稳定服务后运行完整发布预检。
8. 检查 Compose 中 app、acquisition、GraphRAG 的实际副本数、健康状态和镜像 digest；同时核对Prometheus发现的健康实例数完全一致，管理端仍为`handover_only`且无演示变更入口。
9. 观察期内不删除旧镜像、旧配置或备份。

稳定服务更新示例：

```bash
docker compose --env-file .env -f docker-compose.example.yml pull graphrag acquisition app conversation-recovery
docker compose --env-file .env -f docker-compose.example.yml up -d graphrag acquisition app conversation-recovery
docker compose --env-file .env -f docker-compose.example.yml \
  --profile release-check run --rm release-preflight
```

Compose 文件为 app、acquisition 和 GraphRAG 声明了多副本与资源上限。若宿主 Compose 实现不执行 `deploy.replicas`，必须使用受控的 `--scale` 或迁入支持副本和滚动更新的编排器，不得默认单副本已经达到高可用。

## 7. 头部指定灰度

仓库提供 `deploy/docker-compose.canary.example.yml`，启动一套单副本 canary GraphRAG、acquisition 和 app。它们与稳定服务共用 PostgreSQL/Redis，因此只允许兼容当前 schema 的代码灰度。

字段加密AAD v1→v2不具备这种兼容性：旧应用无法读取v2信封。该版本不得启动canary，不得让v1/v2应用共用一个库；必须在stop-AI和全部写入停止的窗口中运行受控重包，替换全部读写副本，并在v1总数为0的发布预检通过后恢复入口。

### 7.1 启动 canary

1. 将 `HUAMEI_CANARY_APP_IMAGE` 和 `HUAMEI_CANARY_GRAPHRAG_IMAGE` 设为新 digest。
2. canary GraphRAG 必须先绑定当前 active release，不得加载尚未激活的知识；灰度acquisition/GraphRAG使用各自独立metrics token，并作为可区分实例加入Prometheus服务发现。
3. 启动：

```bash
docker compose --env-file .env \
  -f docker-compose.example.yml \
  -f docker-compose.canary.example.yml \
  --profile canary up -d graphrag-canary acquisition-canary app-canary
```

4. 将发布预检的三个服务 URL 临时指向 canary，并把发布镜像变量临时指向 canary digest，执行同一预检。不得为了灰度降低预检条件。

### 7.2 切入测试流量

Caddy 只在请求头 `X-Huamei-Canary` 与受控的 `HUAMEI_CANARY_TOKEN` 一致时转发到 `app-canary`。仅向已授权内部测试人员的密钥注入工具提供该值；不得写入截图、工单、命令历史或公共日志。

灰度至少覆盖：

- 知识问答、多轮会话、同 message ID 重放、转人工、留资。
- GraphRAG 证据中的 tenant/release/index 绑定。
- GraphRAG只接收安全业务分类词；灰度副本的检索/缓存/查询模型/token/净化查询SHA均能独立采集并纳入汇总。
- PostgreSQL/Redis 连接池、错误率、P95、会话序号冲突和人工接管。
- 当前认领人显式查看联系方式时可用；未认领、跨租户、缺少`contact:reveal`、同意撤回/联系受限及幂等键重放均被拒绝，明文不进入浏览器存储或审计。
- 生产管理端仍只显示真实接管工作台，演示客户和本地假操作不能出现或执行。
- 稳定副本与 canary 副本对同一消息重放不产生重复数据。

不在同一生产租户内灰度“新知识 release”。数据库对每个租户只允许一个 active release；知识变更先在预生产或影子租户验证，再执行一次受控激活。

### 7.3 推广或退回

- 推广：将稳定镜像变量更新为 canary digest，重建稳定副本，跑完整预检，再停止 canary。
- 退回：先停止 `app-canary`，测试请求自然回到稳定端；再停止 `acquisition-canary` 和 `graphrag-canary`。不修改稳定数据。

## 8. 回滚

### 8.1 可直接回滚的情况

只有同时满足以下条件，才能直接把 app/GraphRAG 镜像改回上一 digest：

- 本次未施加新数据库迁移，或上一镜像包含与当前数据库完全相同的迁移 inventory/checksum。
- 上一镜像仍兼容当前 active knowledge release 和 GraphRAG manifest。
- 旧配置没有已撤销的密钥、已下线模型或已禁止出网；旧镜像能读取当前通用字段和联系方式保险箱信封，并保持两套keyring密钥域独立。
- 用上一镜像运行发布预检能通过。

回滚步骤：

1. 执行第 9 节的网关停 AI，阻止新对客请求。
2. 将 `.env` 的 app/GraphRAG digest 改为已登记的上一兼容版本。
3. `pull` 后重建内部服务，保持网关停 AI 配置。
4. 运行发布预检。
5. 预检通过后恢复网关。
6. 记录原因、开始/结束时间、影响会话数和后续处理。

### 8.2 已有新迁移时

数据库迁移默认前向、可追溯，不提供自动 down migration。如旧镜像的迁移 inventory 少于当前数据库，发布预检会阻止回滚。此时优先顺序：

1. 前向修复新镜像。
2. 使用已证明兼容当前 schema 的最近镜像。
3. 只有数据严重损坏或法定事故决策时，才按 [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) 整体恢复。整体恢复会回退业务数据，必须由业务、DBA、安全共同批准 RPO/RTO 和补录方案。

### 8.3 知识回滚

不直接把 superseded release 改回 active。如需回到旧知识，以旧内容创建一个新 release，重新生成不可变索引、重新三审、绑定 manifest 并激活。这样审计链不会被覆盖。

### 8.4 回滚演练

每次大版本上线前必须在预生产演练一次：

1. 使用前一个已登记的应用/GraphRAG digest，不改变数据库和 active release。
2. 先加载 stop-AI 配置，再切换内部镜像。
3. 验证旧镜像与当前001–011 migration inventory、通用字段/联系方式两套独立keyring、知识 manifest、管理端`handover_only`和模型配置兼容。
4. 运行完整 release preflight。返回 `blocked` 说明该镜像不可回滚，必须改为前向修复。
5. 预检通过后恢复一条受控会话，确认 message ID 重放、留资和人工接管不重复，再恢复网关。

演练记录必须包含新/旧镜像 digest、schema inventory、停止和恢复时间、预检结果、会话样本以及 GO/NO-GO 结论。

## 9. 紧急停 AI 与恢复

### 9.1 何时立即停 AI

- 疑似错误医疗建议、越权宣传、未授权知识泄露。
- 租户串数据、RLS 失效、密钥泄露。
- 联系方式出现在普通列表、日志、浏览器存储或非当前认领人响应中，或撤回/限制联系后仍能查看。
- 生产管理端出现演示客户、虚构角色或仅浏览器生效的业务变更入口。
- 同一消息重复留资/重复事件、会话严重乱序。
- GraphRAG 与 active release 绑定不一致、收到客户原话，或Prometheus漏采实际副本。
- 模型或外部系统异常导致不可控对客输出。

### 9.2 网关级停 AI

先验证应急配置，再原子加载：

```bash
docker compose --env-file .env -f docker-compose.example.yml exec caddy \
  caddy validate --config /etc/caddy/Caddyfile.stop-ai --adapter caddyfile

docker compose --env-file .env -f docker-compose.example.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile.stop-ai --adapter caddyfile
```

该配置只将 `/api/public/acquisition-chat` 改为明确 503 `AI_SERVICE_PAUSED`，保留健康检查、管理端、现有转人工记录和独立留资能力。

网关已阻断新对客请求后，视事故停止内部智能体：

```bash
docker compose --env-file .env -f docker-compose.example.yml stop acquisition graphrag conversation-recovery
```

如启用了 canary，也要停止 `app-canary`、`acquisition-canary`、`graphrag-canary`。如事故涉及外部事件误发，同时停止 Outbox worker；停止 worker 不会删除已持久化积压。

如事故涉及整个公网边界或凭据泄露，不保留管理入口，直接在负载均衡/防火墙摘流并停止 Caddy。

### 9.3 恢复 AI

1. 完成原因修复、密钥轮换和必要数据补偿。
2. 保持 Caddy 仍使用 stop-AI 配置，启动 GraphRAG、acquisition 和 recovery worker。
3. 运行完整发布预检；任何 blocked 都不得恢复。
4. 验证人工接管和一条受控测试会话。
5. 原子加载正式 Caddy 配置：

```bash
docker compose --env-file .env -f docker-compose.example.yml exec caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

docker compose --env-file .env -f docker-compose.example.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

6. 记录停服时间、恢复时间、丢失/阻塞会话、人工补偿和后续复盘负责人。

### 9.4 停 AI 演练验收

至少每季度和每次网关配置变更后在预生产演练。下列条件必须同时满足：

- `Caddyfile.stop-ai` 在当前正式 Caddy 镜像中 `validate` 通过，`reload` 不中断非 AI 请求。
- `POST /api/public/acquisition-chat` 稳定返回 503 和 `AI_SERVICE_PAUSED`，不会进入模型或产生新 assistant message。
- `POST /api/public/acquisition-lead` 和受保护的真实接管工作台仍可用，既有转人工记录不丢失；联系方式查看仍需当前认领人双角色、有效服务同意和无联系限制，不得因停AI放宽。
- acquisition、GraphRAG 和 recovery worker 可在网关阻断后停止；Outbox 如涉及事故也停止，数据库积压不被删除。
- 恢复前的 release preflight 全部通过，且恢复正式 Caddy 配置后仅一条受控会话被处理一次。

记录演练时间线、操作人、每个端点的状态/错误码、未完成收件数、Outbox 积压数和恢复结果。任一项不符合都必须在真实上线前修复并重演。

## 10. Outbox 启用、停用和积压

Outbox worker 位于 `external-events` profile，默认不启动。启用前必须有书面证据证明外部 HTTPS 接收端：

- 按 `(tenant_id,event_id)` 幂等。
- 重放同一事件不产生重复业务动作。
- 能返回受控回执 ID，不在错误体中回显密钥或敏感 payload。
- 有独立服务密钥、租户白名单、重试/死信和人工补偿负责人。

通过后设置 `HUAMEI_OUTBOX_DELIVERY_ENABLED=true`，再启动：

```bash
docker compose --env-file .env -f docker-compose.example.yml \
  --profile external-events up -d outbox
```

外部端故障时可执行 `stop outbox`。不删除 `outbox_events`，不手工改事件为 published。恢复后 worker 依据 lease、重试和死信状态继续处理。其余操作见 [OUTBOX_DELIVERY_RUNBOOK.md](./OUTBOX_DELIVERY_RUNBOOK.md)。

## 11. 每次发布必须归档的证据

- 发布 ID、Git commit、五个生产镜像 digest、基础镜像 digest。
- 容器扫描/SBOM/签名结论，不含镜像环境密钥。
- 升级前备份 ID、PITR 时点、恢复演练结论。
- 迁移 applied/skipped 列表和 checksum 预检结论。
- runtime 最小权限和 FORCE RLS 预检结论，明确包含`011_contact_vault.sql`与`contact_vault_entries`。
- 通用字段与联系方式保险箱keyring的非敏感key ID/指纹去重结论、轮换/恢复负责人；不得归档实际密钥材料。
- active release ID、package SHA、record-list SHA、index version、manifest SHA、三审回执 ID。
- 7份正式签名证据的文件SHA、签名人ID/职责、外置可信注册表版本和发布预检报告；私钥和私钥挂载路径不得归档。
- GraphRAG、acquisition、app、PostgreSQL、Redis readiness 结论；GraphRAG实际副本清单、独立metrics token检查结论、跨实例Prometheus查询引用及净化查询SHA计数。
- 生产管理端`handover_only`/禁用演示变更的浏览器烟测，以及认领、联系方式查看、完成和工时的数据库/审计对账。
- canary 范围、开始/结束时间、成功率、P95、错误和人工接管样本。
- 切流人、监看人、回滚人及最终 GO/NO-GO 结论。

## 12. 明确禁止的操作

- 不得在生产使用 `docker compose down -v`。
- 不得手工删除 PostgreSQL、Redis、Caddy 或 app 数据卷来“重试安装”。
- 不得在命令行、工单、截图、聊天或公共 CI 日志中展开 `.env`、连接串或 token。
- 不得复用通用字段加密与联系方式保险箱的任何实际密钥材料，也不得用GraphRAG服务调用密钥采集`/metrics`。
- 不得把客户原话、联系方式或病史直接发送给GraphRAG/query-model；不得用客户原话哈希伪装成净化查询指纹。
- 不得只采集一个GraphRAG实例却宣称覆盖多副本，也不得把单实例或负载均衡VIP自报指标当作正式容量汇总。
- 不得在生产启用`demo`管理运行模式、演示客户或仅浏览器生效的业务变更。
- 不得将正式证据签名私钥或`*_SIGNING_KEY_PATH`注入Compose长期服务、canary、`release-preflight`或通用部署`.env`。
- 不得修改已应用的 SQL 文件或 `schema_migrations.checksum`。
- 不得让 app 使用 migrator/bootstrap 连接串。
- 不得在无真实接收端时启动 Outbox worker。
- 不得在预检 blocked 时恢复对客 AI 流量。
