import { AGENT_DEFINITIONS } from "./agent-runtime.mjs";

const invocationExample = {
  customer_id: "C-202608-001",
  message: "我想了解热玛吉的一般流程，并看看周三是否能到院评估",
  channel: "partner_api",
  mode: "assist",
  context: {
    macro_stage: "售前", micro_stage: "留资待预约",
    interests: [{ name: "热玛吉", score: 92 }], service_consent: true,
    marketing_consent: true, owner: "周妍", available_slots: ["周三 12:20", "周四 15:30"]
  }
};

const draftMetadataProperties = {
  source_reference:{ type:"string", maxLength:500 }, applicable_campuses:{ type:"array", maxItems:12, items:{ type:"string", maxLength:80 } },
  public_scope:{ enum:["internal", "customer_summary", "public_full"] }, customer_facing_candidate:{ type:"boolean", default:false },
  effective_at:{ type:"string", format:"date-time" }, expires_at:{ type:"string", format:"date-time" }
};
const draftMutation = (summary, properties, required = []) => ({
  tags:["Admin Operations"], summary, security:[{ OidcBearerAuth:[] }],
  description:"身份和科室范围来自已验证管理身份。写入要求当前 expected_version 和幂等键，成功不代表对客发布。",
  parameters:[{ $ref:"#/components/parameters/KnowledgeIntakeDocumentId" }, { $ref:"#/components/parameters/RequiredIdempotencyKey" }],
  requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false, required:["expected_version", ...required],
    properties:{ expected_version:{ type:"integer", minimum:1 }, ...properties } } } } },
  responses:{ "200":{ description:"内部资料变更或幂等重放" }, "400":{ description:"必填信息或候选前置条件不满足" }, "403":{ $ref:"#/components/responses/Forbidden" }, "404":{ $ref:"#/components/responses/NotFound" }, "409":{ description:"版本冲突、幂等冲突或尚未解析" } }
});

const appointmentTimeProperties = {
  preferred_date:{ type:"string", format:"date", description:"上海时区的明确日期 YYYY-MM-DD。今天到院须提供未来具体钟点。" },
  preferred_time:{ type:"string", pattern:"^([01][0-9]|2[0-3]):[0-5][0-9]$", description:"24小时钟点；与 time_period 互斥" },
  time_period:{ enum:["morning","afternoon","evening", ""] },
  customer_confirmed:{ const:true }, session_id:{ type:"string" }, session_token:{ type:"string" }
};
const customerAppointmentChange = (action) => ({ tags:["Acquisition"], summary:action === "cancel" ? "客户确认取消到院登记" : "客户确认修改到院时间", security:[],
  description:"必须绑定原登记的有效会话凭证、当前 expected_version 与唯一 Idempotency-Key。重复相同请求返回原结果，载荷或版本冲突返回409。改期沿用原登记号和跟进任务，并使旧待处理通知失效。",
  parameters:[{ $ref:"#/components/parameters/AppointmentIntakeId" }, { $ref:"#/components/parameters/RequiredIdempotencyKey" }],
  requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["expected_version","customer_confirmed", ...(action === "reschedule" ? ["preferred_date"] : [])], properties:{ ...appointmentTimeProperties, expected_version:{ type:"integer", minimum:1 } } } } } },
  responses:{ "200":{ description:"变更保存或相同请求重放" }, "400":{ description:"缺少确认或日期无效" }, "401":{ description:"凭证失效" }, "404":{ description:"当前会话无此登记" }, "409":{ description:"版本或幂等冲突" } }
});

