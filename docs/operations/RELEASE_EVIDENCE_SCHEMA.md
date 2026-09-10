# 华美一期正式发布证据契约

版本：2.1
更新日期：2026-08-26

`evaluation.json`和`capacity.json`是生产发布门禁的正式输入，不是开发回归日志。它们必须在预生产或生产环境，使用待发布的完整镜像digest、真实模型、正式配额和当前待激活索引生成。未知字段可保留，本文列出的字段、签名和职责边界不得缺失。

## 1. 版本和证据链

正式最终报告使用：

- `huamei.production-evaluation-evidence.v3`；
- `huamei.production-capacity-evidence.v2`。

每份原始证据和最终报告都包含`execution_attestation`。该签名包装层使用独立版本`huamei.formal-evidence-attestation.v1`；它与最终报告的业务schema不是同一个版本号，不得将attestation擅自改写为评测v3或容量v2。

正式证据链共有7类Ed25519签名证据：

| `evidence_kind` | 证据 | 信任注册表`authority_role` | 责任边界 |
| --- | --- | --- | --- |
| `blind_dataset` | 独立盲测集 | `quality_custodian` | 盲测保管人封存，不参与开发调优 |
| `evaluation_raw` | 逐题真实调用原始输出 | `qa_execution` | 独立评测执行人固定环境和运行结果 |
| `evaluation_scorecard` | 实名盲审评分卡 | `review_board` | 评审组封存逐题评分与三角色批准 |
| `evaluation_report` | 最终评测v3报告 | `formal_evidence_issuer` | 评测证据签发人验签来源后签发最终报告 |
| `capacity_raw` | 20并发持续压测原始报告 | `load_runner` | 压测执行人固定原始计数和时间窗口 |
| `capacity_observability_attestation` | 监控/配额证明 | `sre_observability` | SRE/模型平台人员独立封存Prometheus和配额证明 |
| `capacity_report` | 最终容量v2报告 | `formal_evidence_issuer` | 容量证据签发人验签来源后签发最终报告 |

容量链还包含1份`huamei.prometheus-capacity-export.v1`原始导出。它不是第8类签名证据，但必须以外置绝对路径和SHA-256提供，并被已签名的`capacity_observability_attestation` v2及最终容量报告同时绑定。`capacity_raw`必须使用`huamei.load.soak.v2`，监控证明必须使用`huamei.production-capacity-attestation.v2`。正式多样性还需独立的`huamei.formal-load-taxonomy-manifest.v1`控制制品：它由`formal_load_taxonomy_approver` Ed25519签名，不计入上述7类证据职责，但其文件SHA、签名人、signed payload SHA、catalog SHA及使用计数必须进入raw、Prometheus、SRE attestation和最终容量报告的同一绑定链。

生产注册表应为7类证据分配7个不同的`signer_id`和7把不同的Ed25519公钥。两个最终签发职责虽共用`formal_evidence_issuer`角色类型，仍应使用不同身份和密钥。验签器会从实际SPKI DER重算`public_key_spki_sha256`，最终化执行器分别阻断链内身份或公钥重复，发布预检再对7份证据做全局唯一性校验；同一公钥注册成多个alias仍会失败关闭，不能用不同字符串伪装职责独立。

## 2. Ed25519 `execution_attestation`

签名字段的最小结构：

```json
{
  "execution_attestation": {
    "schema_version": "huamei.formal-evidence-attestation.v1",
    "evidence_kind": "evaluation_report",
    "signer_id": "evaluation-issuer-001",
    "signature_algorithm": "ed25519",
    "signed_payload_sha256": "<64-hex>",
    "signed_at": "2026-08-26T05:00:00.000Z",
    "signature_base64": "<64-byte-ed25519-signature-as-base64>"
  }
}
```

签名payload使用确定性JSON字节，同时保护：

- 除`execution_attestation`外的完整证据文档；
- `evidence_kind`、`signer_id`和`signed_at`；
- 固定算法`ed25519`和attestation schema。

签名后修改报告数值、来源签名人摘要、证据类型或签署时间，都会导致payload SHA或Ed25519验签失败。

## 3. 外置可信签名人注册表

`HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64`是外置、受变更审批的JSON注册表之Base64表示。它只能包含公钥和授权元数据，不是私钥容器：

