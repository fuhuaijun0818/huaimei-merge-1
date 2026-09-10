# 生产验证 CI 流水线

版本：1.1
更新日期：2026-08-26
实现：`.github/workflows/production-verification.yml`

## 1. 定位

该流水线是上线前必须通过的工程门禁，在Pull Request、`main` 分支更新和手工触发时运行。它证明代码、数据库迁移和容器可重复验证，不代替预生产真实模型压测、安全审批、镜像签名、灰度发布或生产回滚演练。

## 2. 门禁与执行顺序

| Job | 验证内容 | 失败效果 |
| --- | --- | --- |
| `policy-and-source-scan` | 在安装项目依赖前检查YAML、第三方Action固定SHA、候选敏感文件/高置信凭据、`.gitignore`/`.dockerignore`、npm锁文件完整性、Python直接依赖精确版本、001–011迁移及脚本清单 | 阻断后续所有Job |
| `static-and-node` | Node全量测试、可观测/韧性/正式证据/发布fail-closed门禁、售前页面构建和Sites Worker测试 | 阻断合并 |
| `python-tests` | 固定Python 3.12.11、Microsoft GraphRAG 3.1.1及检索服务测试、`pip check`；20人突发与持续多轮入口只做语法和`--help`静态门禁 | 阻断合并 |
| `dependency-audit` | 根项目生产依赖与售前页面全部npm依赖执行high级别审计 | high/critical漏洞阻断合并 |
| `container-builds` | 使用仓库变量提供的不可变Node/Python基础镜像digest构建应用与GraphRAG镜像，校验非root用户、Node/Python运行时版本和OCI构建修订标签 | 阻断合并 |
| `postgres-redis-integration` | 使用不可变镜像digest启动全新PostgreSQL 16/Redis 7，先核对实际服务主版本，再验证角色分离、001–011迁移及重放、迁移后对象ACL再归一、RLS、三审、会话一致性、Outbox、隐私执行、可信身份/完成证明防重放、匿名候选线索隔离、联系方式信封加密/接管人查看/撤回抑制/脱敏审计、字段加密AAD v1→v2全13字段原子迁移/缺key回滚/明文与碰撞拒绝、领域集成和Redis原子协调 | 阻断合并 |

`static-and-node`、`python-tests`、`dependency-audit`和`postgres-redis-integration`均依赖`policy-and-source-scan`，避免在基础源代码和供应链策略未通过时先安装项目依赖。`container-builds`还依赖Node、Python和依赖审计门禁。

PostgreSQL 集成环境分为：

- `postgres`：仅用于在临时容器内创建审计角色。
- `huamei_owner`：无登录权限，持有schema和迁移产物。
- `huamei_migrator`：可登录但无超级权限，显式 `SET ROLE huamei_owner` 应用迁移。
- `huamei_runtime`：可登录、不得越过RLS、不得创建schema对象。

角色归一同时把当前数据库视为不可信历史，撤销`PUBLIC`、`huamei_migrator`和`huamei_runtime`在业务表、序列和函数上的旧直授权限，再按审批矩阵精确授权。`huamei_runtime`没有`DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER`，序列只有`USAGE`/`SELECT`；`huamei_migrator`不获得直授DML或函数执行权；`PUBLIC`不获得业务对象权限。运行时函数只允许六个完整签名，其中四个`SECURITY DEFINER`须精确命中白名单；`public`中任何未批准的`SECURITY DEFINER`都会失败关闭。

集成Job先将角色标志、membership、`PUBLIC TEMP/CREATE`、`TRUNCATE`、序列更新、函数执行和未批准`SECURITY DEFINER`制造为脏状态，验证归一或失败关闭；随后重放迁移，必须再执行一次幂等权限归一，才运行真实对象ACL查询和`SET ROLE`/`TRUNCATE`反向验证。

## 3. 密钥和日志

- `actions/checkout`、`actions/setup-node`和`actions/setup-python`均固定到40位commit SHA；禁止`@main`、`@v4`等可变引用。离线静态检查只证明引用不会随tag漂移，不证明SHA属于某个官方release；首次入库和升级时必须由单独PR联网复核上游仓库、release与变更内容。
- 数据库、Redis和测试身份Pepper在每次Job内用 `openssl rand` 新建，不复用固定口令。
- 所有临时密钥及含密钥URL在写入 `GITHUB_ENV` 前使用 `::add-mask::` 注册脱敏。
- 脚本禁止 `set -x`/`xtrace`，不输出环境变量或完整连接URL。
- checkout 使用 `persist-credentials: false`；默认Token权限只有 `contents: read`。
- 集成容器仅存在于临时GitHub Runner，Job结束时无条件按精确容器名删除。

本地高置信扫描覆盖私钥头、GitHub/AWS/Google/NPM/Slack/Stripe/OpenAI常见凭据格式、非示例环境文件、证书/私钥文件和非占位连接凭据。测试夹具中的显式假连接串可存在，但仍接受高置信token扫描。该规则不能替代代码托管平台的全历史secret scanning、推送保护或人工安全审查。

正式模型、镜像仓库、预生产和生产凭据不应加入PR测试Job。未来的发布Job必须使用GitHub Environment审批与短期OIDC凭据，不使用长期云密钥。

