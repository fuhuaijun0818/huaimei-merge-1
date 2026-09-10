import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [dockerfile, dockerignore, graphDockerfile, compose, canary, formalCapacityCompose, caddy, stopAi, runbook, evidenceContract, prometheus, acquisitionTargets, outboxTargets, graphTargets] = await Promise.all([
  read("Dockerfile"),
  read(".dockerignore"),
  read("graphrag-service/Dockerfile"),
  read("deploy/docker-compose.example.yml"),
  read("deploy/docker-compose.canary.example.yml"),
  read("deploy/docker-compose.formal-capacity.example.yml"),
  read("deploy/Caddyfile"),
  read("deploy/Caddyfile.stop-ai"),
  read("docs/operations/PRODUCTION_DEPLOYMENT_RUNBOOK.md"),
  read("docs/operations/RELEASE_EVIDENCE_SCHEMA.md"),
  read("deploy/observability/prometheus.yml.example"),
  read("deploy/observability/targets.example.json"),
  read("deploy/observability/outbox-targets.example.json"),
  read("deploy/observability/graphrag-targets.example.json")
]);

assert.match(dockerfile, /npm ci --omit=dev/, "运行镜像必须安装锁定的生产依赖");
assert.match(dockerfile, /COPY --from=node-dependencies[^\n]*\/build\/runtime\/node_modules \.\/node_modules/, "运行镜像必须包含生产 node_modules");
assert.match(dockerfile, /COPY[^\n]* scripts \.\/scripts/, "镜像必须包含发布和迁移脚本");
assert.match(dockerfile, /COPY[^\n]* db \.\/db/, "镜像必须包含不可变迁移库");
assert.match(dockerfile, /COPY[^\n]* config \.\/config/, "镜像必须包含服务端固定安全taxonomy catalog");
assert.match(dockerignore, /!config\/\s*[\s\S]*!config\/formal-load-taxonomy-catalog\.v1\.json/,
  "Docker构建上下文必须精确放行固定安全taxonomy catalog");
assert.match(graphDockerfile, /LITELLM_LOCAL_MODEL_COST_MAP=True/, "GraphRAG镜像必须禁止LiteLLM隐式下载cost map");