```json
{
  "quality-custodian-001": {
    "authority_role": "quality_custodian",
    "allowed_kinds": ["blind_dataset"],
    "public_key_spki_der_base64": "<ed25519-spki-der-base64>"
  },
  "qa-execution-001": {
    "authority_role": "qa_execution",
    "allowed_kinds": ["evaluation_raw"],
    "public_key_spki_der_base64": "<ed25519-spki-der-base64>"
  },
  "review-board-001": {
    "authority_role": "review_board",
    "allowed_kinds": ["evaluation_scorecard"],
    "public_key_spki_der_base64": "<ed25519-spki-der-base64>"
  },
  "evaluation-issuer-001": {
    "authority_role": "formal_evidence_issuer",
    "allowed_kinds": ["evaluation_report"],
    "public_key_spki_der_base64": "<ed25519-spki-der-base64>"
  },
  "load-runner-001": {
    "authority_role": "load_runner",
    "allowed_kinds": ["capacity_raw"],
    "public_key_spki_der_base64": "<ed25519-spki-der-base64>"
  },
  "sre-observability-001": {
    "authority_role": "sre_observability",
    "allowed_kinds": ["capacity_observability_attestation"],
    "public_key_spki_der_base64": "<ed25519-spki-der-base64>"
  },
  "capacity-issuer-001": {
    "authority_role": "formal_evidence_issuer",
    "allowed_kinds": ["capacity_report"],
    "public_key_spki_der_base64": "<ed25519-spki-der-base64>"
  }
}
```

注册表必须由证据制品之外的安全/发布控制面管理，不得从待验证报告自动导入公钥。验签时以解析后的SPKI DER计算SHA-256，不信任注册表或报告自报的指纹。新增、轮换或撤销签名人必须有变更单、双人复核、生效时间和旧证据保留策略，并先检查7个SPKI指纹互异。

## 4. 两份最终报告的共同字段

| 字段 | 约束 |
| --- | --- |
| `schema_version` | 分别为上述evaluation v3 / capacity v2 schema |
| `release_id` | 必须等于`HUAMEI_RELEASE_ID` |
| `environment` | 只能是`preproduction`或`production` |
| `generated_at` | 有效ISO-8601时间 |
| `application_image` | 完整应用镜像`@sha256:<digest>`，必须等于待发布配置 |
| `graphrag_image` | 完整GraphRAG镜像`@sha256:<digest>`，必须等于待发布配置 |
| `index_version` | 必须等于`HUAMEI_GRAPHRAG_INDEX_VERSION` |
| `knowledge_manifest_sha256` | 64位小写SHA-256，必须与active release及GraphRAG `/ready`一致 |
| `active_knowledge` | `release_id`、`index_version`、`manifest_sha256`与数据库active release一致，`engine=official_graphrag_3_1_1` |
| `passed` | 必须为`true` |
| `llm` | `enabled=true`，provider/model与待发布生产配置一致 |
| `approval` | `status=approved`，有`approval_id`、`approved_by`、`approved_at` |
| `verified_sources` | 最终报告签发前已用外置注册表验签的来源摘要 |
| `execution_attestation` | 最终报告签发人的Ed25519签名 |

两份文件分别命名为`evaluation.json`和`capacity.json`，放入`HUAMEI_RELEASE_EVIDENCE_HOST_PATH`。发布配置还要分别登记签名后文件的SHA-256；门禁先验文件哈希，再验签和内容绑定。

### 4.1 正式评测endpoint注册表

endpoint注册表是发布控制面输入，不是第8类签名证据，也不得由评测命令的`--service-url`或应用运行时的普通服务地址自动生成。控制面以绝对路径只读挂载，并独立登记文件SHA-256。最低结构如下：

