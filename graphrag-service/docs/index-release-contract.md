# GraphRAG 索引发布与知识 release 强绑定

## 生产结论

生产环境只允许 `HUAMEI_GRAPHRAG_ENGINE=official`，且必须显式设置
`HUAMEI_GRAPHRAG_INDEX_VERSION`。`auto` 和 `bootstrap` 仅用于本地开发、数据准入检查和
正式建图前的候选集验证，不是生产索引。

服务启动时会验证清单自身 SHA、Microsoft GraphRAG 五类必备产物 SHA、
模型配置指纹、知识包 SHA、批准记录集 SHA 与业务/医务/合规三审回执。
任何一项不完整或不一致，进程不会就绪。

查询必须同时传入 `tenant_id`、`release_id` 和 `index_version`。它们必须与已加载
清单完全一致，否则返回 409，不会退回到未审核索引。

Node本地fallback也执行相同的内容绑定，不是绕过正式索引的第二条信任路径：

- `rag/huamei-public-safe.jsonl`是唯一对客事实目录，也是Node fallback与GraphRAG的共同输入。Node仍可加载`rag/knowledge_units.jsonl`作内部检索，但不得从它派生、补写或覆盖公共目录。
- 公共目录对每条记录的`record_id`、`record_type`、`title`、`content`、`tags`、`source_relative_path`、`sensitivity`和`verification_note`重算完整canonical record SHA，并验证确定性的`text`字段；旧SHA、缺字段、重复ID、text不一致或混入非公共准入记录都会失败关闭。
- host知识包`package_checksum`是上述公共目录原始字节SHA-256。GraphRAG `--knowledge-package`必须是同一文件或逐字节相同的不可变副本；批准记录集SHA使用下文相同的排序后`record_id + record_content_sha256`规范JSON。
- 公共目录一旦进入三审，bootstrap与official构建器只验证并消费，不再截断正文、追加核验说明、重算字段或重新序列化。正式输入的任何变更都必须重新形成目录并重新三审。
- `enforce`模式下，Node必须同时匹配数据库active release的`package_checksum`、`record_list_checksum`和批准记录ID。任一不一致时，领域readiness降级，公共检索返回空，依赖知识事实的意图直接转人工；不得退回未绑定的本地项目知识回答。

## 正式索引清单

`graphrag_project/output/manifest.json` 使用
`huamei.graphrag.index-manifest.v1`，包含：

- `index_version`、`built_at`、Microsoft GraphRAG 版本与构建方法；
- 官方输入文件 SHA 和记录数；
- 租户、知识 `release_id`、知识包 SHA、批准记录集 SHA 和三审回执 SHA；
- `entities`、`relationships`、`communities`、`community_reports`、
  `text_units` 及向量库（存在时）的 SHA；
- 完整索引内容 SHA 和清单 SHA；
- 不含 API Key 的 completion/embedding 模型配置指纹。

`approved-record-list` 不能只有 record_id，每条必须同时包含
`record_content_sha256`。集合 SHA 是对按 record_id 排序后的两字段规范 JSON 计算，
因此记录内容变化也会阻断发布。

## 三审 release 回执

```json
{
  "schema_version": "huamei.knowledge.release-binding.v1",
  "tenant_id": "huamei-shanghai",
  "release_id": "kr_2026_09_001",
  "index_version": "huamei-official-20260901.1",
  "knowledge_package_sha256": "<64位小写SHA-256>",
  "approved_record_list_sha256": "<64位小写SHA-256>",
  "approvals": {
    "business": {"status": "approved", "review_id": "...", "reviewed_at": "2026-09-01T01:00:00Z"},
    "medical": {"status": "approved", "review_id": "...", "reviewed_at": "2026-09-01T02:00:00Z"},
    "compliance": {"status": "approved", "review_id": "...", "reviewed_at": "2026-09-01T03:00:00Z"}
  }
}
```

发布系统应以不可变文件导出该回执和批准记录集，不允许人工修改后继续构建。

## 构建命令

```bash
python graphrag-service/scripts/build_official_index.py \
  --project-root graphrag-service/graphrag_project \
  --version huamei-official-20260901.1 \
  --knowledge-package /immutable/releases/kr_2026_09_001/huamei-public-safe.jsonl \
  --approved-record-list /immutable/releases/kr_2026_09_001/approved-records.json \
  --release-binding /immutable/releases/kr_2026_09_001/release-binding.json
```

脚本在调用外部模型之前先验证：

1. 数据出域明示授权和模型环境变量齐全；
2. 官方输入的 `(record_id, record_content_sha256)` 与批准集完全相等；
3. `--knowledge-package`与项目`input/huamei-public-safe.jsonl`逐字节SHA一致，且知识包 SHA、批准集 SHA、索引版本与 release 回执一致；
4. 业务、医务、合规三个审批均为 `approved`。

构建完成后再对每个官方产物计算 SHA，最后原子替换清单。
脚本不允许覆盖已有 `manifest.json` 的版本；每次构建必须使用新的版本化工作目录。

开发契约测试`tests/huamei-knowledge-cross-runtime.mjs`会对仓库中的925条真实候选目录同时调用Node和Python校验器，要求目录原始字节SHA与批准记录集SHA完全一致；`graphrag-service/tests/test_build_bootstrap_index.py`则锁定建图前不得改变任何已审字段。它们是开发证据，不替代正式三审回执。

## 运行时配置

```dotenv
HUAMEI_ENVIRONMENT=production
HUAMEI_GRAPHRAG_ENGINE=official
HUAMEI_GRAPHRAG_INDEX_VERSION=huamei-official-20260901.1
HUAMEI_GRAPHRAG_OFFICIAL_PROJECT_ROOT=/service/graphrag_project
```

官方 `output/`、`settings.yaml` 和 `prompts/` 必须作为同一个不可变、只读的索引制品部署。
仓库的 `.dockerignore` 故意不打包本地 `output/`，避免把未审核或含密钥的建图目录带入通用镜像；
生产发布流程应在验证清单后将制品挂载到该路径。

## 仍需外部提供

- 获批的 completion 模型、embedding 模型、API endpoint/key 和足够的建图/查询配额；
- 数据出域、供应商留存/训练政策和费用预算的书面批准；
- 知识系统导出的不可变知识包、带内容 SHA 的批准记录集和三审回执；
- 生产发布制品存储和只读挂载路径。