for (const imageVariable of ["HUAMEI_APP_IMAGE", "HUAMEI_GRAPHRAG_IMAGE", "HUAMEI_POSTGRES_IMAGE", "HUAMEI_REDIS_IMAGE", "HUAMEI_CADDY_IMAGE"]) {
  assert.match(compose, new RegExp(`\\$\\{${imageVariable}:\\?`), `${imageVariable}必须由发布人显式注入`);
}
assert.match(compose, /conversation-recovery:/, "生产编排必须启动会话收件恢复worker");
assert.match(compose, /conversation-recovery:[\s\S]*HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN:[\s\S]*healthcheck:[\s\S]*127\.0\.0\.1:9191\/readyz/, "会话恢复worker必须有独立token与持久成功/数据库健康探针");
assert.match(compose, /release-preflight:[\s\S]*HUAMEI_CONVERSATION_RECOVERY_METRICS_TOKEN:[\s\S]*HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_PATH:\s*\/release-target\/evaluation-endpoints\.json[\s\S]*HUAMEI_FORMAL_EVALUATION_ENDPOINT_REGISTRY_SHA256:[\s\S]*evaluation-endpoints\.json:ro/, "发布预检必须使用独立recovery token并只读挂载可信正式评测目标注册表");
assert.match(compose, /outbox:[\s\S]*profiles: \["external-events"\]/, "Outbox必须默认关闭并显式启用");
assert.match(compose, /HUAMEI_OUTBOX_TARGET_URL: "\$\{HUAMEI_OUTBOX_TARGET_URL:\?/, "Outbox不得伪造事件接收端");
assert.match(compose, /release-preflight:[\s\S]*profiles: \["release-check"\]/, "生产编排必须提供一次性发布门禁");
assert.match(compose, /HUAMEI_LLM_ENABLED: "true"/, "正式服务不得以rules-only模式发布");
assert.match(compose, /HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:\s+"\$\{HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:\?/, "生产必须注入字段加密keyring");
assert.doesNotMatch(compose, /HUAMEI_CONTACT_(?:OTP_ADAPTER|VERIFICATION)_/, "稳定编排不应再要求短信OTP或联系方式所有权令牌");
assert.doesNotMatch(canary, /HUAMEI_CONTACT_(?:OTP_ADAPTER|VERIFICATION)_/, "灰度编排不应再要求短信OTP或联系方式所有权令牌");
assert.ok((compose.match(/HUAMEI_PRIVACY_VERIFICATION_SECRET:\s+"\$\{HUAMEI_PRIVACY_VERIFICATION_SECRET:\?/g) || []).length >= 3, "稳定app、acquisition与发布预检必须注入DSR可信身份核验密钥");
assert.ok((compose.match(/HUAMEI_PRIVACY_COMPLETION_SECRET:\s+"\$\{HUAMEI_PRIVACY_COMPLETION_SECRET:\?/g) || []).length >= 3, "稳定app、acquisition与发布预检必须注入独立DSR执行/交付密钥");
assert.ok((compose.match(/HUAMEI_PRIVACY_CANCELLATION_SECRET:\s+"\$\{HUAMEI_PRIVACY_CANCELLATION_SECRET:\?/g) || []).length >= 3, "稳定app、acquisition与发布预检必须注入独立DSR主体撤回签名密钥");
assert.ok((canary.match(/HUAMEI_PRIVACY_VERIFICATION_SECRET:\s+"\$\{HUAMEI_PRIVACY_VERIFICATION_SECRET:\?/g) || []).length >= 2, "灰度app与acquisition必须注入DSR可信身份核验密钥");
assert.ok((canary.match(/HUAMEI_PRIVACY_COMPLETION_SECRET:\s+"\$\{HUAMEI_PRIVACY_COMPLETION_SECRET:\?/g) || []).length >= 2, "灰度app与acquisition必须注入独立DSR执行/交付密钥");
assert.ok((canary.match(/HUAMEI_PRIVACY_CANCELLATION_SECRET:\s+"\$\{HUAMEI_PRIVACY_CANCELLATION_SECRET:\?/g) || []).length >= 2, "灰度app与acquisition必须注入独立DSR主体撤回签名密钥");
assert.match(compose, /HUAMEI_RELEASE_CAPACITY_REPORT_SHA256:/, "发布门禁必须绑定容量报告SHA");
assert.match(compose, /LITELLM_LOCAL_MODEL_COST_MAP: "True"/, "生产GraphRAG必须使用本地cost map");
assert.match(compose, /graphrag:[\s\S]*HUAMEI_GRAPHRAG_METRICS_TOKEN: "\$\{HUAMEI_GRAPHRAG_METRICS_TOKEN:\?/, "生产GraphRAG必须注入独立metrics token");
assert.match(canary, /graphrag-canary:[\s\S]*HUAMEI_GRAPHRAG_METRICS_TOKEN: "\$\{HUAMEI_CANARY_GRAPHRAG_METRICS_TOKEN:\?/, "灰度GraphRAG必须使用独立metrics token");
assert.doesNotMatch(compose, /\benv_file\s*:/, "生产服务不得共享包含全栈秘密的env_file");
assert.doesNotMatch(canary, /\benv_file\s*:/, "灰度服务不得共享包含全栈秘密的env_file");
assert.match(compose, /HUAMEI_FORMAL_EVIDENCE_TRUSTED_SIGNERS_B64:/, "发布门禁必须注入外置可信证据签名人注册表");
assert.match(compose, /acquisition:[\s\S]*HUAMEI_FORMAL_LOAD_TAXONOMY_ENABLED:\s*"false"/, "普通生产acquisition必须默认关闭正式taxonomy压测通道");
assert.match(canary, /acquisition-canary:[\s\S]*HUAMEI_FORMAL_LOAD_TAXONOMY_ENABLED:\s*"false"/, "普通灰度也必须默认关闭正式taxonomy压测通道");
assert.match(formalCapacityCompose, /HUAMEI_FORMAL_LOAD_TAXONOMY_ENABLED:\s*"true"/, "只有独立正式容量override可启taxonomy通道");
assert.match(formalCapacityCompose, /HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256:[^\n]*\?/, "正式容量override必须显式绑定manifest SHA");
assert.match(formalCapacityCompose, /HUAMEI_FORMAL_LOAD_TAXONOMY_TRUSTED_SIGNERS_B64:[^\n]*\?/, "正式容量override必须显式注入Ed25519信任注册表");
assert.match(formalCapacityCompose, /taxonomy-manifest\.json:ro/, "正式容量manifest必须只读挂载");
assert.doesNotMatch(formalCapacityCompose, /SIGNING_KEY|PRIVATE_KEY/, "正式容量override不得挂载签名私钥");
for (const sourceDigest of [
  "HUAMEI_FORMAL_BLIND_DATASET_SHA256",
  "HUAMEI_FORMAL_EVALUATION_RAW_SHA256",
  "HUAMEI_FORMAL_EVALUATION_SCORECARD_SHA256",
  "HUAMEI_FORMAL_CAPACITY_RAW_SHA256",
  "HUAMEI_FORMAL_CAPACITY_ATTESTATION_SHA256"
]) {
  assert.match(compose, new RegExp(`${sourceDigest}:`), `发布门禁必须绑定真实源文件：${sourceDigest}`);
}
assert.match(compose, /HUAMEI_FORMAL_CAPACITY_PROMETHEUS_PATH: \/release-evidence\/capacity-prometheus-export\.json/, "发布门禁必须只读挂载原始Prometheus容量导出");
assert.match(compose, /HUAMEI_FORMAL_CAPACITY_PROMETHEUS_SHA256: "\$\{HUAMEI_FORMAL_CAPACITY_PROMETHEUS_SHA256:\?/, "发布门禁必须绑定Prometheus容量导出SHA");
assert.doesNotMatch(compose, /HUAMEI_FORMAL_[A-Z_]*SIGNING_KEY_PATH\s*:/, "Compose长期服务和一次性预检都不得挂载证据签名私钥");
assert.doesNotMatch(canary, /HUAMEI_FORMAL_[A-Z_]*SIGNING_KEY_PATH\s*:/, "灰度服务不得挂载证据签名私钥");
assert.match(compose, /HUAMEI_PUBLIC_GATEWAY_ENABLED: "true"[\s\S]*HUAMEI_TRUST_PROXY: "true"[\s\S]*HUAMEI_TRUSTED_PROXY_ADDRESSES:/, "公网网关必须显式信任固定的立即反向代理地址");
assert.match(compose, /HUAMEI_EXTERNAL_DEPENDENCY_READINESS_MAX_AGE_MS: "20000"/, "生产服务必须定期重新主动探测模型与GraphRAG上游");
assert.match(compose, /HUAMEI_EXTERNAL_DEPENDENCY_PROBE_TIMEOUT_MS: "4000"/, "外部依赖探测必须有短超时边界");
assert.match(compose, /HUAMEI_GRAPHRAG_READINESS_RECORD_ID: "\$\{HUAMEI_GRAPHRAG_READINESS_RECORD_ID:\?/, "生产GraphRAG就绪探针必须绑定已批准的固定记录");
assert.match(canary, /HUAMEI_GRAPHRAG_READINESS_RECORD_ID: "\$\{HUAMEI_GRAPHRAG_READINESS_RECORD_ID:\?/, "灰度GraphRAG就绪探针不得降低为空证据可达性检查");
assert.match(compose, /HUAMEI_KNOWLEDGE_PUBLIC_SAFE_CATALOG: \/knowledge\/rag\/huamei-public-safe\.jsonl/, "生产Node fallback必须固定到与GraphRAG相同的公共安全目录");
assert.match(canary, /HUAMEI_KNOWLEDGE_PUBLIC_SAFE_CATALOG: \/knowledge\/rag\/huamei-public-safe\.jsonl/, "灰度Node fallback必须固定到与GraphRAG相同的公共安全目录");
assert.match(compose, /proxy:[\s\S]*ipv4_address: "\$\{HUAMEI_CADDY_PROXY_IP/, "Caddy必须位于独立代理网络并使用固定地址");
assert.match(compose, /acquisition:[\s\S]*HUAMEI_METRICS_TOKEN: "\$\{HUAMEI_ACQUISITION_METRICS_TOKEN:\?/, "生产acquisition必须注入独立metrics token，否则会在listen前失败");
assert.match(canary, /acquisition-canary:[\s\S]*HUAMEI_METRICS_TOKEN: "\$\{HUAMEI_CANARY_ACQUISITION_METRICS_TOKEN:\?/, "canary acquisition必须注入独立metrics token");
assert.match(compose, /outbox:[\s\S]*HUAMEI_METRICS_TOKEN: "\$\{HUAMEI_OUTBOX_METRICS_TOKEN:\?/, "Outbox必须注入独立metrics token");
assert.match(compose, /outbox:[\s\S]*HUAMEI_OBSERVABILITY_HOST: 0\.0\.0\.0[\s\S]*HUAMEI_OBSERVABILITY_ALLOW_NON_LOOPBACK: "true"[\s\S]*expose:\s*\n\s*- "9190"/, "Outbox指标必须仅在内部backend网络可采集");
assert.match(compose, /outbox:[\s\S]*healthcheck:[\s\S]*127\.0\.0\.1:9190\/readyz[\s\S]*HUAMEI_METRICS_TOKEN/, "Outbox必须提供带独立token的存活/就绪探针");
assert.match(compose, /knowledge-governance:[\s\S]*profiles: \["knowledge-governance"\][\s\S]*entrypoint: \["node", "scripts\/knowledge-governance-cli\.mjs"\][\s\S]*condition: service_started/, "首次知识激活必须有不依赖ready的私有一次性控制器");
const governanceService = compose.slice(compose.indexOf("  knowledge-governance:"), compose.indexOf("  conversation-recovery:"));
assert.doesNotMatch(governanceService, /ports:/, "知识治理控制器不得暴露主机端口");
assert.match(governanceService, /HUAMEI_KNOWLEDGE_GOVERNANCE_INPUT_ROOT: \/run\/knowledge-governance[\s\S]*:ro"/, "知识治理凭据和payload必须来自受限只读目录");
assert.match(acquisitionTargets, /"acquisition:4180"/, "Prometheus必须使用真实acquisition服务DNS");
assert.match(outboxTargets, /"outbox:9190"/, "Prometheus必须使用真实outbox服务DNS");
assert.match(graphTargets, /"graphrag:4191"/, "Prometheus必须抓取真实GraphRAG服务DNS");
assert.doesNotMatch(`${acquisitionTargets}\n${outboxTargets}\n${graphTargets}`, /acquisition-service|outbox-worker|graphrag-service/, "监控目标不得引用不存在的Compose别名");
assert.match(prometheus, /huamei_acquisition_metrics_token[\s\S]*huamei_graphrag_metrics_token[\s\S]*huamei_outbox_metrics_token/, "Prometheus必须为acquisition、GraphRAG和outbox使用不同凭据");
assert.match(canary, /profiles: \["canary"\]/, "灰度服务必须显式启用");
assert.match(canary, /HUAMEI_CANARY_APP_IMAGE:\?/, "灰度镜像必须独立指定digest");

assert.match(caddy, /admin 127\.0\.0\.1:2019/, "Caddy admin只能绑定容器loopback以便安全reload");
assert.match(compose, /HUAMEI_EDGE_BIND_ADDRESS:\?[^}]*\}:\$\{PUBLIC_HTTP_PORT/, "Caddy HTTP端口必须绑定显式私有edge地址");
assert.match(compose, /HUAMEI_EDGE_BIND_ADDRESS:\?[^}]*\}:\$\{PUBLIC_HTTPS_PORT/, "Caddy HTTPS端口必须绑定显式私有edge地址");
assert.doesNotMatch(compose, /- "?\$\{PUBLIC_(?:HTTP|HTTPS)_PORT[^\n]*:(?:80|443)"?/, "生产边缘端口不得默认发布到0.0.0.0");
assert.match(caddy, /header X-Huamei-Canary \{\$HUAMEI_CANARY_TOKEN\}/, "灰度只能由受控header进入");
assert.match(caddy, /header_up X-Forwarded-For \{http\.request\.remote\.host\}/, "Caddy必须覆盖调用方伪造的X-Forwarded-For");
assert.match(caddy, /@customer path[^\n]*\/advisor[^\n]*\/api\/public\/\*/, "公众顾问页面和公开API必须有独立路由");
const customerRoute = caddy.slice(caddy.indexOf("@customer path"), caddy.indexOf("{$ADMIN_SITE_ADDRESS}"));
assert.doesNotMatch(customerRoute, /basic_auth/, "公众入口不得复用管理Basic凭据");
assert.match(customerRoute, /respond "Not Found" 404/, "客户域名不得回退到管理应用");
const adminRoute = caddy.slice(caddy.indexOf("{$ADMIN_SITE_ADDRESS}"));
assert.match(adminRoute, /external OIDC authorization-code\/PKCE proxy[\s\S]*reverse_proxy app:4173/, "管理应用必须明确依赖受支持的OIDC PKCE身份代理");
assert.doesNotMatch(adminRoute, /basic_auth/, "生产管理域不得用Basic覆盖代理注入的Bearer");
assert.match(compose, /app:[\s\S]*HUAMEI_ADMIN_BROWSER_AUTH_MODE: external_oidc_pkce_proxy[\s\S]*HUAMEI_ADMIN_IDENTITY_PROXY_SESSION_BACKEND: redis[\s\S]*HUAMEI_ADMIN_IDENTITY_PROXY_PRODUCT:[\s\S]*HUAMEI_ADMIN_IDENTITY_PROXY_HEALTH_URL:[\s\S]*HUAMEI_ADMIN_IDENTITY_PROXY_UPSTREAM_AUTHORIZATION_MODE: overwrite_verified_bearer[\s\S]*HUAMEI_ADMIN_IDENTITY_PROXY_SECURITY_PROFILE: state_nonce_pkce_origin_logout/, "生产网关必须声明实际OIDC代理产品、主动健康契约、Redis session和Bearer覆盖规则");
assert.match(caddy, /@management_api path \/api\/admin\/\* \/api\/local\/\* \/api\/v1\/runs \/api\/v1\/runs\/\*/, "管理API必须有独立Bearer路由");
const managementApiRoute = caddy.slice(caddy.indexOf("@management_api path"), caddy.indexOf("# A supported external OIDC"));
assert.doesNotMatch(managementApiRoute, /basic_auth/, "管理API前不得用Basic覆盖OIDC Bearer Authorization");
assert.match(caddy, /Content-Security-Policy[^\n]*frame-ancestors/, "正常入口必须设置CSP");
assert.match(stopAi, /Content-Security-Policy[^\n]*frame-ancestors/, "停AI入口必须保留CSP");
assert.match(stopAi, /@management_api path \/api\/admin\/\* \/api\/local\/\* \/api\/v1\/runs/, "停AI配置必须保留管理API的OIDC Bearer路由");
assert.doesNotMatch(stopAi.slice(stopAi.indexOf("{$ADMIN_SITE_ADDRESS}")), /basic_auth/, "停AI配置不得以Basic覆盖OIDC Bearer");
assert.match(runbook, /所有坐席需`operations\.agent`[\s\S]*同时具有`contact:reveal`[\s\S]*`tenant_ids`必须枚举具体租户[\s\S]*不得使用`\*`/, "首期生产接管工作台必须固定双角色与枚举租户边界");
assert.match(runbook, /`customer:read`、`service:read`、`runs:read`[\s\S]*仅在另行批准的用途下授予/, "非首期管理能力不得随接管角色默认开放");
assert.match(caddy, /@canary \{[\s\S]*?header X-Huamei-Canary[\s\S]*?path[^\n]*\/api\/public\/\*/, "灰度令牌只能路由公众表面");
assert.match(stopAi, /@ai_chat path \/api\/public\/acquisition-chat\s/, "停AI只能精确阻断对客AI聊天路由");
assert.doesNotMatch(stopAi, /@ai_chat[^\n]*acquisition-lead/, "停AI不得阻断独立留资路由");
assert.match(stopAi, /AI_SERVICE_PAUSED[\s\S]*503/, "停AI必须返回明确可识别的503");
assert.match(runbook, /caddy validate --config \/etc\/caddy\/Caddyfile\.stop-ai/, "停AI前必须校验应急配置");
assert.match(runbook, /caddy reload --config \/etc\/caddy\/Caddyfile\.stop-ai/, "停AI必须通过原子reload生效");
assert.match(runbook, /stop acquisition graphrag conversation-recovery/, "网关阻断后必须有内部AI停机操作");
assert.match(evidenceContract, /huamei\.production-evaluation-evidence\.v3/, "必须固定正式评测契约版本");
assert.match(evidenceContract, /huamei\.production-capacity-evidence\.v2/, "必须固定容量证据契约版本");

console.log("✓ 生产部署契约：不可变镜像、真实LLM/加密门禁、灰度、Outbox与停AI闭环完整");
