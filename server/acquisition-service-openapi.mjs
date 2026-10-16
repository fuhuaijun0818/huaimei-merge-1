import { ACQUISITION_CHANNELS } from "./acquisition-channel-adapters.mjs";

export const createAcquisitionServiceOpenApi = (origin = "http://127.0.0.1:4180") => ({
  openapi:"3.1.0",
  info:{
    title:"华美售前智能体独立服务 API",
    version:"1.5.0",
    description:"租户隔离、渠道无关的售前服务。调用方由X-Caller-Id + X-Service-Key鉴权，租户与权限来自服务端注册表；请求中tenant_id仅做一致性校验。"
  },
  servers:[{ url:origin }],
  tags:[
    { name:"System", description:"服务状态与能力发现" },
    { name:"Channels", description:"渠道消息接入" },
    { name:"Conversations", description:"统一消息协议" },
    { name:"Feedback", description:"客户回答反馈与Bad Case闭环" },
    { name:"Handovers", description:"真实人工接管闭环" },
    { name:"Operations", description:"任务与业务验收计量" },
    { name:"Privacy", description:"个人信息访问、导出、更正、删除、限制和撤回授权请求" },
    { name:"Knowledge", description:"知识审核与发布准入" }
  ],
  paths:{
    "/health":{ get:{ tags:["System"], summary:"最小存活检查", security:[], responses:{ "200":{ description:"仅返回服务存活状态" } } } },
    "/ready":{ get:{ tags:["System"], summary:"详细就绪检查", responses:{ "200":{ description:"依赖和渠道均已就绪" }, "401":{ description:"服务鉴权失败" }, "503":{ description:"服务尚未就绪" } } } },
    "/openapi.json":{ get:{ tags:["System"], summary:"OpenAPI 3.1 规范", security:[], responses:{ "200":{ description:"接口规范" } } } },
    "/v1/channels":{ get:{ tags:["Channels"], summary:"查询已启用渠道", responses:{ "200":{ description:"渠道列表" } } } },
    "/v1/channels/{channel}/inbound":{
      post:{
        tags:["Channels"], summary:"提交渠道入站消息",
        parameters:[{ name:"channel", in:"path", required:true, schema:{ type:"string", enum:ACQUISITION_CHANNELS.map((item) => item.id) } }, { $ref:"#/components/parameters/IdempotencyKey" }],
        requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object" } } } },
        responses:{ "200":{ description:"渠道格式的回复" }, "400":{ description:"消息或渠道无效" }, "401":{ description:"服务鉴权失败" }, "403":{ description:"调用方无权访问该租户或缺少操作权限" }, "409":{ description:"幂等键对应的请求内容不一致" }, "429":{ description:"超过调用频率" } }
      }
    },
    "/v1/conversations/reply":{
      post:{
        tags:["Conversations"], summary:"通过统一协议获取回复", description:"普通业务请求不得传正式压测entry。仅外置清单已启用、具有formal-load:execute专用权限的受控容量runner可传一个entry ID；服务端从已验SHA和Ed25519签名的固定taxonomy目录推导查询，不接受query、nonce、profile或ordinal。",
        parameters:[{ $ref:"#/components/parameters/IdempotencyKey" }, { $ref:"#/components/parameters/FormalLoadTaxonomyEntryId" }],
        requestBody:{ required:true, content:{ "application/json":{ schema:{ $ref:"#/components/schemas/InboundEnvelope" } } } },
        responses:{ "200":{ description:"标准化售前智能体结果", content:{ "application/json":{ schema:{ $ref:"#/components/schemas/AgentResult" } } } }, "409":{ description:"幂等键对应的请求内容不一致" } }
      }
    },
    "/v1/conversations/feedback":{
      post:{
        tags:["Feedback"], summary:"记录当前会话对一轮回答的赞或踩", description:"仅记录客户当前可见的脱敏对话片段。踩会自动进入Bad Case队列；不写入客户画像或营销标签。",
        requestBody:{
          required:true,
          content:{
            "application/json":{
              schema:{
                type:"object",
                required:["conversation_id", "reply_id", "rating", "transcript"],
                properties:{
                  tenant_id:{ $ref:"#/components/schemas/TenantId" },
                  channel:{ type:"string", maxLength:32 },
                  conversation_id:{ type:"string", maxLength:160 },
                  reply_id:{ type:"string", maxLength:160 },
                  rating:{ enum:["up", "down"] },
                  transcript:{
                    type:"array", minItems:2, maxItems:24,
                    items:{
                      type:"object", required:["role", "content"],
                      properties:{
                        id:{ type:"string" }, role:{ enum:["user", "assistant"] },
                        content:{ type:"string", maxLength:1200 }, at:{ type:"string", format:"date-time" }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses:{ "201":{ description:"反馈已记录" }, "400":{ description:"反馈上下文或评分无效" }, "403":{ description:"调用方无当前租户权限" } }
      }
    },
    "/v1/feedback/bad-cases":{
      get:{ tags:["Feedback"], summary:"查询客户踩出的Bad Case队列", parameters:[{ $ref:"#/components/parameters/TenantIdQuery" }, { name:"status", in:"query", schema:{ enum:["new", "triaged", "included_in_eval", "dismissed"] } }, { name:"limit", in:"query", schema:{ type:"integer", minimum:1, maximum:500, default:100 } }], responses:{ "200":{ description:"已脱敏的Bad Case列表" }, "403":{ description:"缺少operations:read权限" } } }
    },
    "/v1/feedback/bad-cases/{feedbackId}/review":{
      post:{ tags:["Feedback"], summary:"实名运营人员处理Bad Case", security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }], parameters:[{ name:"feedbackId", in:"path", required:true, schema:{ type:"string", pattern:"^fb_" } }, { name:"Idempotency-Key", in:"header", required:true, schema:{ type:"string", minLength:8, maxLength:160 } }], requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false, required:["status"], properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" }, status:{ enum:["triaged", "included_in_eval", "dismissed"] }, note:{ type:"string", maxLength:500 } } } } } }, responses:{ "200":{ description:"处理结果已保存" }, "403":{ description:"缺少operations.agent角色或租户权限" }, "409":{ description:"同一幂等键或状态发生冲突" } } }
    },
    "/v1/handovers":{ get:{ tags:["Handovers"], summary:"查询转人工任务", parameters:[{ $ref:"#/components/parameters/TenantIdQuery" }], responses:{ "200":{ description:"转人工任务列表" } } } },
    "/v1/handovers/{handoverId}":{ get:{ tags:["Handovers"], summary:"查询转人工任务详情", parameters:[{ $ref:"#/components/parameters/HandoverId" }, { $ref:"#/components/parameters/TenantIdQuery" }], responses:{ "200":{ description:"转人工任务" }, "404":{ description:"任务不存在" } } } },
    "/v1/handovers/{handoverId}/claim":{ post:{ tags:["Handovers"], summary:"实名人工坐席接管并暂停AI", security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }], parameters:[{ $ref:"#/components/parameters/HandoverId" }], requestBody:{ required:false, content:{ "application/json":{ schema:{ type:"object", properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" } }, description:"assignee固定取OIDC sub，请求正文不得覆盖" } } } }, responses:{ "200":{ description:"接管成功" }, "400":{ description:"请求试图覆盖实名操作人" }, "403":{ description:"缺少operations.agent角色或租户权限" }, "409":{ description:"任务已结束" } } } },
    "/v1/handovers/{handoverId}/complete":{ post:{ tags:["Handovers"], summary:"原子完结人工接管并登记实名工时", description:"在同一后端事务中完结接管、恢复AI、登记实际付出时间并写入审计/outbox。会话、任务、工时类型和staff_id均由已接管任务与OIDC sub确定；相同幂等键重试返回原结果，不会重复记工时。", security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }], parameters:[{ $ref:"#/components/parameters/HandoverId" }, { name:"Idempotency-Key", in:"header", required:true, schema:{ type:"string", minLength:8, maxLength:160 } }], requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false, required:["resolution","minutes"], properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" }, resolution:{ type:"string", minLength:1, maxLength:200 }, minutes:{ type:"number", exclusiveMinimum:0, maximum:1440 }, notes:{ type:"string", maxLength:500 } }, description:"actor固定取OIDC sub；conversation_id、handover_id、work_type、occurred_at不得由请求覆盖" } } } }, responses:{ "200":{ description:"接管与工时已原子提交；data同时返回handover与human_work" }, "400":{ description:"参数、幂等键或服务端作用域覆盖无效" }, "403":{ description:"缺少operations.agent角色或租户权限" }, "409":{ description:"任务状态、幂等请求或已完结载荷冲突" } } } },
    "/v1/handovers/{handoverId}/contact-reveal":{ post:{ tags:["Handovers"], summary:"当前接管顾问显式查看一次回访电话", description:"调用方服务需contact:reveal权限；OIDC人员必须同时具有operations.agent与contact:reveal，并且是当前claimed任务的assignee。服务实时复核服务授权与撤回/限制抑制，明文只出现在本次no-store响应，不进入普通列表、profile或审计。手机号所有权由顾问回电时人工核对。", security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }], parameters:[{ $ref:"#/components/parameters/HandoverId" }, { name:"Idempotency-Key", in:"header", required:true, description:"每次显式点击生成的一次性查看请求标识；重放返回409。", schema:{ type:"string", minLength:8, maxLength:160 } }], requestBody:{ required:false, content:{ "application/json":{ schema:{ type:"object", additionalProperties:false, properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" } } } } } }, responses:{ "200":{ description:"仅本次响应返回电话；Cache-Control: no-store", content:{ "application/json":{ schema:{ type:"object", properties:{ data:{ $ref:"#/components/schemas/ContactReveal" } } } } } }, "400":{ description:"幂等键或请求作用域无效" }, "403":{ description:"缺少任一角色、跨租户或非当前接管人" }, "404":{ description:"当前租户不存在任务" }, "409":{ description:"任务未接管、授权失效、已撤回/限制、无可用联系方式或请求重放" }, "503":{ description:"联系方式保险库或审计不可用" } } } },
    "/v1/operations/tasks":{ get:{ tags:["Operations"], summary:"查询运营任务", parameters:[{ $ref:"#/components/parameters/TenantIdQuery" }], responses:{ "200":{ description:"任务列表" } } } },
    "/v1/operations/metrics":{ get:{ tags:["Operations"], summary:"查询转人工与人工工时指标", parameters:[{ $ref:"#/components/parameters/TenantIdQuery" }], responses:{ "200":{ description:"业务指标" } } } },
    "/v1/operations/human-work":{ post:{ tags:["Operations"], summary:"由实名售前人员登记本人实际付出时间", security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }], requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["conversation_id","minutes"], properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" }, conversation_id:{ type:"string" }, handover_id:{ type:"string" }, work_type:{ type:"string" }, minutes:{ type:"number", exclusiveMinimum:0 } }, description:"staff_id固定取OIDC sub，请求正文不得覆盖" } } } }, responses:{ "201":{ description:"工时已登记" }, "400":{ description:"请求试图覆盖实名操作人" }, "403":{ description:"缺少operations.agent角色或租户权限" } } } },
    "/v1/privacy/requests":{
      post:{
        tags:["Privacy"], summary:"提交个人信息权利请求（仅保存租户隔离的不可逆主体引用）",
        requestBody:{ required:true, content:{ "application/json":{ schema:{ $ref:"#/components/schemas/PrivacyRequestCreate" } } } },
        responses:{ "202":{ description:"固定最小受理回执，不返回请求范围、处理结果或完成元数据", content:{ "application/json":{ schema:{ $ref:"#/components/schemas/PrivacyRequestReceipt" } } } }, "400":{ description:"请求类型或手机号格式无效" }, "403":{ description:"调用方无权为该租户建单" }, "409":{ description:"request_id与已绑定的主体、范围或来源合约不一致" }, "429":{ description:"请求频率过高" } }
      },
      get:{
        tags:["Privacy"], summary:"由实名隐私处理人员查询请求队列",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[
          { $ref:"#/components/parameters/TenantIdQuery" },
          { name:"status", in:"query", schema:{ $ref:"#/components/schemas/PrivacyRequestStatus" } },
          { name:"limit", in:"query", schema:{ type:"integer", minimum:1, maximum:500, default:100 } }
        ],
        responses:{ "200":{ description:"不含明文主体标识的请求列表" }, "403":{ description:"缺少privacy.processor或租户权限" } }
      }
    },
    "/v1/privacy/requests/{privacyRequestId}":{
      get:{
        tags:["Privacy"], summary:"查询个人信息权利请求详情",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/PrivacyRequestId" }, { $ref:"#/components/parameters/TenantIdQuery" }],
        responses:{ "200":{ description:"请求详情" }, "404":{ description:"请求不存在或不属于当前租户" } }
      }
    },
    "/v1/privacy/requests/{privacyRequestId}/transition":{
      post:{
        tags:["Privacy"], summary:"身份核验后处理请求；完成、拒绝或保全需复核角色",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/PrivacyRequestId" }],
        requestBody:{ required:true, content:{ "application/json":{ schema:{ $ref:"#/components/schemas/PrivacyRequestTransition" } } } },
        responses:{ "200":{ description:"状态已更新并写入不可变审计" }, "403":{ description:"缺少privacy.processor或privacy.approver角色" }, "409":{ description:"身份未核验或状态迁移非法" } }
      }
    },
    "/v1/privacy/requests/{privacyRequestId}/execution":{
      get:{
        tags:["Privacy"], summary:"查询受控执行方案与最小化结果",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/PrivacyRequestId" }, { $ref:"#/components/parameters/TenantIdQuery" }],
        responses:{ "200":{ description:"执行方案" }, "404":{ description:"尚未准备执行方案" } }
      }
    },
    "/v1/privacy/requests/{privacyRequestId}/execution/prepare":{
      post:{
        tags:["Privacy"], summary:"由privacy.processor准备执行范围",
        description:"只使用已核验且处理中工单内的明确用途。撤回/限制可进入自动执行待复核；导出/删除只生成人工计划。",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/PrivacyRequestId" }],
        requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["tenant_id"], properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" } } } } } },
        responses:{ "201":{ description:"已准备；相同请求幂等返回同一动作" }, "403":{ description:"缺少processor角色" }, "409":{ description:"未核验、范围不明或重放冲突" } }
      }
    },
    "/v1/privacy/requests/{privacyRequestId}/execution/approve":{
      post:{
        tags:["Privacy"], summary:"由独立privacy.approver复核并执行",
        description:"复核人必须与准备人不同。撤回/限制在同一事务中生效；导出/删除仍保持manual_pending，不执行物理删除或导出。",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/PrivacyRequestId" }],
        requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["tenant_id"], properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" } } } } } },
        responses:{ "200":{ description:"已执行或已转人工计划" }, "403":{ description:"缺少approver角色或同人复核" }, "409":{ description:"未准备或工单状态无效" } }
      }
    },
    "/v1/knowledge/admission":{ get:{ tags:["Knowledge"], summary:"查询知识对客发布准入状态", parameters:[{ $ref:"#/components/parameters/TenantIdQuery" }], responses:{ "200":{ description:"准入状态" } } } },
    "/v1/knowledge/releases":{
      get:{ tags:["Knowledge"], summary:"查询知识发布记录", parameters:[{ $ref:"#/components/parameters/TenantIdQuery" }], responses:{ "200":{ description:"发布记录" } } }
    },
    "/v1/knowledge/releases/drafts":{
      post:{
        tags:["Knowledge"], summary:"创建待三审的不可变知识范围",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        requestBody:{ required:true, content:{ "application/json":{ schema:{ $ref:"#/components/schemas/KnowledgeDraft" } } } },
        responses:{ "201":{ description:"审核草稿已创建" }, "401":{ description:"企业身份无效" }, "403":{ description:"缺少release_manager角色或租户权限" } }
      }
    },
    "/v1/knowledge/releases/{releaseId}/review-scope":{
      get:{
        tags:["Knowledge"], summary:"读取本次审核必须确认的范围SHA",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/ReleaseId" }, { $ref:"#/components/parameters/TenantIdQuery" }],
        responses:{ "200":{ description:"审核范围" }, "403":{ description:"身份或租户无权访问" } }
      }
    },
    "/v1/knowledge/releases/{releaseId}/reviews/{reviewType}":{
      post:{
        tags:["Knowledge"], summary:"由业务、医务或合规实名审核人独立签署",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[
          { $ref:"#/components/parameters/ReleaseId" },
          { name:"reviewType", in:"path", required:true, schema:{ enum:["business", "medical", "compliance"] } }
        ],
        requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["decision","scope_checksum","comments"], properties:{ decision:{ enum:["approved", "rejected", "changes_requested"] }, scope_checksum:{ $ref:"#/components/schemas/Sha256" }, comments:{ type:"string", minLength:1, maxLength:2000 } } } } } },
        responses:{ "201":{ description:"实名审核已记录" }, "400":{ description:"缺少审核理由或范围指纹无效" }, "403":{ description:"审核角色或租户不匹配" }, "409":{ description:"该审核阶段已有不可变决策" } }
      }
    },
    "/v1/knowledge/releases/{releaseId}/receipt":{
      get:{
        tags:["Knowledge"], summary:"导出GraphRAG建图使用的三审回执",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/ReleaseId" }, { $ref:"#/components/parameters/TenantIdQuery" }],
        responses:{ "200":{ description:"不可变release binding回执" } }
      }
    },
    "/v1/knowledge/releases/{releaseId}/index":{
      post:{
        tags:["Knowledge"], summary:"绑定正式Microsoft GraphRAG索引Manifest",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/ReleaseId" }],
        requestBody:{ required:true, content:{ "application/json":{ schema:{ type:"object", required:["index_checksum","manifest"], properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" }, index_checksum:{ $ref:"#/components/schemas/Sha256" }, manifest:{ type:"object" } } } } } },
        responses:{ "200":{ description:"索引已绑定" }, "400":{ description:"Manifest与三审范围不匹配" } }
      }
    },
    "/v1/knowledge/releases/{releaseId}/activate":{
      post:{
        tags:["Knowledge"], summary:"由publisher实名激活已三审且已建图的版本",
        security:[{ CallerIdAuth:[], ServiceKeyAuth:[], OidcBearerAuth:[] }],
        parameters:[{ $ref:"#/components/parameters/ReleaseId" }],
        requestBody:{ required:false, content:{ "application/json":{ schema:{ type:"object", properties:{ tenant_id:{ $ref:"#/components/schemas/TenantId" } } } } } },
        responses:{ "200":{ description:"正式版本已激活" }, "403":{ description:"缺少publisher角色" }, "409":{ description:"三审或索引尚未完成" } }
      }
    }
  },
  components:{
    securitySchemes:{
      CallerIdAuth:{ type:"apiKey", in:"header", name:"X-Caller-Id", description:"必须与服务端注册的secret配对" },
      ServiceKeyAuth:{ type:"apiKey", in:"header", name:"X-Service-Key", description:"调用方独立强随机secret" },
      OidcBearerAuth:{ type:"http", scheme:"bearer", bearerFormat:"JWT", description:"知识审核/发布、隐私准备/复核和人工接管/工时必须使用企业OIDC实名身份" }
    },
    parameters:{
      IdempotencyKey:{ name:"Idempotency-Key", in:"header", required:false, schema:{ type:"string", maxLength:160 } },
      FormalLoadTaxonomyEntryId:{ name:"X-Huamei-Formal-Load-Entry-Id", in:"header", required:false, description:"仅正式容量runner使用；格式为服务端固定profile和批准范围内ordinal组成的entry ID。请求不得同时或改为传递taxonomy正文、query、nonce、profile、ordinal或manifest摘要。", schema:{ type:"string", pattern:"^[a-z][a-z0-9_-]{1,31}\\.[0-9]{1,6}$", maxLength:40 } },
      TenantIdQuery:{ name:"tenant_id", in:"query", required:false, description:"仅与已鉴权调用方的租户白名单做一致性校验", schema:{ $ref:"#/components/schemas/TenantId" } },
      HandoverId:{ name:"handoverId", in:"path", required:true, schema:{ type:"string", pattern:"^ho_" } },
      ReleaseId:{ name:"releaseId", in:"path", required:true, schema:{ type:"string", pattern:"^krel_", maxLength:128 } },
      PrivacyRequestId:{ name:"privacyRequestId", in:"path", required:true, schema:{ type:"string", pattern:"^dsr_[A-Za-z0-9._:-]{8,124}$", maxLength:128 } }
    },
    schemas:{
      TenantId:{ type:"string", pattern:"^[a-z0-9][a-z0-9_-]{2,63}$", default:"huamei-shanghai" },
      ContactReveal:{ type:"object", additionalProperties:false, required:["contact_reference","contact_type","value","masked_value","purpose","disclosure","browser_storage_allowed"], properties:{ contact_reference:{ type:"string", pattern:"^contact_[A-Za-z0-9_-]{16,128}$" }, contact_type:{ const:"mobile" }, value:{ type:"string", pattern:"^1[3-9][0-9]{9}$", description:"仅显式查看响应出现；客户端不得持久化。" }, masked_value:{ type:"string" }, purpose:{ const:"service_callback" }, disclosure:{ const:"explicit_one_time_view" }, browser_storage_allowed:{ const:false } } },
      Sha256:{ type:"string", pattern:"^[0-9a-f]{64}$" },
      PrivacyRequestStatus:{ enum:["received", "identity_pending", "in_progress", "fulfilled", "partially_fulfilled", "rejected", "cancelled"] },
      PrivacyRequestReceipt:{
        type:"object",
        required:["request_id", "request_type", "receipt_status"],
        additionalProperties:false,
        properties:{
          request_id:{ type:"string", pattern:"^dsr_", maxLength:128 },
          request_type:{ enum:["access", "export", "correct", "delete", "restrict", "withdraw_consent"] },
          receipt_status:{ const:"accepted" }
        }
      },
      PrivacyRequestCreate:{
        type:"object",
        required:["tenant_id", "request_type", "mobile"],
        properties:{
          tenant_id:{ $ref:"#/components/schemas/TenantId" },
          request_id:{ type:"string", pattern:"^dsr_", maxLength:128, description:"调用方生成的稳定幂等请求编号；可省略" },
          request_type:{ enum:["access", "export", "correct", "delete", "restrict", "withdraw_consent"] },
          mobile:{ type:"string", pattern:"^1[3-9][0-9]{9}$", writeOnly:true, description:"仅在内存中生成HMAC主体引用，不写入权利工单" },
          scope:{
            type:"object",
            properties:{
              categories:{ type:"array", maxItems:20, items:{ type:"string", maxLength:64 } },
              purposes:{
                type:"array", maxItems:10, uniqueItems:true,
                items:{ enum:["service", "marketing", "privacy", "photo", "medical_data", "all"] },
                description:"撤回同意或限制联系必填；all不可与其他用途同时出现"
              },
              correction_fields:{ type:"array", maxItems:20, items:{ type:"string", maxLength:64 } },
              note:{ type:"string", maxLength:500 }
            }
          }
        }
      },
      PrivacyRequestTransition:{
        type:"object",
        required:["tenant_id", "status"],
        properties:{
          tenant_id:{ $ref:"#/components/schemas/TenantId" },
          status:{ $ref:"#/components/schemas/PrivacyRequestStatus" },
          identity_verification_attestation:{
            type:"string",
            maxLength:4096,
            writeOnly:true,
            description:"可信OTP、回拨、已验证渠道或线下证件核验适配器签发的短期证明；绑定tenant、主体HMAC、request_id、verification_id及有效期，处理人不能自行声明verified"
          },
          completion_attestation:{
            type:"string",
            maxLength:4096,
            writeOnly:true,
            description:"access/correct进入fulfilled或partially_fulfilled时，由独立执行/交付适配器签发；绑定租户、主体、请求、类型、目标状态和实际action_reference"
          },
          cancellation_attestation:{
            type:"string",
            maxLength:4096,
            writeOnly:true,
            description:"status=cancelled时必填；由可信主体核验/撤回适配器签发，绑定tenant、subject HMAC、request_id、原身份核验号、撤回记录及有效期；普通结构化字段不被接受"
          },
          result:{
            type:"object",
            properties:{
              action_reference:{ type:"string", maxLength:160 },
              summary:{ type:"string", maxLength:1000 },
              retained_categories:{ type:"array", maxItems:20, items:{ type:"string", maxLength:80 } },
              retention_basis_reference:{ type:"string", maxLength:160 }
            }
          },
          legal_hold:{ type:"boolean" }
        }
      },
      KnowledgeDraft:{
        type:"object",
        required:["tenant_id", "package_version", "package_checksum", "record_list_checksum", "index_version", "approved_record_ids"],
        properties:{
          tenant_id:{ $ref:"#/components/schemas/TenantId" },
          release_id:{ type:"string", pattern:"^krel_", maxLength:128 },
          package_version:{ type:"string", maxLength:128 },
          package_checksum:{ $ref:"#/components/schemas/Sha256" },
          record_list_checksum:{ $ref:"#/components/schemas/Sha256" },
          index_version:{ type:"string", maxLength:128 },
          approved_record_ids:{ type:"array", minItems:1, items:{ type:"string" } },
          effective_at:{ type:"string", format:"date-time" },
          expires_at:{ type:["string", "null"], format:"date-time" }
        }
      },
      InboundEnvelope:{
        type:"object", required:["tenant_id", "channel", "conversation_id", "message"],
        properties:{
          schema_version:{ enum:["1.0","1.1"] },
          tenant_id:{ $ref:"#/components/schemas/TenantId" },
          channel:{ type:"string", enum:ACQUISITION_CHANNELS.map((item) => item.id) },
          conversation_id:{ type:"string", maxLength:128 },
          message:{ type:"object", required:["text"], properties:{ id:{ type:"string" }, text:{ type:"string", minLength:1, maxLength:1000 }, timestamp:{ type:["string", "number"] } } },
          actor:{ type:"object", properties:{ external_user_id:{ type:"string" }, customer_id:{ type:"string" }, display_name:{ type:"string" } } },
          context:{ type:"object" },
          interests:{ type:"array", maxItems:10, items:{ type:["string", "object"] } }
        }
      },
      AgentResult:{
        type:"object", required:["service", "channel", "conversation_id", "status", "reply", "guardrails"],
        properties:{
          service:{ const:"huamei-acquisition-agent" }, tenant_id:{ $ref:"#/components/schemas/TenantId" }, channel:{ type:"string" }, conversation_id:{ type:"string" }, status:{ type:"string" },
          reply:{ type:"object", properties:{
            text:{ type:"string" },
            segments:{ type:"array", items:{ type:"string", maxLength:80 } },
            citations:{ type:"array" },
            media:{
              type:"array",
              maxItems:2,
              description:"仅经公开资料投放策略审核的医生/项目宣传图片；不含案例、术前术后、聊天或客户资料。",
              items:{ type:"object", required:["id", "type", "url", "title"], properties:{ id:{ type:"string" }, type:{ const:"image" }, url:{ type:"string" }, title:{ type:"string" }, alt:{ type:"string" }, requires_verification:{ type:"boolean" } } }
            },
            suggestions:{ type:"array" }
          } },
          profile_signals:{ type:"object" },
          orchestration:{
            type:"object",
            description:"渠道无关的会话状态、动态检索计划、来源声明、不确定性说明与待确认写操作。仅action_proposal.status=confirmation_required不代表业务写入已经执行。"
          },
          handover:{ type:"object" }, delivery:{ type:"object" }, lead_capture:{ type:"object" }, guardrails:{ type:"object" }
        }
      }
    }
  },
  security:[{ CallerIdAuth:[], ServiceKeyAuth:[] }]
});