```json
{
  "schema_version": "huamei.formal-evaluation-endpoint-registry.v1",
  "registry_id": "formal-evaluation-endpoints-2026-08-26",
  "generated_at": "2026-08-26T01:00:00.000Z",
  "approval": {
    "status": "approved",
    "approval_id": "endpoint-registry-approval-001",
    "approved_by": "release-platform-owner-001",
    "approved_at": "2026-08-26T01:05:00.000Z"
  },
  "endpoints": [{
    "entry_id": "huamei-preproduction-acquisition-001",
    "active": true,
    "tenant_id": "huamei-shanghai",
    "environment": "preproduction",
    "origin": "https://preprod.huamei.example.com",
    "deployment_id": "huamei-preprod-deployment-2026-08-26-001",
    "release_id": "2026.08.26-r1",
    "knowledge_release_id": "krel-2026-08-26",
    "application_image": "registry.example/huamei-app@sha256:<64-hex>",
    "graphrag_image": "registry.example/huamei-graphrag@sha256:<64-hex>",
    "index_version": "index-2026-08-26.1",
    "knowledge_manifest_sha256": "<64-hex>",
    "service": "huamei-acquisition-agent",
    "service_version": "2.1.0"
  }]
}
```

一个`tenant_id + environment`只能有一个启用条目。origin必须是无路径、无查询、无fragment、无凭据的规范化HTTPS origin；localhost、单标签/内部域名、私网、链路本地、保留IP和任何重定向均拒绝。正式执行、最终化和发布预检分别从同一文件SHA重新解析，并把目标摘要写入或核对`evaluation_target`。

## 5. 正式评测v3报告

```json
{
  "schema_version": "huamei.production-evaluation-evidence.v3",
  "release_id": "2026.08.26-r1",
  "environment": "preproduction",
  "generated_at": "2026-08-26T04:00:00.000Z",
  "application_image": "registry.example/huamei-app@sha256:<64-hex>",
  "graphrag_image": "registry.example/huamei-graphrag@sha256:<64-hex>",
  "index_version": "index-2026-08-26.1",
  "knowledge_manifest_sha256": "<64-hex>",
  "active_knowledge": {
    "release_id": "krel-2026-08-26",
    "index_version": "index-2026-08-26.1",
    "manifest_sha256": "<64-hex>",
    "engine": "official_graphrag_3_1_1"
  },
  "evaluation_target": {
    "registry_schema_version": "huamei.formal-evaluation-endpoint-registry.v1",
    "registry_id": "formal-evaluation-endpoints-2026-08-26",
    "registry_sha256": "<64-hex>",
    "entry_id": "huamei-preproduction-acquisition-001",
    "origin": "https://preprod.huamei.example.com",
    "tenant_id": "huamei-shanghai",
    "environment": "preproduction",
    "deployment_id": "huamei-preprod-deployment-2026-08-26-001",
    "release_id": "2026.08.26-r1",
    "knowledge_release_id": "krel-2026-08-26",
    "application_image": "registry.example/huamei-app@sha256:<64-hex>",
    "graphrag_image": "registry.example/huamei-graphrag@sha256:<64-hex>",
    "index_version": "index-2026-08-26.1",
    "knowledge_manifest_sha256": "<64-hex>",
    "service": "huamei-acquisition-agent",
    "service_version": "2.1.0"
  },
  "dataset_sha256": "<64-hex>",
  "case_count": 3240,
  "verified_sources": {
    "blind_dataset": {
      "signer_id": "quality-custodian-001",
      "evidence_kind": "blind_dataset",
      "authority_role": "quality_custodian",
      "public_key_spki_sha256": "<64-hex>",
      "signed_payload_sha256": "<64-hex>",
      "signed_at": "2026-08-26T01:00:00.000Z"
    },
    "evaluation_raw": {
      "signer_id": "qa-execution-001",
      "evidence_kind": "evaluation_raw",
      "authority_role": "qa_execution",
      "public_key_spki_sha256": "<64-hex>",
      "signed_payload_sha256": "<64-hex>",
      "signed_at": "2026-08-26T02:00:00.000Z"
    },
    "evaluation_scorecard": {
      "signer_id": "review-board-001",
      "evidence_kind": "evaluation_scorecard",
      "authority_role": "review_board",
      "public_key_spki_sha256": "<64-hex>",
      "signed_payload_sha256": "<64-hex>",
      "signed_at": "2026-08-26T03:00:00.000Z"
    }
  },
  "llm": { "enabled": true, "provider": "approved-provider", "model": "approved-model" },
  "acceptance": { "passed": true },
  "approval": {
    "status": "approved",
    "approval_id": "go-live-eval-2026-08-26",
    "approved_by": "release-owner-001",
    "approved_at": "2026-08-26T05:00:00.000Z"
  },
  "passed": true,
  "execution_attestation": {
    "schema_version": "huamei.formal-evidence-attestation.v1",
    "evidence_kind": "evaluation_report",
    "signer_id": "evaluation-issuer-001",
    "signature_algorithm": "ed25519",
    "signed_payload_sha256": "<64-hex>",
    "signed_at": "2026-08-26T05:01:00.000Z",
    "signature_base64": "<base64>"
  }
}
```

