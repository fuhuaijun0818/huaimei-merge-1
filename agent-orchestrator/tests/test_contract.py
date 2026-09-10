from __future__ import annotations

import hashlib
import os
import unittest
from unittest.mock import patch

SECRET = "orchestrator_local_test_secret_7wP6yQ5rT4uE3iO2aS1dF0gH"
os.environ.setdefault("HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET", SECRET)

from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from app.contracts import OrchestrateRequest
from app.graph import build_turn_graph, orchestrate_turn
from app.main import create_app
from app.service_auth import issue_service_token
from app.settings import Settings


def payload(message: str = "你好") -> dict:
    authorization_context = "authorized-local-gateway-context"
    return {
        "contract_version": "2026-09-04.1",
        "turn": {
            "tenant_id": "huamei-shanghai",
            "conversation_id": "conversation_opaque_1",
            "thread_id": "lgth_opaque_thread_1",
            "message_id": "message_opaque_1",
            "turn_seq": 1,
            "payload_hash": hashlib.sha256(message.encode("utf-8")).hexdigest(),
            "expected_state_version": 0,
            "fencing_token": 1,
            "engine_pin": {"engine": "langgraph", "graph_version": "v1", "state_schema_version": "v1"},
        },
        "input": {"redacted_message": message, "attachment_refs": [], "language": "zh-CN"},
        "authorization_context": authorization_context,
        "trace": {"trace_id": "trace_opaque_1"},
    }


class ContractTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET"] = SECRET
        self.settings = Settings.from_env()
        self.client = TestClient(create_app(self.settings))
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)

    def authorized_headers(self, value: dict) -> dict[str, str]:
        context_hash = hashlib.sha256(value["authorization_context"].encode("utf-8")).hexdigest()
        token = issue_service_token(
            SECRET,
            subject="huamei-web-gateway",
            audience=self.settings.audience,
            tenant_id=value["turn"]["tenant_id"],
            authorization_context_hash=context_hash,
        )
        return {"Authorization": f"Bearer {token}", "X-Request-Id": "req_contract_1"}

    def test_health_and_greeting_decision(self) -> None:
        self.assertEqual(self.client.get("/health").status_code, 200)
        value = payload("你好")
        response = self.client.post("/internal/v1/orchestrate", json=value, headers=self.authorized_headers(value))
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["status"], "prepared")
        self.assertEqual(body["policy"]["decision"], "allow")
        self.assertEqual(len(body["response"]["segments"]), 2)
        self.assertIsNone(body["checkpoint_id"], "不得伪造尚未读取到的 durable checkpoint id")

    def test_checkpoint_state_excludes_message_and_authorization_context(self) -> None:
        import asyncio

        request = payload("我想了解华美的项目")
        parsed = OrchestrateRequest.model_validate(request)
        graph = build_turn_graph(InMemorySaver())
        config = {"configurable": {"thread_id": parsed.turn.thread_id}}
        asyncio.run(orchestrate_turn(parsed, graph))
        state = asyncio.run(graph.aget_state(config))
        persisted = repr(state.values)
        self.assertNotIn(request["input"]["redacted_message"], persisted)
        self.assertNotIn(request["authorization_context"], persisted)

    def test_checkpoint_url_is_not_enabled_implicitly_during_p0(self) -> None:
        with patch.dict(os.environ, {
            "HUAMEI_LANGGRAPH_CHECKPOINT_DATABASE_URL": "postgresql://ignored.example/checkpoints",
            "HUAMEI_LANGGRAPH_ENABLE_DURABLE_CHECKPOINTS": "false",
        }, clear=False):
            settings = Settings.from_env()
            with TestClient(create_app(settings)) as client:
                body = client.get("/health").json()
        self.assertEqual(body["checkpoint_backend"], "disabled_p0")

    def test_durable_checkpoint_and_production_are_not_admitted_during_p0(self) -> None:
        with patch.dict(os.environ, {
            "HUAMEI_LANGGRAPH_ENABLE_DURABLE_CHECKPOINTS": "true",
            "HUAMEI_LANGGRAPH_CHECKPOINT_DATABASE_URL": "postgresql://checkpoint.example/huamei",
        }, clear=False):
            with self.assertRaisesRegex(RuntimeError, "LANGGRAPH_DURABLE_CHECKPOINTS_NOT_ADMITTED"):
                Settings.from_env()
        with patch.dict(os.environ, {
            "HUAMEI_LANGGRAPH_RUNTIME_ENV": "production",
            "HUAMEI_LANGGRAPH_ENABLE_DURABLE_CHECKPOINTS": "false",
            "HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET": "m7pX2kQ8vL4rN9cD5wF1aH6jS3eT0yU7iO2bG4zK",
        }, clear=False):
            with self.assertRaisesRegex(RuntimeError, "LANGGRAPH_PRODUCTION_RUNTIME_NOT_ADMITTED"):
                Settings.from_env()

    def test_token_and_pii_are_rejected(self) -> None:
        value = payload()
        self.assertEqual(self.client.post("/internal/v1/orchestrate", json=value).status_code, 401)
        pii = payload("请联系我 138 1234 5678")
        response = self.client.post("/internal/v1/orchestrate", json=pii, headers=self.authorized_headers(pii))
        self.assertEqual(response.status_code, 422)

    def test_safety_and_write_decisions_are_not_executed(self) -> None:
        emergency = payload("术后一直大出血，还呼吸困难")
        emergency_response = self.client.post("/internal/v1/orchestrate", json=emergency, headers=self.authorized_headers(emergency))
        self.assertEqual(emergency_response.status_code, 200)
        self.assertEqual(emergency_response.json()["status"], "policy_blocked")
        self.assertEqual(emergency_response.json()["policy"]["decision"], "handover")

        write = payload("我想预约面诊")
        write_response = self.client.post("/internal/v1/orchestrate", json=write, headers=self.authorized_headers(write))
        self.assertEqual(write_response.status_code, 200)
        self.assertEqual(write_response.json()["status"], "interrupted")
        self.assertTrue(write_response.json()["pending_action_preview"]["confirmation_required"])
        self.assertFalse(write_response.json()["pending_action_preview"]["external_effect"])


if __name__ == "__main__":
    unittest.main()