PR流水线中的正式证据测试只用测试进程内临时生成的Ed25519密钥，验证v2 schema、7类职责、外置可信签名人注册表、SPKI DER公钥指纹全局唯一、同key多alias失败关闭、真实来源文件复验和失败关闭逻辑。它不会生成可用于上线的正式证据，也不会接触生产签名私钥。生产7类签名必须在受控证据runner/KMS完成；私钥不得写入GitHub变量、Compose、通用部署`.env`或长期服务。发布预检只接收外置公钥注册表、7份只读签名证据及其SHA。

`tests/backup-manifest-restore.mjs`使用进程内临时Ed25519密钥验证备份manifest、backup ID、关键表count、active release、audit anchor和RPO失败关闭逻辑。它不创建真实备份、不连接恢复库，也不替代对象存储版本、PITR恢复和DBA签字。

### 3.1 必须配置的非敏感仓库变量

GitHub仓库管理员必须配置以下Repository Variables，值均为完整`repository@sha256:<64位小写十六进制>`；变量不是密钥，但仍应通过变更审查维护：

| 变量 | 用途 |
| --- | --- |
| `HUAMEI_CI_NODE_BASE_IMAGE` | Node应用构建基础镜像 |
| `HUAMEI_CI_PYTHON_BASE_IMAGE` | GraphRAG构建基础镜像 |
| `HUAMEI_CI_POSTGRES_IMAGE` | PostgreSQL 16集成镜像 |
| `HUAMEI_CI_REDIS_IMAGE` | Redis 7集成镜像 |

缺少变量、使用tag或digest格式不正确时，对应Job会fail closed。不得把临时可变tag写回workflow绕过门禁。digest只限制内容漂移，不单独证明发布者或来源可信；镜像仓库允许列表、签名和来源证明仍是正式上线门禁。

### 3.2 锁文件和依赖审计边界

- 两个`package-lock.json`必须为lockfileVersion 3，根依赖与对应`package.json`完全一致，所有非本地包具备SHA-512 integrity；实际安装继续由`npm ci`复核。
- 锁文件中的下载地址只允许HTTPS `registry.npmjs.org`和`registry.npmmirror.com`，任意新的主机会阻断CI。当前根项目锁文件使用npmmirror，顾问端锁文件使用npm官方源；这个技术允许列表不等于正式信任批准，上线前由安全负责人选定企业下载源，并重新生成、复核锁文件。
- `graphrag-service/requirements.txt`的直接依赖必须使用`==`精确版本，安装后执行`pip check`。当前未使用带hash的完整Python传递依赖锁，也未执行Python漏洞数据库扫描，因此Python供应链仍是上线前P1。
- 根项目`npm audit --omit=dev --audit-level=high`只覆盖生产依赖；售前页面`npm audit --audit-level=high`覆盖生产和开发依赖。
- 当前没有操作系统包、容器层、许可证和恶意包专项扫描。CI成功不得表述为“供应链安全已全部通过”。

## 4. 本地验证

不启动外部服务的静态检查：
本地需要Node.js 22、Ruby及其标准Psych YAML解析器。

```bash
npm run ci:validate
docker compose -f deploy/docker-compose.example.yml config --no-interpolate --quiet
```

Node和Python门禁：

```bash
npm ci
npm test
npm run test:production-gates
npm run test:formal-evidence
npm run test:release-preflight
npm run test:deployment-release
npm run test:graphrag
```

持续多轮压测不在PR CI中自动执行。只允许在预生产隔离环境，使用专用、最小权限的调用方凭据手工运行：

```bash
export HUAMEI_LOAD_CALLER_ID=<load-test-caller>
# HUAMEI_LOAD_SERVICE_KEY 由密钥管理器注入，不写在命令行
npm run test:load:soak
```

不得将调用方密钥写入 `package.json`、CI YAML、压测报告或命令日志。

本地PostgreSQL/Redis已使用权限分离角色并应用全部迁移时：

```bash
npm run test:postgres-all
npm run test:redis-live
```

`test:postgres-all` 使用被Git忽略的 `deploy/local/.env`。不得把该文件、密钥或完整连接URL附到CI日志和问题工单。

## 5. 分支保护

GitHub管理员应将上述6个Job设置为`main`分支必需检查，并启用：

1. 禁止直接push到 `main`。
2. 至少1名审批人和最新提交后重新审批。
3. 必需检查与分支保持最新。
4. 禁止管理员默认绕过；紧急绕过须有变更单和事后复盘。
5. CODEOWNERS中将迁移、安全、知识发布和CI配置交由对应负责人审批。

## 6. 尚未覆盖的上线门禁

本流水线通过后，DEL-03仍只能记为 `PARTIAL`。上线前还需完成：

- 代码静态分析、Python/操作系统/容器漏洞、许可证和恶意依赖专用扫描。
- 全历史secret scanning与推送保护；当前本地规则扫描只是一层前置保护。
- Python传递依赖的hash锁定；GitHub托管`ubuntu-24.04`运行器镜像也由GitHub持续更新，并非不可变制品。
- SBOM生成与归档、镜像签名/证明、私有镜像仓库和制品保留。当前`container-builds`只做构建、非root、运行时版本和修订标签检查，**没有生成或签署正式供应链证明**。
- 预生产部署、真实模型20并发、故障注入、安全和备份恢复演练。
- 人工审批、灰度发布、SLI验证和一键回滚。

远程GitHub Actions尚未在受保护分支形成运行记录前，本文件只能证明流水线定义和本地静态校验通过，不能声称远程CI已通过。