`dataset_sha256`是本次实际运行的、已由`quality_custodian`签名的独立盲测集哈希。`acceptance.passed`必须来自立项验收口径，不得用单元测试通过数替代。

## 6. 真实20人容量v2报告

```json
{
  "schema_version": "huamei.production-capacity-evidence.v2",
  "release_id": "2026.08.26-r1",
  "environment": "preproduction",
  "generated_at": "2026-08-26T04:00:00.000Z",
  "application_image": "registry.example/huamei-app@sha256:<64-hex>",
  "graphrag_image": "registry.example/huamei-graphrag@sha256:<64-hex>",
  "index_version": "index-2026-08-26.1",
  "knowledge_manifest_sha256": "<64-hex>",
  "raw_report_path": "/evidence/capacity-raw.json",
  "raw_report_sha256": "<64-hex>",
  "prometheus_export_path": "/evidence/capacity-prometheus.json",
  "prometheus_export_sha256": "<64-hex>",
  "attestation_sha256": "<64-hex>",
  "active_knowledge": {
    "release_id": "krel-2026-08-26",
    "index_version": "index-2026-08-26.1",
    "manifest_sha256": "<64-hex>",
    "engine": "official_graphrag_3_1_1",
    "attempt_count": 10000,
    "success_count": 9990,
    "success_rate": 0.999,
    "cache_miss_count": 9500,
    "cache_miss_ratio": 0.95
  },
  "verified_sources": {
    "capacity_raw": {
      "signer_id": "load-runner-001",
      "evidence_kind": "capacity_raw",
      "authority_role": "load_runner",
      "public_key_spki_sha256": "<64-hex>",
      "signed_payload_sha256": "<64-hex>",
      "signed_at": "2026-08-26T04:10:00.000Z"
    },
    "capacity_observability_attestation": {
      "signer_id": "sre-observability-001",
      "evidence_kind": "capacity_observability_attestation",
      "authority_role": "sre_observability",
      "public_key_spki_sha256": "<64-hex>",
      "signed_payload_sha256": "<64-hex>",
      "signed_at": "2026-08-26T04:20:00.000Z"
    }
  },
  "llm": { "enabled": true, "provider": "approved-provider", "model": "approved-model", "attempt_count": 10000, "success_count": 9990, "success_rate": 0.999 },
  "graphrag_query_model": { "provider": "approved-graph-provider", "model": "approved-graph-query-model", "attempt_count": 9500, "success_count": 9490, "attempt_coverage": 1, "success_rate": 0.998947 },
  "formal_load_taxonomy": { "manifest_id": "formal-load-taxonomy-2026-08-26-a", "manifest_sha256": "<64-hex>", "signer_id": "taxonomy-approver-001", "signed_payload_sha256": "<64-hex>", "catalog_sha256": "<64-hex>", "algorithm_version": "factoradic-token-permutation.v1", "applied": 10000, "rejected": 0, "application_ratio": 1, "distinct_entry_count": 10000, "entry_ids_sha256": "<64-hex>" },
  "concurrent_users": 20,
  "duration_seconds": 1800,
  "provider_quota": {
    "approved": true,
    "provider": "approved-provider",
    "model": "approved-model",
    "requests_per_minute": 2000,
    "tokens_per_minute": 2000000
  },
  "graphrag_provider_quota": {
    "approved": true,
    "provider": "approved-graph-provider",
    "model": "approved-graph-query-model",
    "requests_per_minute": 2000,
    "tokens_per_minute": 2000000
  },
  "acceptance": { "passed": true },
  "approval": {
    "status": "approved",
    "approval_id": "go-live-capacity-2026-08-26",
    "approved_by": "release-owner-001",
    "approved_at": "2026-08-26T05:00:00.000Z"
  },
  "passed": true,
  "execution_attestation": {
    "schema_version": "huamei.formal-evidence-attestation.v1",
    "evidence_kind": "capacity_report",
    "signer_id": "capacity-issuer-001",
    "signature_algorithm": "ed25519",
    "signed_payload_sha256": "<64-hex>",
    "signed_at": "2026-08-26T05:01:00.000Z",
    "signature_base64": "<base64>"
  }
}
```

