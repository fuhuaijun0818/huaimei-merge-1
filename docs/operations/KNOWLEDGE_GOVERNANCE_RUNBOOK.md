# 华美一期首次知识发布与后续变更 Runbook

版本：1.0  
适用：预生产、生产试点、买断部署

## 1. 目标和边界

正式环境没有 active knowledge release 时，`acquisition` 进程允许以
`control_plane_only` 状态启动，但 `/ready` 必须返回失败，网页和 Caddy 不得切流。
知识发布只能走私有 `knowledge-governance` 一次性容器，不能开放 4180 主机端口，不能
直接改数据库，也不能把 OIDC token 或服务密钥写入命令行、镜像、Git 或公共日志。

知识治理调用方必须是 `huamei_knowledge_governance`，仅有
`knowledge:read`、`knowledge:release`。公众网页调用方不得拥有这两个权限。

## 2. 人员与凭据

准备六个短时 OIDC token，角色和实名主体如下：

| 文件 | 角色 | 要求 |
| --- | --- | --- |
| `release-manager.jwt` | `knowledge.release_manager` | 创建草稿、读取审核范围 |
| `business-reviewer.jwt` | `knowledge.business_reviewer` | 业务审核 |
| `medical-reviewer.jwt` | `knowledge.medical_reviewer` | 医务审核 |
| `compliance-reviewer.jwt` | `knowledge.compliance_reviewer` | 合规审核 |
| `index-manager.jwt` | `knowledge.index_manager` | 导出回执、绑定索引 |
| `publisher.jwt` | `knowledge.publisher` | 激活发布 |

三位审核人必须是三个不同的 OIDC `sub`。建议 release manager、index manager 和
publisher 也分别使用独立实名主体。token 的 `aud`、issuer、tenant claim、角色 claim
必须与 `.env` 一致，并在操作窗口结束前有效。

在 `HUAMEI_KNOWLEDGE_GOVERNANCE_INPUT_HOST_PATH` 创建专用目录：目录归容器 uid/gid
`1000:1000`，权限 `0700`；其中每个普通文件权限 `0600`，不得存在符号链接。由密钥
管理器把以下文件短时落盘：

- `caller-secret`：与 `HUAMEI_ACQUISITION_CLIENTS_JSON` 中治理调用方的独立密钥完全一致；
- 六个 OIDC token 文件；
- 本节后续使用的 JSON payload。

CLI 会在发出网络请求前检查固定租户、文件目录、文件类型、权限、大小和 JWT 形态；
任何不符合项都会失败关闭。操作结束后按组织凭据销毁制度撤销 token 并安全清理短时文件。

## 3. 第一次安装的启动顺序

先启动数据库并迁移：

```bash
docker compose --env-file .env -f docker-compose.example.yml up -d postgres redis
docker compose --env-file .env -f docker-compose.example.yml run --rm migrate
```

首次建图前还没有 official GraphRAG 输出。此时只启动内部控制面，显式跳过尚未满足的
GraphRAG 依赖；它不会变成对客 ready：

```bash
docker compose --env-file .env -f docker-compose.example.yml \
  up -d --no-deps acquisition
```

检查当前准入状态：

```bash
docker compose --env-file .env -f docker-compose.example.yml \
  --profile knowledge-governance run --rm knowledge-governance admission
```

预期为没有 active release，而不是调用失败。不要在这个阶段启动 app 或 Caddy。

## 4. 创建不可变审核范围

`draft.json` 必须由发布系统从已冻结的公共安全目录生成，不得手工省略记录：

```json
{
  "package_version": "<知识包版本>",
  "package_checksum": "<huamei-public-safe.jsonl原始字节SHA-256>",
  "record_list_checksum": "<排序后的record_id和record_content_sha256集合SHA-256>",
  "index_version": "<本次唯一official索引版本>",
  "approved_record_ids": ["<三审范围内的全部record_id>"],
  "effective_at": "<ISO-8601时间>"
}
```

创建草稿：

```bash
docker compose --env-file .env -f docker-compose.example.yml \
  --profile knowledge-governance run --rm knowledge-governance \
  draft --payload-file=/run/knowledge-governance/draft.json \
  --oidc-token-file=/run/knowledge-governance/release-manager.jwt
```

从受控输出的 `response.data.id` 登记 release ID。下文 `<release-id>` 必须替换为这个原值，
禁止从非受控聊天、截图或手工转录中取得。

读取审核范围：

