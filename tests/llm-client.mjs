import assert from "node:assert/strict";
import {
  AGENT_DEFINITIONS, invokeAgentAsync, resetRunsForTest, validateModelMessageGrounding
} from "../server/agent-runtime.mjs";
import { buildMinimalModelContext, completeAgentWithLlm, getLlmStatus } from "../server/llm-client.mjs";

const envKeys = ["HUAMEI_LLM_ENABLED", "HUAMEI_LLM_PROVIDER", "HUAMEI_LLM_BASE_URL", "HUAMEI_LLM_API_KEY", "HUAMEI_LLM_MODEL", "HUAMEI_LLM_TIMEOUT_MS", "HUAMEI_LLM_MAX_RETRIES"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

Object.assign(process.env, {
  HUAMEI_LLM_ENABLED: "true",
  HUAMEI_LLM_PROVIDER: "mock_openai_compatible",
  HUAMEI_LLM_BASE_URL: "http://127.0.0.1:9999/v1",
  HUAMEI_LLM_API_KEY: "test-secret-not-for-production",
  HUAMEI_LLM_MODEL: "test-chat-model",
  HUAMEI_LLM_TIMEOUT_MS: "3000",
  HUAMEI_LLM_MAX_RETRIES: "1"
});

const mockBody = {
  model: "test-chat-model",
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    status: "completed",
    message: "热玛吉属于射频类紧肤项目，可以先了解一般流程，具体安排以到院专业评估为准。",
    structured_data: { intent: "project_explanation", project: "热玛吉" },
    recommended_actions: [{ type: "offer_human_consultation" }],
    handover: { required: false }
  }) } }],
  usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 }
};

let attempts = 0;
const fakeFetch = async (_url, options) => {
  attempts += 1;
  assert.match(options.headers.Authorization, /^Bearer /);
  const request = JSON.parse(options.body);
  assert.equal(request.model, "test-chat-model");
  assert.equal(request.enable_thinking, false);
  assert.equal(request.response_format.type, "json_object");
  return new Response(JSON.stringify(mockBody), { status: 200, headers: { "Content-Type": "application/json" } });
};