必须至少20并发用户、稳态持续1,800秒，并包含持续的真实应用LLM、official GraphRAG和GraphRAG查询LLM调用。两条模型链路尝试覆盖率均至少95%、尝试成功率均至少99%，缓存未命中率和查询多样性均至少95%。正式请求的taxonomy applied必须与请求数相等，rejected必须为0，distinct entry必须与请求数相等，且全部副本指标必须聚合取证。`provider_quota`和`graphrag_provider_quota`必须分别覆盖Prometheus重算的RPM/TPM峰值。关闭LLM、瞬时20请求、大量命中缓存、复用entry或转入人工回执循环都不满足本契约。

## 7. 密钥、签发和验签边界

- Ed25519私钥只允许在受控证据runner中以短时、只读文件挂载，或由KMS/HSM代理向短时文件接口提供。当前CLI读取的是绝对路径，不接收命令行私钥或Base64私钥值。
- 私钥不得进入Git、镜像层、通用`.env`、Compose长期服务environment、CI日志、工单或报告。签名完成后卸载密钥，清理runner工作目录中的短时副本。
- `HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64`只是公钥注册表，由受控控制面注入最终化执行器和一次性`release-preflight`；不注入app、acquisition、GraphRAG、worker或canary长期服务。
- 最终报告签名后再计算文件SHA-256，分别写入`HUAMEI_RELEASE_EVALUATION_REPORT_SHA256`和`HUAMEI_RELEASE_CAPACITY_REPORT_SHA256`。
- `production-release-preflight`按外置绝对路径和已登记SHA读取8份真实文件：7份已签名证据和1份Prometheus原始导出。任一文件缺失、路径非绝对或SHA不一致都会失败关闭。
- 预检重新验证7份Ed25519签名、全局职责和SPKI指纹独立性，并对容量raw、Prometheus导出和attestation重新运行内容校验。重算的raw完整sanitized-query SHA列表、telemetry跨副本聚合计数、应用LLM、GraphRAG、GraphRAG查询LLM和两套配额必须与最终报告逐字段一致。Prometheus per-query-hash标签只作有界诊断，不是正式多样性证据；最终化阶段的验签或摘要不能代替发布预检的独立复验。

## 8. NO-GO条件

以下任一情况必须`NO-GO`：

- 任一文件SHA不匹配，任一所需`execution_attestation`缺失或Ed25519验签失败。
- 签名人不在外置注册表、`authority_role`不匹配，或`allowed_kinds`未授权当前证据类型。
- 7份证据中任意`signer_id`重复、任意SPKI DER SHA-256公钥指纹重复（包括同一key多alias），或注册表授权角色/证据类型与实际职责不一致。
- 报告仍是v1，或release、任一镜像digest、index、manifest、provider或model不匹配。
- 评测集没有SHA/保管人签名，或报告没有发布负责人批准。
- endpoint注册表不是外置绝对路径、文件SHA不匹配、`tenant + environment`不能唯一定位目标，或origin为HTTP、localhost、私网/内部地址；raw、最终报告和发布预检任一层的注册表SHA、规范化origin、entry ID或部署ID不一致。
- 正式评测发生任意HTTP重定向、响应最终URL不可核验或偏离注册表exact origin；命令行`--service-url`及普通服务URL环境变量不得替代受信注册表。
- 应用LLM或GraphRAG查询LLM未持续使用，容量测试少于20人/30分钟，尝试覆盖率低于95%，成功率低于99%，缓存未命中或查询多样性低于95%，或任一模型RPM/TPM配额未批准。
- taxonomy manifest未经外置SHA+Ed25519审批、任一tenant/release/index/catalog/时窗绑定错配、普通公网caller拥有`formal-load:execute`或通配权限、请求携带query/nonce，任一entry复用/拒绝，或仅使用单副本计数。
- 签名私钥出现在Compose长期服务、通用部署`.env`、镜像、日志或证据制品中。