export function createOpenApiDocument(origin = "http://127.0.0.1:4173") {
  return {
    openapi: "3.1.0",
    info: {
      title: "时代之美 AI员工开放 API",
      version: "2.0.0",
      description: "网页与管理网关。售前智能体已拆分为独立服务，网页接口通过HTTP网关调用；企业微信和合作方系统可直接使用独立服务的渠道接口。API仅提供项目科普、流程协同与经营建议，不提供医疗诊断、个体适用性判断或效果承诺。"
    },
    servers: [{ url: origin, description: "当前本地环境" }],
    tags: [
      { name: "Acquisition", description: "终端获客顾问问答与授权留资" },
      { name: "Agents", description: "AI员工发现与调用" },
      { name: "Router", description: "按生命周期和意图自动选择AI员工" },
      { name: "Audit", description: "运行记录与审计" },
      { name: "Admin Operations", description: "人工接管后台BFF；浏览器只持有OIDC Bearer" },
      { name: "System", description: "健康检查与规范" }
    ],
    paths: {
      "/api/health": {
        get: { tags: ["System"], summary: "最小存活检查", security: [], responses: { "200": { description: "仅返回服务存活状态", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } } } }
      },
      "/api/ready": {
        get: { tags:["System"], summary:"受保护的详细就绪检查", responses:{ "200":{ description:"依赖均已就绪" }, "401":{ $ref:"#/components/responses/Unauthorized" }, "503":{ description:"一个或多个关键依赖尚未就绪" } } }
      },
      "/api/v1/openapi.json": {
        get: { tags: ["System"], summary: "OpenAPI 3.1规范", security: [], responses: { "200": { description: "接口规范" } } }
      },
      "/api/public/acquisition-chat": {
        post: {
          tags:["Acquisition"], summary:"调用AI获客顾问·小美", security:[],
          description:"意图引擎先完成安全覆盖、实体链接和证据路由，再回答并返回短消息数组reply_segments、意图置信度、领域、对话动作与留资引导；不提供诊断或个体适用性判断。",
          requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["message"], properties:{ tenant_id:{ type:"string", pattern:"^[a-z0-9][a-z0-9_-]{2,63}$" }, message:{ type:"string", minLength:1, maxLength:1000 }, session_id:{ type:"string", maxLength:128 }, session_token:{ type:"string", description:"继续服务端会话时使用；浏览器通常由HttpOnly Cookie自动携带" }, interests:{ type:"array", maxItems:3 } } } } } },
          responses:{ "200":{ description:"项目知识回答、服务端会话凭证与留资引导" }, "400":{ $ref:"#/components/responses/BadRequest" }, "401":{ description:"会话凭证无效、过期或作用域不匹配" }, "409":{ description:"幂等键对应的请求内容不一致" }, "429":{ $ref:"#/components/responses/RateLimited" }, "503":{ description:"售前智能体独立服务暂时不可用" } }
        }
      },
      "/api/public/acquisition-lead": {
        post: {
          tags:["Acquisition"], summary:"校验手机号格式并保存咨询线索", security:[],
          description:"客户同意本次咨询服务联系后，服务端校验11位中国大陆手机号格式并立即保存线索，将手机号标记为待人工核号，同时自动尝试院方客户记录查重。查重结果不能证明手机号属于提交人，失败也不阻断留资。公网响应对新建与更新保持一致，只返回待人工核号状态、脱敏号码、不透明回执和会话凭证，不公开院方查重结果或会员状态。",
          requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["mobile","service_consent"], properties:{ tenant_id:{ type:"string", pattern:"^[a-z0-9][a-z0-9_-]{2,63}$" }, name:{ type:"string", maxLength:40 }, mobile:{ type:"string", pattern:"^1[3-9][0-9]{9}$" }, service_consent:{ const:true }, session_id:{ type:"string", maxLength:128 }, session_token:{ type:"string", description:"继续服务端会话时使用；浏览器通常由HttpOnly Cookie自动携带" }, interests:{ type:"array", maxItems:10, items:{ type:"string" } }, messages:{ type:"array", maxItems:16 } } } } } },
          responses:{ "200":{ description:"格式校验通过并完成保存；返回待人工核号的统一最小回执，不暴露号码是否已有档案" }, "400":{ $ref:"#/components/responses/BadRequest" }, "429":{ $ref:"#/components/responses/RateLimited" } }
        }
      },
      "/api/public/appointment-dates": { get:{ tags:["Acquisition"], summary:"获取次日起两个工作日建议", security:[], description:"依赖有来源、版本、维护人、覆盖范围与有效期的工作日日历。缺失或过期返回 available=false 和空日期，客户仍可自主选择。", responses:{ "200":{ description:"建议日期或自主选择降级" } } } },
      "/api/public/appointment-intakes/current": { post:{ tags:["Acquisition"], summary:"以当前会话凭证恢复到院登记", security:[], description:"使用原 HttpOnly Cookie 或会话令牌。仅返回客户本人登记摘要；不返回内部跟进、审计或联系人标识。", requestBody:{ content:{ "application/json":{ schema:{ type:"object", properties:{ session_id:{ type:"string" }, session_token:{ type:"string" } } } } } }, responses:{ "200":{ description:"当前登记或 intake=null" }, "401":{ description:"会话凭证失效" } } } },
      "/api/public/appointment-intakes/{appointmentIntakeId}/reschedule": { post:customerAppointmentChange("reschedule") },
      "/api/public/appointment-intakes/{appointmentIntakeId}/cancel": { post:customerAppointmentChange("cancel") },
      "/api/public/appointment-intakes": { post:{
        tags:["Acquisition"], summary:"客户确认后保存到院登记", security:[],
        description:"服务端核对当前会话已留且有服务联系授权的联系方式。手机号只需格式校验，状态为 pending_manual。确认院区、项目或医生、明确日期后原子保存登记号、确认快照、跟进任务、待处理通知和审计；不查询医生排班或扣减名额。每会话至多一条有效登记。当前通知需人工处理，不返回发送成功。",
        requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false, required:["action_id","branch","preferred_date","customer_confirmed"], properties:{ ...appointmentTimeProperties, action_id:{ type:"string", pattern:"^act_[a-f0-9]{24}$" }, branch:{ type:"string", maxLength:80 }, projects:{ type:"array", maxItems:6, items:{ type:"string", maxLength:80 } }, doctor:{ type:"string", maxLength:80 } } } } } },
        responses:{ "201":{ description:"登记成功：status=registered、version=1、唯一 appointment_no" }, "200":{ description:"相同提交幂等重放" }, "400":{ description:"联系方式、授权、确认、项目、院区或日期不完整" }, "401":{ description:"会话凭证无效或过期" }, "409":{ description:"已有有效登记或同一标识用于不同内容" }, "503":{ description:"持久化失败，未成功登记" }, "429":{ $ref:"#/components/responses/RateLimited" } }
      } },
      "/api/local/acquisition-agent/status": {
        get: {
          tags:["Acquisition"], summary:"查询售前智能体、知识包与会话指标", security:[{ OidcBearerAuth:[] }],
          description:"生产环境要求OIDC Bearer身份具有service:read角色，并且tenant_id必须在令牌tenant_ids范围内。本地开发仅保留回环管理兼容。",
          parameters:[{ $ref:"#/components/parameters/ManagementTenantId" }],
          responses:{ "200":{ description:"售前智能体运行状态" }, "401":{ $ref:"#/components/responses/OidcUnauthorized" }, "403":{ $ref:"#/components/responses/Forbidden" } }
        }
      },
      "/api/local/acquisition-customers": {
        get:{
          tags:["Acquisition"], summary:"查询租户内客户360快照", security:[{ OidcBearerAuth:[] }],
          description:"生产环境要求customer:read角色。请求租户由OIDC tenant_ids授权，不能仅依赖查询参数。",
          parameters:[{ $ref:"#/components/parameters/ManagementTenantId" }],
          responses:{ "200":{ description:"已授权租户的客户快照" }, "401":{ $ref:"#/components/responses/OidcUnauthorized" }, "403":{ $ref:"#/components/responses/Forbidden" } }
        }
      },
      "/api/admin/acquisition/handovers": {
        get:{ tags:["Admin Operations"], summary:"列出人工接管任务", security:[{ OidcBearerAuth:[] }], description:"要求operations.agent；租户只从已验证token的唯一tenant_ids取得，不接受浏览器tenant_id。", parameters:[{ name:"status", in:"query", schema:{ type:"string" } }, { name:"limit", in:"query", schema:{ type:"integer", minimum:1, maximum:100 } }], responses:{ "200":{ description:"接管列表" }, "401":{ $ref:"#/components/responses/OidcUnauthorized" }, "403":{ $ref:"#/components/responses/Forbidden" } } }
      },
      "/api/admin/acquisition/handovers/{handoverId}": {
        get:{ tags:["Admin Operations"], summary:"查看接管详情", security:[{ OidcBearerAuth:[] }], parameters:[{ $ref:"#/components/parameters/HandoverId" }], responses:{ "200":{ description:"接管详情" }, "404":{ $ref:"#/components/responses/NotFound" } } }
      },
      "/api/admin/acquisition/handovers/{handoverId}/claim": {
        post:{ tags:["Admin Operations"], summary:"由当前OIDC人员接管", security:[{ OidcBearerAuth:[] }], parameters:[{ $ref:"#/components/parameters/HandoverId" }, { $ref:"#/components/parameters/IdempotencyKey" }], description:"操作人由token sub确定；请求体不能指定assignee/actor/staff_id/tenant_id。", responses:{ "200":{ description:"已接管" }, "409":{ description:"已由其他顾问接管" } } }
      },
      "/api/admin/acquisition/handovers/{handoverId}/complete": {
        post:{
          tags:["Admin Operations"],
          summary:"原子完结接管并登记当前实名人员工时",
          security:[{ OidcBearerAuth:[] }],
          parameters:[
            { $ref:"#/components/parameters/HandoverId" },
            { name:"Idempotency-Key", in:"header", required:true, schema:{ type:"string", minLength:8, maxLength:128 } }
          ],
          description:"网关保留同源/CSRF与OIDC边界，并将一次请求转发为售前服务的单事务操作；任务完结与工时登记不会出现部分成功。",
          requestBody:{
            required:true,
            content:{
              "application/json":{
                schema:{
                  type:"object",
                  additionalProperties:false,
                  required:["resolution", "minutes"],
                  properties:{
                    resolution:{ type:"string", minLength:1, maxLength:200 },
                    minutes:{ type:"number", exclusiveMinimum:0, maximum:1440 },
                    notes:{ type:"string", maxLength:500 }
                  }
                }
              }
            }
          },
          responses:{
            "200":{ description:"接管与工时已原子提交" },
            "400":{ description:"参数或幂等键无效" },
            "409":{ description:"未接管、非当前接管人或重复请求载荷冲突" }
          }
        }
      },
      "/api/admin/acquisition/handovers/{handoverId}/contact-reveal": {
        post:{
          tags:["Admin Operations"],
          summary:"由当前接管顾问显式查看一次回访电话",
          security:[{ OidcBearerAuth:[] }],
          parameters:[
            { $ref:"#/components/parameters/HandoverId" },
            { name:"Idempotency-Key", in:"header", required:true, schema:{ type:"string", minLength:8, maxLength:128 } }
          ],
          description:"要求同一OIDC身份同时具备operations.agent与contact:reveal、处于token枚举租户、且是claimed任务当前assignee。服务实时检查service consent及撤回/限制；响应no-store，不允许预加载或浏览器持久化。",
          requestBody:{ required:false, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false } } } },
          responses:{
            "200":{ description:"仅本次显式点击返回回访电话；不得写入浏览器持久化存储" },
            "400":{ description:"幂等键或调用方作用域覆盖无效" },
            "403":{ description:"缺少双角色、跨租户或不是当前接管人" },
            "404":{ $ref:"#/components/responses/NotFound" },
            "409":{ description:"任务未接管、授权已撤回/限制、无可用联系方式或请求重放" },
            "503":{ description:"保险库或追加审计不可用" }
          }
        }
      },
      "/api/admin/acquisition/human-work": {
        post:{ tags:["Admin Operations"], summary:"记录当前OIDC人员工时", security:[{ OidcBearerAuth:[] }], parameters:[{ $ref:"#/components/parameters/IdempotencyKey" }], description:"人员与租户由token确定，网关在服务端添加调用方密钥并原样转发Bearer。", requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["minutes"], properties:{ conversation_id:{ type:"string" }, handover_id:{ type:"string" }, minutes:{ type:"number", exclusiveMinimum:0 }, notes:{ type:"string", maxLength:500 } } } } } }, responses:{ "201":{ description:"工时已记录" } } }
      },
      "/api/admin/knowledge/intake/documents": {
        get:{ tags:["Admin Operations"], summary:"按授权科室筛选内部知识录入资料", security:[{ OidcBearerAuth:[] }], description:"要求knowledge:intake:read；服务端按OIDC department_ids收窄范围，支持标题、来源、标签、状态、类型、公开范围及指定日期有效性的组合筛选，响应不返回完整内部原文。", parameters:[{ name:"department", in:"query", schema:{ type:"string" } }, { name:"status", in:"query", schema:{ type:"string" } }, { name:"content_type", in:"query", schema:{ type:"string" } }, { name:"public_scope", in:"query", schema:{ enum:["internal", "customer_summary", "public_full"] } }, { name:"q", in:"query", schema:{ type:"string", maxLength:120 } }, { name:"valid_on", in:"query", description:"仅返回在指定时间仍有效的资料", schema:{ type:"string", format:"date-time" } }, { name:"limit", in:"query", schema:{ type:"integer", minimum:1, maximum:500 } }], responses:{ "200":{ description:"资料摘要列表" }, "400":{ description:"有效期筛选参数无效" }, "403":{ $ref:"#/components/responses/Forbidden" } } },
        post:{ tags:["Admin Operations"], summary:"录入、解析并向量化知识文本", security:[{ OidcBearerAuth:[] }], description:"仅供小型文本直接录入；文件素材应使用原始素材预留、上传、完成接口。解析成功后仅建立内部草稿索引；勾选对客候选用途不会发布。", parameters:[{ $ref:"#/components/parameters/RequiredIdempotencyKey" }], requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false, required:["source_filename","department","content_type","owner","text_content"], properties:{ source_filename:{ type:"string", maxLength:160 }, department:{ type:"string", maxLength:80 }, content_type:{ enum:["项目介绍","医生介绍","服务流程","活动权益","公开海报","排班说明","其他"] }, owner:{ type:"string", maxLength:80 }, tags:{ type:"array", maxItems:12, items:{ type:"string", maxLength:80 } }, effective_at:{ type:"string", format:"date-time" }, expires_at:{ type:"string", format:"date-time" }, ...draftMetadataProperties, text_content:{ type:"string", minLength:20, maxLength:262144 } } } } } }, responses:{ "201":{ description:"资料已解析并建立内部草稿索引" }, "200":{ description:"幂等重放或内容指纹命中" }, "400":{ description:"资料格式、文本或元数据无效" }, "403":{ $ref:"#/components/responses/Forbidden" } } }
      },
      "/api/admin/knowledge/intake/documents/{documentId}": {
        get:{ tags:["Admin Operations"], summary:"按授权科室读取资料正文与版本摘要", security:[{ OidcBearerAuth:[] }], parameters:[{ $ref:"#/components/parameters/KnowledgeIntakeDocumentId" }], responses:{ "200":{ description:"内部详情，包含 text_content" }, "403":{ $ref:"#/components/responses/Forbidden" }, "404":{ $ref:"#/components/responses/NotFound" } } },
        post:draftMutation("校订草稿并生成新版本，清除旧确认", { ...draftMetadataProperties, title:{ type:"string", maxLength:120 }, text_content:{ type:"string", minLength:20 }, department:{ type:"string" }, content_type:{ type:"string" }, owner:{ type:"string" }, tags:{ type:"array", items:{type:"string"} } })
      },
      "/api/admin/knowledge/intake/documents/{documentId}/confirmation": {
        post:draftMutation("登记本版本院方线下确认凭据", { reference:{ type:"string", maxLength:500 }, confirmed_by:{ type:"string", maxLength:120 }, confirmed_at:{ type:"string", format:"date-time" }, confirmation_expires_at:{ type:"string", format:"date-time" } }, ["reference", "confirmed_by", "confirmed_at", "confirmation_expires_at"])
      },
      "/api/admin/knowledge/intake/documents/{documentId}/candidate": {
        post:draftMutation("检查来源、院区、有效期和院方确认并准备候选", {})
      },
      "/api/admin/knowledge/intake/assets/prepare": {
        post:{ tags:["Admin Operations"], summary:"预留原始知识素材上传", security:[{ OidcBearerAuth:[] }], description:"管理员先创建租户和科室绑定的上传预留，再通过返回的受控URL上传二进制。原始文件不会直接进入知识库。", parameters:[{ $ref:"#/components/parameters/RequiredIdempotencyKey" }], requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false, required:["source_filename","mime","size","department","content_type","owner"], properties:{ source_filename:{ type:"string", maxLength:160 }, mime:{ type:"string" }, size:{ type:"integer", minimum:1, maximum:33554432 }, department:{ type:"string", maxLength:80 }, content_type:{ enum:["项目介绍","医生介绍","服务流程","活动权益","公开海报","排班说明","其他"] }, owner:{ type:"string", maxLength:80 }, tags:{ type:"array", maxItems:12, items:{ type:"string", maxLength:80 } }, ...draftMetadataProperties } } } } }, responses:{ "201":{ description:"上传预留已创建" }, "400":{ description:"素材元数据或格式无效" }, "403":{ $ref:"#/components/responses/Forbidden" } } }
      },
      "/api/admin/knowledge/intake/assets/{assetId}/content": {
        put:{ tags:["Admin Operations"], summary:"上传原始知识素材二进制", security:[{ OidcBearerAuth:[] }], description:"仅允许上传人向已预留素材写入一次；服务端校验大小、MIME和文件签名，并存入隔离区。", parameters:[{ name:"assetId", in:"path", required:true, schema:{ type:"string", pattern:"^kiasset_[a-f0-9-]+$" } }], requestBody:{ required:true, content:{ "application/octet-stream":{ schema:{ type:"string", format:"binary" } } } }, responses:{ "200":{ description:"素材已隔离保存" }, "409":{ description:"素材状态不允许写入" } } }
      },
      "/api/admin/knowledge/intake/assets/{assetId}/complete": {
        post:{ tags:["Admin Operations"], summary:"完成素材入库并触发受控解析", security:[{ OidcBearerAuth:[] }], description:"文本资料解析后仅建立内部草稿索引；PDF、DOCX和图片保存原件并等待受控解析，也可人工校订正文。", parameters:[{ name:"assetId", in:"path", required:true, schema:{ type:"string", pattern:"^kiasset_[a-f0-9-]+$" } }, { $ref:"#/components/parameters/RequiredIdempotencyKey" }], responses:{ "201":{ description:"素材已形成内部草稿或待解析记录" }, "409":{ description:"素材尚未上传或状态冲突" } } }
      },
      "/api/admin/appointment-intakes": {
        get:{ tags:["Admin Operations"], summary:"列出到院登记及跟进状态", security:[{ OidcBearerAuth:[] }], description:"要求appointment:read；浏览器不能指定租户或处理人员。", parameters:[{ name:"status", in:"query", schema:{ type:"string" } }, { name:"limit", in:"query", schema:{ type:"integer", minimum:1, maximum:500 } }], responses:{ "200":{ description:"预约事项列表" }, "401":{ $ref:"#/components/responses/OidcUnauthorized" }, "403":{ $ref:"#/components/responses/Forbidden" } } }
      },
      "/api/admin/appointment-intakes/{appointmentIntakeId}": {
        get:{ tags:["Admin Operations"], summary:"查看预约事项", security:[{ OidcBearerAuth:[] }], parameters:[{ $ref:"#/components/parameters/AppointmentIntakeId" }], responses:{ "200":{ description:"预约事项" }, "404":{ $ref:"#/components/responses/NotFound" } } }
      },
      "/api/admin/appointment-intakes/{appointmentIntakeId}/claim": {
        post:{ tags:["Admin Operations"], summary:"领取到院登记跟进", security:[{ OidcBearerAuth:[] }], description:"操作人仅来自已验证管理身份。", parameters:[{ $ref:"#/components/parameters/AppointmentIntakeId" }, { $ref:"#/components/parameters/RequiredIdempotencyKey" }], responses:{ "200":{ description:"已领取" }, "409":{ description:"已由其他人员领取或已结束" } } }
      },
      "/api/admin/appointment-intakes/{appointmentIntakeId}/contact-reveal": { post:{ tags:["Admin Operations"], summary:"当前领取顾问一次性查看回拨号码", security:[{ OidcBearerAuth:[] }], description:"同时要求 appointment:write 与 contact:reveal。事务中校验登记有效、未结束跟进、领取人、服务联系授权与限制联系状态；不缓存响应，每次查看独立审计。", parameters:[{ $ref:"#/components/parameters/AppointmentIntakeId" }, { $ref:"#/components/parameters/RequiredIdempotencyKey" }], responses:{ "200":{ description:"单次号码披露，browser_storage_allowed=false" }, "403":{ description:"非当前领取人或权限不足" }, "409":{ description:"登记已结束、授权失效或请求已使用" } } } },
      "/api/admin/appointment-intakes/{appointmentIntakeId}/resolve": { post:{ tags:["Admin Operations"], summary:"当前领取人记录跟进结果", security:[{ OidcBearerAuth:[] }], description:"仅更新跟进状态；客户登记仍为 registered。客户改期后重新打开同一跟进任务。", parameters:[{ $ref:"#/components/parameters/AppointmentIntakeId" }, { $ref:"#/components/parameters/RequiredIdempotencyKey" }], requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false, required:["status","note"], properties:{ status:{ enum:["completed","needs_customer_info"] }, note:{ type:"string", minLength:1, maxLength:500 } } } } } }, responses:{ "200":{ description:"跟进结果已保存" }, "403":{ description:"非当前领取人" }, "409":{ description:"登记或跟进已结束" } } } },
      "/api/admin/schedule-slots": {
        get:{ tags:["Admin Operations"], deprecated:true, summary:"停用的排班兼容入口", security:[{ OidcBearerAuth:[] }], responses:{ "200":{ description:"空列表" } } },
        post:{ tags:["Admin Operations"], deprecated:true, summary:"一期不维护医生排班", security:[{ OidcBearerAuth:[] }], responses:{ "410":{ description:"SCHEDULE_NOT_IN_PHASE_ONE" } } }
      },
      "/api/v1/agents": {
        get: { tags: ["Agents"], summary: "查询六个AI员工", responses: { "200": { description: "AI员工列表", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Agent" } } } } } } } } }
      },
      "/api/v1/model/status": {
        get: { tags: ["System"], summary: "查询大模型运行时状态", responses: { "200": { description: "不含密钥的模型配置状态", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/LlmStatus" } } } } } } } }
      },
      "/api/v1/agents/{agentId}": {
        get: {
          tags: ["Agents"], summary: "查询AI员工定义", parameters: [{ $ref: "#/components/parameters/AgentId" }],
          responses: { "200": { description: "AI员工定义", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Agent" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } }
        }
      },
      "/api/v1/agents/{agentId}/invoke": {
        post: {
          tags: ["Agents"], summary: "调用指定AI员工", description: "每次调用均经过合规守门员前后置检查。推荐传入Idempotency-Key。",
          parameters: [{ $ref: "#/components/parameters/AgentId" }, { $ref: "#/components/parameters/IdempotencyKey" }, { $ref: "#/components/parameters/ClientId" }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InvocationRequest" }, example: invocationExample } } },
          responses: { "200": { description: "调用结果", content: { "application/json": { schema: { $ref: "#/components/schemas/InvocationResponse" } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "429": { $ref: "#/components/responses/RateLimited" } }
        }
      },
      "/api/v1/router/invoke": {
        post: {
          tags: ["Router"], summary: "自动路由并调用AI员工", parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }, { $ref: "#/components/parameters/ClientId" }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InvocationRequest" }, example: invocationExample } } },
          responses: { "200": { description: "路由与调用结果", content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/InvocationResponse" }, { type: "object", properties: { routing: { type: "object" } } }] } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" } }
        }
      },
      "/api/v1/compliance/check": {
        post: {
          tags: ["Agents"], summary: "独立调用合规守门员", description: "检查待发送内容是否涉及医疗诊断、个体适用性、异常处置、绝对化效果承诺或敏感属性。",
          parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }, { $ref: "#/components/parameters/ClientId" }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InvocationRequest" }, example: { message: "热玛吉一定有效而且绝对安全", mode: "assist" } } } },
          responses: { "200": { description: "合规决策", content: { "application/json": { schema: { $ref: "#/components/schemas/InvocationResponse" } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" } }
        }
      },
      "/api/v1/runs": {
        get: {
          tags: ["Audit"], summary: "查询运行审计列表", security:[{ ApiKeyAuth:[], OidcBearerAuth:[] }],
          description:"生产管理读要求runs:read角色与租户范围；API Key仅识别系统调用方，不代表人员身份。",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, { $ref:"#/components/parameters/ManagementTenantId" }],
          responses: { "200": { description: "运行列表", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/RunAudit" } } } } } } }, "401":{ $ref:"#/components/responses/OidcUnauthorized" }, "403":{ $ref:"#/components/responses/Forbidden" } }
        }
      },
      "/api/v1/runs/{runId}": {
        get: {
          tags: ["Audit"], summary: "查询单次运行及结果", security:[{ ApiKeyAuth:[], OidcBearerAuth:[] }], parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }, { $ref:"#/components/parameters/ManagementTenantId" }],
          responses: { "200": { description: "运行详情" }, "404": { $ref: "#/components/responses/NotFound" } }
        }
      }
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key", description: "生产环境通过HUAMEI_API_KEY配置并定期轮换。" },
        OidcBearerAuth:{ type:"http", scheme:"bearer", bearerFormat:"JWT", description:"生产管理面OIDC access token；服务端校验签名、issuer、audience、有效期、角色与tenant_ids。" }
      },
      parameters: {
        AgentId: { name: "agentId", in: "path", required: true, schema: { type: "string", enum: AGENT_DEFINITIONS.map((item) => item.id) } },
        IdempotencyKey: { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 128 }, description: "同一Key和路径在10分钟内返回相同结果。" },
        ClientId: { name: "X-Client-Id", in: "header", required: false, schema: { type: "string", maxLength: 128 }, description: "调用方系统标识，用于脱敏审计归因。" }
        ,ManagementTenantId:{ name:"tenant_id", in:"query", required:false, schema:{ type:"string", pattern:"^[a-z0-9][a-z0-9_-]{2,63}$" }, description:"要访问的租户；多租户令牌必填，且必须在OIDC tenant_ids中。" }
        ,HandoverId:{ name:"handoverId", in:"path", required:true, schema:{ type:"string", pattern:"^ho_[a-f0-9-]+$" } }
        ,AppointmentIntakeId:{ name:"appointmentIntakeId", in:"path", required:true, schema:{ type:"string", pattern:"^apt_[a-f0-9-]+$" } }
        ,KnowledgeIntakeDocumentId:{ name:"documentId", in:"path", required:true, schema:{ type:"string", pattern:"^kidoc_[a-f0-9-]+$" } }
        ,RequiredIdempotencyKey:{ name:"Idempotency-Key", in:"header", required:true, schema:{ type:"string", minLength:8, maxLength:128 }, description:"同一写操作重试必须复用同一键。" }
      },
      schemas: {
        Health: { type:"object", required:["status", "service", "version", "time"], additionalProperties:false, properties:{ status:{ const:"ok" }, service:{ type:"string" }, version:{ type:"string" }, test_instance_id:{ type:"string", description:"仅隔离测试环境返回" }, time:{ type:"string", format:"date-time" } } },
        LlmStatus: { type: "object", properties: { enabled: { type: "boolean" }, configured: { type: "boolean" }, provider: { type: "string" }, model: { type: ["string", "null"] }, base_host: { type: ["string", "null"] }, mode: { enum: ["local_rule_runtime", "hybrid_llm_runtime"] } } },
        Agent: {
          type: "object", required: ["id", "slug", "name", "version", "role", "capabilities", "forbidden"],
          properties: { id: { type: "string" }, slug: { type: "string" }, name: { type: "string" }, version: { type: "string" }, role: { type: "string" }, stage: { type: "string" }, status: { type: "string" }, execution_level: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, forbidden: { type: "array", items: { type: "string" } }, knowledge_version: { type: "string" } }
        },
        InvocationRequest: {
          type: "object", required: ["message"], additionalProperties: false,
          properties: {
            tenant_id:{ type:"string", pattern:"^[a-z0-9][a-z0-9_-]{2,63}$" }, customer_id: { type: "string", maxLength: 128 }, message: { type: "string", minLength: 1, maxLength: 4000 }, channel: { type: "string", maxLength: 64 },
            mode: { type: "string", enum: ["assist", "reply", "outbound"], default: "assist" }, intent: { type: "string", maxLength: 64 },
            context: {
              type: "object", additionalProperties: true,
              properties: { macro_stage: { enum: ["售前", "售中", "售后", "未知"] }, micro_stage: { type: "string" }, interests: { type: "array", maxItems: 10 }, service_consent: { type: "boolean" }, marketing_consent: { type: "boolean" }, photo_consent: { type: "string" }, available_slots: { type: "array", maxItems: 10, items: { type: "string" } }, owner: { type: "string" }, repurchase_window: { type: "boolean" }, profile: { type: "object" } }
            }
          }
        },
        InvocationResponse: {
          type: "object", required: ["request_id", "run_id", "agent", "status", "output", "guardrails", "created_at"],
          properties: {
            request_id: { type: "string" }, run_id: { type: "string" }, agent: { type: "object" }, status: { enum: ["completed", "approval_required", "handover_required", "blocked"] },
            output: { type: "object", required: ["message", "structured_data", "recommended_actions", "handover", "citations"] }, guardrails: { type: "object" }, usage: { type: "object" }, created_at: { type: "string", format: "date-time" }
          }
        },
        RunAudit: { type: "object", properties: { run_id: { type: "string" }, request_id: { type: "string" }, created_at: { type: "string", format: "date-time" }, agent_id: { type: "string" }, customer_id: { type: ["string", "null"] }, status: { type: "string" }, decision: { type: "string" }, matched_rule_ids: { type: "array", items: { type: "string" } } } },
        Error: { type: "object", required: ["error", "request_id"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "array" } } }, request_id: { type: "string" } } }
      },
      responses: {
        BadRequest: { description: "请求参数错误", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        Unauthorized: { description: "API Key无效", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        OidcUnauthorized:{ description:"缺少或无效的OIDC Bearer身份", content:{ "application/json":{ schema:{ $ref:"#/components/schemas/Error" } } } },
        Forbidden:{ description:"角色不足或请求租户不在令牌授权范围", content:{ "application/json":{ schema:{ $ref:"#/components/schemas/Error" } } } },
        NotFound: { description: "资源不存在", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        RateLimited: { description: "超过限流", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
      }
    },
    security: [{ ApiKeyAuth: [] }]
  };
}