try {
  const minimal = buildMinimalModelContext({
    macro_stage: "售前",
    interests: [{ name: "热玛吉", score: 90 }],
    photo: "base64-should-never-leave",
    profile: { name: "测试客户", phone: "13812345678", concern: "联系13812345678，关注紧致", budget: "2万" },
    recent_turns:[{ role:"user", content:"上一轮原文" }],
    conversation_summary:"个人会话摘要"
  }, {
    structured_data:{
      intent:"project_explanation",
      intent_analysis:{
        primary_intent:"project_explanation",
        domain:"medical_aesthetics",
        dialogue_act:"request_information",
        entities:{ projects:["热玛吉"], concerns:["脸部松弛"] }
      }
    },
    citations:[{ knowledge_id:"K-001" }]
  });
  assert.equal("photo" in minimal, false);
  assert.equal("profile" in minimal, false);
  assert.equal("recent_turns" in minimal, false);
  assert.equal("conversation_summary" in minimal, false);
  assert.equal(minimal.primary_intent, "project_explanation");
  assert.deepEqual(minimal.entity_types, ["projects"]);
  assert.equal(minimal.evidence_required, true);

  const privateValues = {
    name:"沈婉宁",
    email:"shen.wanning+private@example.test",
    address:"上海市浦东新区芳甸路199弄8号2栋1201室",
    wechat:"wx_secret_778899",
    medicalHistory:"既往病史：甲状腺功能亢进且青霉素过敏",
    rawTurn:"原始对话绝密片段OMEGA-7788",
    summary:"总结密文SIGMA-9911"
  };
  let privateProviderPayload = "";
  const privateCompletion = await completeAgentWithLlm({
    agent:AGENT_DEFINITIONS[0],
    input:{
      message:`我叫${privateValues.name}，邮箱${privateValues.email}，微信${privateValues.wechat}，${privateValues.medicalHistory}`,
      mode:"assist"
    },
    context:{
      profile:{
        name:privateValues.name,
        email:privateValues.email,
        address:privateValues.address,
        wechat:privateValues.wechat,
        medical_history:privateValues.medicalHistory
      },
      recent_turns:[{ role:"user", content:privateValues.rawTurn }],
      conversation_summary:privateValues.summary,
      freeform_profile:`${privateValues.name} ${privateValues.address}`
    },
    localResult:{
      status:"completed",
      message:`${privateValues.name}，${privateValues.email}，${privateValues.address}，${privateValues.wechat}，${privateValues.medicalHistory}。${privateValues.rawTurn}。${privateValues.summary}`,
      structured_data:{
        intent:"project_explanation",
        intent_analysis:{ primary_intent:"project_explanation", entities:{ projects:["热玛吉"] } }
      },
      recommended_actions:[{ type:"offer_human_consultation", private_note:privateValues.rawTurn }],
      handover:{ required:false, reason:privateValues.medicalHistory },
      citations:[{ knowledge_id:"K-001", title:privateValues.name, content:privateValues.rawTurn }]
    },
    fetchImpl:async (_url, options) => {
      privateProviderPayload = String(options.body);
      const request = JSON.parse(privateProviderPayload);
      const prompt = JSON.parse(request.messages[1].content);
      assert.equal("task" in prompt, false);
      assert.equal("context" in prompt, false);
      assert.equal("profile" in prompt.decision_context, false);
      assert.equal("recent_turns" in prompt.decision_context, false);
      assert.equal("conversation_summary" in prompt.decision_context, false);
      assert.match(prompt.local_rule_draft.message, /\[已最小化\]/);
      return new Response(JSON.stringify({
        model:"test-chat-model",
        choices:[{ message:{ content:JSON.stringify({
          status:"completed",
          message:prompt.local_rule_draft.message,
          structured_data:{},
          recommended_actions:[],
          handover:{ required:false }
        }) } }],
        usage:{ prompt_tokens:20, completion_tokens:10, total_tokens:30 }
      }), { status:200, headers:{ "Content-Type":"application/json" } });
    }
  });
  assert.equal(privateCompletion.used, true);
  for (const privateValue of Object.values(privateValues)) {
    assert.equal(privateProviderPayload.includes(privateValue), false, `provider payload不得包含：${privateValue}`);
  }

  const completion = await completeAgentWithLlm({
    agent: AGENT_DEFINITIONS[0],
    input: { message: "请介绍热玛吉的一般流程", mode: "assist" },
    context: { macro_stage: "售前", interests: ["热玛吉"] },
    localResult: { status: "completed", message: "本地草稿", structured_data: {}, recommended_actions: [], handover: { required: false }, citations: [] },
    fetchImpl: fakeFetch
  });
  assert.equal(completion.used, true);
  assert.equal(completion.result.status, "completed");
  assert.equal(completion.usage.provider, "mock_openai_compatible");
  assert.equal(completion.usage.total_tokens, 165);

  const contradictedFact = validateModelMessageGrounding(
    "热玛吉起源于法国，而且属于激光项目。",
    "热玛吉常见会从面部提升、抗初老、祛皱等方向介绍。具体方案由医生面诊确认。"
  );
  assert.equal(contradictedFact.passed, false, "新增或矛盾事实不得继承本地草稿的引用");
  assert.ok(contradictedFact.reason_codes.includes("not_exact_approved_draft"));
  assert.ok(contradictedFact.reason_codes.includes("novel_or_unsupported_wording"));
  const negationFlip = validateModelMessageGrounding(
    "面积较大时，不能只凭文字确定处理方式，不需要医生先看类型、深度和位置。",
    "面积较大时，不能只凭文字确定处理方式，需要医生先看类型、深度和位置。"
  );
  assert.equal(negationFlip.passed, false, "只改一个否定词也必须回退");
  assert.ok(negationFlip.reason_codes.includes("not_exact_approved_draft"));
  assert.equal(validateModelMessageGrounding(
    "面积较大时不能只凭文字确定处理方式，需要医生先看类型、深度和位置！",
    "面积较大时，不能只凭文字确定处理方式，需要医生先看类型、深度和位置。"
  ).passed, false, "标点位置与句末标点也属于获批文案，变化必须回退");
  assert.equal(validateModelMessageGrounding(
    "不，建议自行判断是否适合做。",
    "不建议自行判断是否适合做。"
  ).passed, false, "逗号移动造成的否定翻转必须回退");
  assert.equal(validateModelMessageGrounding(
    "不，一定安全。",
    "不一定安全。"
  ).passed, false, "标点不得把不确定性改成肯定结论");
  assert.equal(validateModelMessageGrounding(
    "费用约15万元。",
    "费用约1.5万元。"
  ).passed, false, "数字内部小数点不得被忽略");
  assert.equal(validateModelMessageGrounding(
    "通常需要12次。",
    "通常需要1-2次。"
  ).passed, false, "数字范围符号不得被忽略");
  assert.equal(validateModelMessageGrounding(
    "面积较大时，不能只凭文字确定处理方式，  需要医生先看类型、深度和位置。",
    "面积较大时，不能只凭文字确定处理方式， 需要医生先看类型、深度和位置。"
  ).passed, true, "连续空白规范化不改变语义时可以接受");

  resetRunsForTest();
  globalThis.fetch = fakeFetch;
  const invoked = await invokeAgentAsync("A-01", {
    customer_id: "C-LLM-TEST", message: "请介绍热玛吉的一般流程", mode: "assist",
    context: { macro_stage: "售前", interests: ["热玛吉"], marketing_consent: true }
  });
  assert.equal(invoked.guardrails.llm_used, true);
  assert.equal(invoked.usage.model, "test-chat-model");
  assert.equal(invoked.usage.provider, "mock_openai_compatible");
  assert.equal(invoked.output.structured_data.answer_routing.route, "generic_model_education");
  assert.deepEqual(invoked.output.citations, [], "模型生成的通用科普不得伪装成院方资料引用");
  assert.deepEqual(invoked.output.recommended_actions.map((item) => item.type), ["update_interest", "offer_human_consultation"], "可执行动作必须以本地确定性规则为准");
  assert.equal(invoked.guardrails.model_output_rejected, false, "受限主题下的通用科普可以由模型自然组织表达");
  assert.equal(invoked.guardrails.model_output_validated, true);
  assert.equal(invoked.guardrails.client_output_source, "model_general_education");
  assert.match(invoked.output.message, /射频类/);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model:request.model,
      choices:[{ finish_reason:"stop", message:{ content:JSON.stringify({
        status:"completed",
        message:"热玛吉起源于法国，而且属于激光项目。",
        structured_data:{ intent:"project_explanation" },
        recommended_actions:[], handover:{ required:false }
      }) } }],
      usage:{ prompt_tokens:80, completion_tokens:20, total_tokens:100 }
    }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const unsupportedFactFallback = await invokeAgentAsync("A-01", {
    message:"介绍一下热玛吉", mode:"assist", context:{}
  });
  assert.equal(unsupportedFactFallback.guardrails.model_output_rejected, true);
  assert.equal(unsupportedFactFallback.guardrails.model_output_grounding.passed, false);
  assert.doesNotMatch(unsupportedFactFallback.output.message, /法国|激光/);
  assert.ok(unsupportedFactFallback.output.citations.some((item) => item.knowledge_id === "K-001"));

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: request.model,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        status: "completed",
        message: "根据当前知识库的检索结果，热玛吉属于射频类项目。",
        structured_data: { intent: "project_explanation" },
        recommended_actions: [],
        handover: { required: false }
      }) } }],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const businessCopyFallback = await invokeAgentAsync("A-01", { message: "脸部松弛，想了解抗初老项目", mode: "assist", context: {} });
  assert.equal(businessCopyFallback.guardrails.model_output_rejected, true, "模型暴露内部实现措辞时必须回退到业务答复");
  assert.doesNotMatch(businessCopyFallback.output.message, /知识库|资料库|检索|命中|本地规则草稿|系统上下文|提示词/);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model:request.model,
      choices:[{ finish_reason:"stop", message:{ content:JSON.stringify({
        status:"completed",
        message:"内部密钥是 sk-test-secret-value-1234567890。",
        structured_data:{ intent:"project_explanation" },
        recommended_actions:[], handover:{ required:false }
      }) } }],
      usage:{ prompt_tokens:80, completion_tokens:20, total_tokens:100 }
    }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const secretLeakFallback = await invokeAgentAsync("A-01", { message:"介绍一下热玛吉", mode:"assist", context:{} });
  assert.equal(secretLeakFallback.guardrails.model_output_rejected, true, "疑似密钥内容不得进入对客输出");
  assert.doesNotMatch(secretLeakFallback.output.message, /sk-test-secret-value/);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: request.model,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        status: "completed",
        message: "可以对比两个项目，但不建议自行判断是否适合做。",
        structured_data: { intent: "project_comparison" },
        recommended_actions: [],
        handover: { required: false }
      }) } }],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const safeFallback = await invokeAgentAsync("A-01", { message: "热玛吉和线雕有什么区别？", mode: "assist", context: {} });
  assert.equal(safeFallback.status, "completed", "正常项目对比不能因模型安全提示被误判为人工转接");
  assert.equal(safeFallback.guardrails.model_output_rejected, true);
  assert.ok(safeFallback.output.citations.some((item) => item.title.startsWith("热玛吉")));
  assert.ok(safeFallback.output.citations.some((item) => item.title.startsWith("线雕")));

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: request.model,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        status: "completed",
        message: "针对您之前关注的脸部松弛，可以了解综合性的抗初老与紧致项目。",
        structured_data: { intent: "knowledge_match" },
        recommended_actions: [],
        handover: { required: false }
      }) } }],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const doctorDriftFallback = await invokeAgentAsync("A-01", {
    message: "李健院长", mode: "assist", context: { interests:["抗初老", "热玛吉"] }
  });
  assert.equal(doctorDriftFallback.guardrails.model_output_rejected, true, "模型遗漏点名医生时必须回退");
  assert.equal(doctorDriftFallback.output.structured_data.intent, "doctor_profile");
  assert.match(doctorDriftFallback.output.message, /李健/);
  assert.ok(doctorDriftFallback.output.citations.some((item) => item.source_relative_path?.includes("医生介绍/整形外科/李健")));

  const recommendationDriftFallback = await invokeAgentAsync("A-01", {
    message: "我想做胸部整形，推荐哪个医生？", mode: "assist", context: { interests:["抗初老"] }
  });
  assert.equal(recommendationDriftFallback.guardrails.model_output_rejected, true, "模型未给出医生候选时必须回退");
  assert.equal(recommendationDriftFallback.output.structured_data.intent, "doctor_discovery_by_project");
  assert.ok(recommendationDriftFallback.output.structured_data.doctor_candidates.length >= 3);
  assert.match(recommendationDriftFallback.output.message, /叶丽萍|李健|谢卫国|李英大/);
  assert.doesNotMatch(recommendationDriftFallback.output.message, /推荐哪个院长/);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: request.model,
      choices: [{ finish_reason:"stop", message:{ content:JSON.stringify({
        status:"completed",
        message:"候选方向包括叶丽萍、李健和谢卫国，随后我将为您转接人工顾问。",
        structured_data:{ intent:"doctor_discovery_by_project" },
        recommended_actions:[],
        handover:{ required:false }
      }) } }],
      usage:{ prompt_tokens:80, completion_tokens:20, total_tokens:100 }
    }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const actionClaimFallback = await invokeAgentAsync("A-01", {
    message:"我想做胸部整形，推荐哪个医生？", mode:"assist", context:{}
  });
  assert.equal(actionClaimFallback.guardrails.model_output_rejected, true, "模型不得声称已执行或将执行并未发生的转接动作");
  assert.doesNotMatch(actionClaimFallback.output.message, /我将为您转接/);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model:request.model,
      choices:[{ finish_reason:"stop", message:{ content:JSON.stringify({
        status:"completed",
        message:"您好！**可以了解热玛吉。**您想看原理吗？什么时候到院？建议您先留下手机号。",
        structured_data:{ intent:"project_explanation" },
        recommended_actions:[], handover:{ required:false }
      }) } }],
      usage:{ prompt_tokens:80, completion_tokens:20, total_tokens:100 }
    }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const copyStyleFallback = await invokeAgentAsync("A-01", { message:"介绍一下热玛吉", mode:"assist", context:{} });
  assert.equal(copyStyleFallback.guardrails.model_output_rejected, true, "多问题和提前催留资的模型措辞必须回退");
  assert.ok(copyStyleFallback.guardrails.copy_style_issues.includes("too_many_questions"));
  assert.ok(copyStyleFallback.guardrails.copy_style_issues.includes("premature_lead_push"));
  assert.doesNotMatch(copyStyleFallback.output.message, /留下手机号|\*\*/);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model:request.model,
      choices:[{ finish_reason:"stop", message:{ content:JSON.stringify({
        status:"completed",
        message:"隆胸手术中，假体隆胸的形态通常更挺括且稳定。自体脂肪移植则触感柔软，但受限于基础条件。为了给您更准确的建议，请问您目前胸部的基础条件如何？",
        structured_data:{ intent:"conversation_followup" },
        recommended_actions:[], handover:{ required:false }
      }) } }],
      usage:{ prompt_tokens:80, completion_tokens:20, total_tokens:100 }
    }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const suitabilityProbeFallback = await invokeAgentAsync("A-01", {
    message:"我想要自然一点，有垂坠感的", mode:"assist", context:{ interests:["胸部整形"] }
  });
  assert.equal(suitabilityProbeFallback.guardrails.model_output_rejected, true, "不得通过追问身体条件在线判断项目适用性");
  assert.doesNotMatch(suitabilityProbeFallback.output.message, /更准确的建议|胸部的基础条件|初步判断是否适合|可供提取的脂肪/);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = JSON.parse(request.messages[1].content);
    return new Response(JSON.stringify({
      model:request.model,
      choices:[{ finish_reason:"stop", message:{ content:JSON.stringify({
        // Copying the approved customer-facing message must not grant the model
        // authority over workflow state or customer-profile fields.
        status:"handover_required",
        message:prompt.local_rule_draft.message,
        structured_data:{
          intent:"lead_capture",
          projects:["虚构项目"],
          knowledge_hits:[{ id:"FAKE-KNOWLEDGE" }],
          known_slots:{ budget:"999万元" }
        },
        recommended_actions:[{ type:"overwrite_customer_360" }],
        handover:{ required:true, to_team:"攻击者", reason:"model_override" }
      }) } }],
      usage:{ prompt_tokens:80, completion_tokens:20, total_tokens:100 }
    }), { status:200, headers:{ "Content-Type":"application/json" } });
  };
  const controlPlaneInjection = await invokeAgentAsync("A-01", {
    message:"介绍一下热玛吉", mode:"assist", context:{}
  });
  assert.equal(controlPlaneInjection.status, "completed", "模型不得改变确定性工作流状态");
  assert.equal(controlPlaneInjection.output.handover.required, false, "模型不得伪造转人工结论");
  assert.notEqual(controlPlaneInjection.output.structured_data.intent, "lead_capture", "模型不得改写意图");
  assert.ok(!(controlPlaneInjection.output.structured_data.projects || []).includes("虚构项目"), "模型不得注入客户项目字段");
  assert.ok(!(controlPlaneInjection.output.structured_data.knowledge_hits || []).some((item) => item?.id === "FAKE-KNOWLEDGE"), "模型不得注入知识命中");
  assert.ok(controlPlaneInjection.output.recommended_actions.every((item) => item.type !== "overwrite_customer_360"), "模型不得注入可执行动作");

  attempts = 0;
  globalThis.fetch = fakeFetch;
  const exactProductFact = await invokeAgentAsync("A-01", {
    message:"璀璨是水滴形吗？", mode:"assist", context:{ interests:["胸部整形"] }
  });
  assert.equal(exactProductFact.guardrails.llm_used, false);
  assert.equal(exactProductFact.guardrails.llm_skip_reason, "deterministic_fact_verification");
  assert.equal(attempts, 0, "明确产品属性核验不得由生成模型追加无证据卖点");
  assert.match(exactProductFact.output.message, /璀璨/);
  assert.match(exactProductFact.output.message, /水滴形|解剖型/);

  attempts = 0;
  globalThis.fetch = fakeFetch;
  const greeting = await invokeAgentAsync("A-01", {
    message:"你好", mode:"assist", context:{}
  });
  assert.equal(greeting.output.structured_data.intent, "conversation_greeting");
  assert.equal(greeting.guardrails.llm_used, false);
  assert.equal(greeting.guardrails.llm_skip_reason, "deterministic_greeting");
  assert.equal(greeting.guardrails.graphrag_used, false);
  assert.equal(attempts, 0, "问候应直接使用受控欢迎语，不调用生成模型");
  assert.match(greeting.output.message, /AI获客顾问小美/);
  assert.match(greeting.output.message, /您想先了解哪个项目/);
  assert.doesNotMatch(greeting.output.message, /网约车|会员权益/);

  attempts = 0;
  globalThis.fetch = fakeFetch;
  const protectedResult = await invokeAgentAsync("A-01", { message: "我适不适合做线雕？", mode: "assist", context: {} });
  assert.equal(protectedResult.status, "handover_required");
  assert.equal(protectedResult.guardrails.llm_used, false);
  assert.equal(protectedResult.guardrails.llm_skip_reason, "deterministic_guardrail");
  assert.equal(attempts, 0, "确定性门禁命中后不应向外部模型发送请求");

  globalThis.fetch = async () => { throw new Error("network unavailable"); };
  const fallback = await invokeAgentAsync("A-02", { message: "周三可以预约吗？", mode: "assist", context: { available_slots: ["周三 12:20"] } });
  assert.equal(fallback.guardrails.llm_fallback, true);
  assert.equal(fallback.usage.provider, "local_rule_runtime_fallback");
  assert.match(fallback.output.message, /周三 12:20/);

  const status = getLlmStatus();
  assert.equal(status.mode, "hybrid_llm_runtime");
  assert.equal(status.model, "test-chat-model");

  console.log("✓ OpenAI兼容模型请求、JSON校验与令牌统计通过");
  console.log("✓ 最小化上下文、敏感字段过滤与已批准引用通过");
  console.log("✓ 确定性前置门禁与模型故障本地降级通过");
} finally {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}