```bash
docker compose --env-file .env -f docker-compose.example.yml \
  --profile knowledge-governance run --rm knowledge-governance \
  scope --release-id=<release-id> \
  --oidc-token-file=/run/knowledge-governance/release-manager.jwt
```

将 `response.data.scope_checksum` 写入三份独立审核 payload。每份格式为：

```json
{
  "decision": "approved",
  "scope_checksum": "<同一个scope_checksum>",
  "comments": "<本角色的审核结论与受控审批单号>"
}
```

三位审核人分别执行；不可共享 token：

```bash
docker compose --env-file .env -f docker-compose.example.yml --profile knowledge-governance run --rm knowledge-governance review --release-id=<release-id> --review-type=business --payload-file=/run/knowledge-governance/business-review.json --oidc-token-file=/run/knowledge-governance/business-reviewer.jwt
docker compose --env-file .env -f docker-compose.example.yml --profile knowledge-governance run --rm knowledge-governance review --release-id=<release-id> --review-type=medical --payload-file=/run/knowledge-governance/medical-review.json --oidc-token-file=/run/knowledge-governance/medical-reviewer.jwt
docker compose --env-file .env -f docker-compose.example.yml --profile knowledge-governance run --rm knowledge-governance review --release-id=<release-id> --review-type=compliance --payload-file=/run/knowledge-governance/compliance-review.json --oidc-token-file=/run/knowledge-governance/compliance-reviewer.jwt
```

任一角色拒绝或 scope checksum 不同，都必须形成新草稿重新审核，不能覆盖原记录。

## 5. 回执、official GraphRAG 和索引绑定

index manager 导出回执：

```bash
docker compose --env-file .env -f docker-compose.example.yml \
  --profile knowledge-governance run --rm knowledge-governance \
  receipt --release-id=<release-id> \
  --oidc-token-file=/run/knowledge-governance/index-manager.jwt
```

把 `response.data` 原样保存为不可变 `release-binding.json`。不要保存 CLI 外层包装，也不要
编辑审核 ID 或时间。按
[GraphRAG 索引发布契约](../../graphrag-service/docs/index-release-contract.md)在隔离的受控建图
runner 执行 `build_official_index.py`。正式命令必须同时传入：

- 与 host 知识包逐字节相同的 `huamei-public-safe.jsonl`；
- 完整 `approved-records.json`；
- 上一步的 `release-binding.json`；
- 草稿中完全相同且从未使用过的 index version。

构建成功后，将完整 `output/` 放入
`HUAMEI_GRAPHRAG_OFFICIAL_OUTPUT_HOST_PATH`，只读挂载。`index.json` 必须包含生成的整个
`manifest.json` 对象，且 `index_checksum` 等于其中 `manifest_sha256`：

```json
{
  "index_checksum": "<manifest.manifest_sha256>",
  "manifest": { "<完整manifest.json>": "<不是摘要或人工重写>" }
}
```

先启动 official GraphRAG，再绑定索引：

```bash
docker compose --env-file .env -f docker-compose.example.yml up -d graphrag
docker compose --env-file .env -f docker-compose.example.yml \
  --profile knowledge-governance run --rm knowledge-governance \
  index --release-id=<release-id> \
  --payload-file=/run/knowledge-governance/index.json \
  --oidc-token-file=/run/knowledge-governance/index-manager.jwt
```

服务端会重新核对 tenant、release、index version、知识包 SHA、记录集 SHA、回执 SHA 和
三个数据库审核 ID。任一不一致时索引不会绑定。

## 6. 激活、就绪和切流

publisher 激活：

```bash
docker compose --env-file .env -f docker-compose.example.yml \
  --profile knowledge-governance run --rm knowledge-governance \
  activate --release-id=<release-id> \
  --oidc-token-file=/run/knowledge-governance/publisher.jwt
```

再次运行 `admission`，必须返回同一 active release。随后重新以正常依赖方式收敛服务：

```bash
docker compose --env-file .env -f docker-compose.example.yml up -d acquisition conversation-recovery
docker compose --env-file .env -f docker-compose.example.yml up -d app
```

只有 acquisition 和 app 都 ready、正式发布预检全部通过后，才启动或 reload Caddy。若
任何一步失败，保持公网未切流；不得把知识模式改为 preview，也不得直接修改 release 状态。

## 7. 后续知识更新

后续更新重复“新草稿 → 三个独立审核 → 新 official index → 绑定 → publisher 激活”，旧
active release 保持服务直到新 release 原子激活。不得在 active release 上原地替换目录、
索引文件或 manifest。回滚必须重新验证旧 release、旧 index 和当前运行镜像仍完全兼容。
