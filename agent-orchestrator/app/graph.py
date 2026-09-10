from __future__ import annotations

import hashlib
import json
import re
import uuid
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

from .contracts import OrchestrateRequest, TurnDecision


class GraphState(TypedDict, total=False):
    run_id: str
    route: str
    risk_signal: str | None
    decision: TurnDecision


class TurnRuntimeContext(TypedDict):
    # Runtime context is passed to the graph for one invocation but is not a
    # graph-state channel. This keeps message text and authorization context
    # out of durable checkpoints. State itself may only hold opaque IDs,
    # classified signals and a schema-validated decision.
    request: OrchestrateRequest


HIGH_RISK_PATTERNS = (
    r"呼吸困难|无法呼吸|意识不清|昏迷|大出血|止不住血|胸痛|剧烈胸痛",
    r"术后.*(?:高烧|发热|剧痛|感染|坏死)|(?:高烧|剧痛).*(?:术后|手术)",
    r"自杀|不想活|伤害自己",
)
COMPLAINT_PATTERN = re.compile(r"投诉|举报|曝光|欺骗|退钱|维权")
ACTION_PATTERN = re.compile(r"预约|约面诊|报名|创建工单|提交申请")
GREETING_PATTERN = re.compile(r"^(?:你好|您好|嗨|在吗|哈喽)[！!。,.， ]*$")
ENTERPRISE_PATTERN = re.compile(r"华美|医院|医生|院长|项目|产品|价格|活动|排班|预约|面诊|海报|图片|PDF", re.I)


def _reason_code(value: str) -> str:
    return re.sub(r"[^A-Z0-9_]", "_", value.upper())[:96]


def _hash_decision(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _base_decision(state: GraphState, request: OrchestrateRequest, *, status: str, policy: str, reason: str, segments: list[str] | None = None,
                   handover: dict[str, str] | None = None, pending_action_preview: dict[str, Any] | None = None) -> TurnDecision:
    run_id = state["run_id"]
    material = {
        "contract_version": request.contract_version,
        "turn": request.turn.model_dump(mode="json"),
        "status": status,
        "policy": policy,
        "reason": reason,
        "segments": segments or [],
        "handover": handover,
        "pending_action_preview": pending_action_preview,
    }
    return TurnDecision.model_validate({
        "status": status,
        "run_id": run_id,
        # A graph result is not a durable checkpoint receipt. The real
        # checkpoint id, if a future admitted runtime uses one, must be read
        # from the Postgres checkpointer and bound by Node before commit.
        "checkpoint_id": None,
        "decision_hash": _hash_decision(material),
        "conversation_update": {
            "safe_summary_ref": None,
            "slot_updates": [],
            "state_schema_version": request.turn.engine_pin.state_schema_version,
        },
        "response": {
            "segments": segments or [],
            "citations": [],
            "media_asset_ids": [],
            "suggested_next_step": "",
        },
        "handover": handover,
        "pending_action_preview": pending_action_preview,
        "evidence": {"release_id": None, "snapshot_id": None},
        "policy": {"decision": policy, "reason_code": _reason_code(reason)},
    })


def initialize(_: GraphState) -> GraphState:
    return {"run_id": f"lg_{uuid.uuid4().hex}"}


def classify_safety(_: GraphState, runtime: Runtime[TurnRuntimeContext]) -> GraphState:
    message = runtime.context["request"].input.redacted_message
    risk = next(("MEDICAL_EMERGENCY" for pattern in HIGH_RISK_PATTERNS if re.search(pattern, message, re.I)), None)
    if risk is None and COMPLAINT_PATTERN.search(message):
        risk = "COMPLAINT_OR_ESCALATION"
    return {"risk_signal": risk}


def choose_route(state: GraphState, runtime: Runtime[TurnRuntimeContext]) -> GraphState:
    message = runtime.context["request"].input.redacted_message
    if state.get("risk_signal"):
        return {"route": "safety_or_handover"}
    if GREETING_PATTERN.fullmatch(message):
        return {"route": "greeting_template"}
    if ACTION_PATTERN.search(message):
        return {"route": "action_preview"}
    if ENTERPRISE_PATTERN.search(message):
        return {"route": "approved_knowledge"}
    return {"route": "general_education"}


def form_turn_decision(state: GraphState, runtime: Runtime[TurnRuntimeContext]) -> GraphState:
    request = runtime.context["request"]
    route = state["route"]
    risk = state.get("risk_signal")
    if risk == "MEDICAL_EMERGENCY":
        decision = _base_decision(
            state, request,
            status="policy_blocked",
            policy="handover",
            reason="MEDICAL_EMERGENCY",
            segments=["您描述的情况可能需要及时的线下医疗处理。", "如有呼吸困难、意识异常、持续出血或剧烈不适，请立即联系急救或就近医疗机构。"],
            handover={"reason": "medical_emergency", "priority": "urgent"},
        )
    elif risk == "COMPLAINT_OR_ESCALATION":
        decision = _base_decision(
            state, request,
            status="policy_blocked",
            policy="handover",
            reason="COMPLAINT_OR_ESCALATION",
            segments=["我已识别到您需要人工协助。", "人工顾问会根据后续流程继续跟进；本服务不会在此自动承诺处理结果或时效。"],
            handover={"reason": "complaint_or_escalation", "priority": "high"},
        )
    elif route == "greeting_template":
        decision = _base_decision(
            state, request,
            status="prepared",
            policy="allow",
            reason="GREETING_TEMPLATE",
            segments=["您好，我是上海华美医院顾问安安。", "您想了解哪个医美项目，或有哪些改善需求？"],
        )
    elif route == "action_preview":
        decision = _base_decision(
            state, request,
            status="interrupted",
            policy="clarify",
            reason="WRITE_CONFIRMATION_REQUIRED",
            segments=["我可以先为您整理预约或报名信息。", "在您确认前，不会创建预约、工单或发送任何外部通知。"],
            pending_action_preview={"action_type": "unresolved_write", "confirmation_required": True, "external_effect": False},
        )
    elif route == "approved_knowledge":
        decision = _base_decision(
            state, request,
            status="prepared",
            policy="clarify",
            reason="APPROVED_KNOWLEDGE_TOOL_REQUIRED",
            segments=["这个问题需要基于当前已发布的院内资料核验后再回答。"],
        )
    else:
        decision = _base_decision(
            state, request,
            status="prepared",
            policy="clarify",
            reason="CONTROLLED_GENERAL_EDUCATION",
            segments=["我可以先为您提供一般性科普信息。", "如果涉及个人情况、诊疗方案或风险判断，需要由专业医生面诊评估。"],
        )
    return {"decision": decision}


def build_turn_graph(checkpointer: Any | None = None):
    graph = StateGraph(GraphState, context_schema=TurnRuntimeContext)
    graph.add_node("initialize", initialize)
    graph.add_node("classify_safety", classify_safety)
    graph.add_node("choose_route", choose_route)
    graph.add_node("form_turn_decision", form_turn_decision)
    graph.add_edge(START, "initialize")
    graph.add_edge("initialize", "classify_safety")
    graph.add_edge("classify_safety", "choose_route")
    graph.add_edge("choose_route", "form_turn_decision")
    graph.add_edge("form_turn_decision", END)
    return graph.compile(checkpointer=checkpointer)


TURN_GRAPH = build_turn_graph()


async def orchestrate_turn(request: OrchestrateRequest, graph: Any = TURN_GRAPH) -> TurnDecision:
    result = await graph.ainvoke(
        {},
        config={"configurable": {"thread_id": request.turn.thread_id}},
        context={"request": request},
    )
    return result["decision"]
