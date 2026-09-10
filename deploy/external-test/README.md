# 单机外测部署

该目录提供经账号密码保护的单机外测编排。`compose.yml` 默认只绑定本机回环地址；`compose.tls.yml` 为已有域名增加 HTTPS 入口。该环境仍缺少正式 OIDC、GraphRAG 发布索引与高可用基础设施，不代表全项目已正式上线。

部署时仅同步审核后的知识包以及 `原始数据/公开资料`，不复制聊天记录、客户数据、术前术后或案例素材。知识检索保持在已审核本地降级链路，GraphRAG 关闭；因此不得作为正式生产验收或真实客户正式上线依据。

外测镜像刻意不安装 `ffmpeg`，因此本期外测不启用 AI 数字人媒体生成；前台售前对话、管理后台、知识检索及图片/PDF 预览不受影响。正式环境应使用根目录 `Dockerfile`，并按生产依赖与准入流程安装该运行时能力。

运行：

```bash
cp env.example .env
chmod 600 .env
docker compose --env-file .env -f compose.yml up -d --build
docker compose --env-file .env -f compose.yml ps
```

公网外测在填写域名、Caddy 镜像摘要及 HTTPS 来源白名单后使用：

```bash
docker compose --env-file .env -f compose.yml -f compose.tls.yml config --quiet
docker compose --env-file .env -f compose.yml -f compose.tls.yml up -d --build
docker compose --env-file .env -f compose.yml -f compose.tls.yml ps
```

域名 DNS 必须指向本机，80/443 端口可达；Caddy 的证书保存在独立数据卷并自动续期。HTTP 和 IP 访问只跳转到固定 HTTPS 域名，避免在明文连接上要求登录。仅代理容器发布端口，应用和售前服务不直接暴露。检查 `HUAMEI_EXTERNAL_PROXY_SUBNET` 与服务器已有网段不冲突；应用只信任该代理的固定地址，覆盖伪造的转发头，会话 Cookie 标记为 Secure。

客户顾问入口为 `/advisor/`，使用 `HUAMEI_PREVIEW_*`；管理后台使用 `HUAMEI_ADMIN_*`。两组凭据必须不同。更新时运行同一条 `up -d --build` 命令；禁止使用 `down -v`，否则会清除外测数据卷。

`HUAMEI_ALLOWED_ORIGINS` 必须填写实际访问的精确浏览器来源（可用逗号分隔），例如服务器 IP 和外测域名；不得使用通配符。该配置缺失时，浏览器对话请求会被网关拒绝。

分容器部署需配置独立的 `HUAMEI_EXTERNAL_TEST_ADMIN_BRIDGE_SECRET`（至少 32 字符，可通过 `openssl rand -hex 48` 生成），由 web 和 acquisition 共享。Basic 账号只在网关验证；已认证的管理身份通过短时签名传到内部服务，内部服务同时校验服务密钥、固定调用方和租户。该桥仅在显式 staging 外测环境启用，不能用于正式生产身份认证。

发布前运行 `npm run test:deployment-development`。发布后在 web 容器内运行 `node scripts/smoke-external-test.mjs` 验证登录与管理接口；加 `--chat` 会创建带测试标识的合成问答记录。脚本不输出密码、密钥或客户正文。服务升级应保留 `/app/.local-data`、`/data` 和现有知识目录；知识运行时索引通过共享文件更新供独立售前进程读取。

`--edge` 通过已配置域名验证真实 HTTPS；`--chat --require-llm` 要求至少一轮具有服务端返回的模型调用成功标记，不能把未调用模型的规则回答当作模型接通。公开对话接口不返回供应商用量；用量在私有服务诊断中另行核实。浏览器来源从 `HUAMEI_ALLOWED_ORIGINS` 读取，不写死服务器地址。售前容器同时接入出站网络以访问模型，但不发布主机端口。

升级前先记录旧镜像、Compose 配置、环境文件、知识挂载及所有数据卷。旧版 `/data` 是匿名卷；首次升级到本版必须在停止应用写入后，将两个容器各自的旧 `/data` 完整复制到对应的 `web_data` / `acquisition_data` 卷，再启动新版。保留旧卷、旧镜像和停止写入时的快照，不执行 `down -v`。回退只能使用相容的旧版和数据快照；上线后已产生新登记时不得直接恢复旧快照而丢失新增记录。

仅使用基础编排时，原始回拨号码仍在进程内存中，服务重启后不可恢复。已经启用 `compose.persistence.yml` 的环境使用 PostgreSQL 加密联系方式库与 Redis；数据库和缓存不发布主机端口。当前服务器已启用该覆盖文件，完整操作与验证见 `../../docs/project-control/SERVER_DEPLOYMENT_2026-09-09.md`。

启用持久化后，日常更新必须同时加载 `compose.yml`、`compose.tls.yml` 和 `compose.persistence.yml`，遗漏最后一个会退回本地存储。先配置独立的 bootstrap/migrator/runtime 数据库账号、Redis 密码、身份 pepper、会话签名密钥及两套不同的字段/联系方式 AES 密钥；使用固定镜像摘要。环境配置仅存受限服务器文件，不放入镜像或源码。初始化顺序为 `postgres redis` 健康 → `provision-db` → `migrate` → 再次 `provision-db` → 应用启动。迁移服务只持有迁移账号，应用只持有受限运行账号。备份必须同时保护数据库和对应加密密钥，否则仅恢复数据文件无法还原号码。

历史 JSON 记录不含可恢复的原始号码。不得将掩码号码作为原号导入，或把历史未验证同意标记伪装成新授权。本次切换前核实只有明确标记的合成留资及已取消登记，全部保留归档；这不证明一般客户历史数据迁移已经实现。知识草稿与素材仍存在单机存储限制，启用数据库并不等于知识发布已完成生产化。
