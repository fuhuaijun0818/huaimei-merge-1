from __future__ import annotations

import json
import inspect
import os
import unittest
import asyncio
from importlib.metadata import version
from pathlib import Path
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace
import pandas as pd

from fastapi.testclient import TestClient

from app.config import Settings
from app.engine import create_engine
from app.main import create_app
from app.models import RetrievalRequest
from app.official_engine import OfficialGraphRagEngine


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def settings(service_key: str = "", metrics_token: str = "") -> Settings:
    return Settings(
        service_name="huamei-graphrag-retrieval",
        host="127.0.0.1",
        port=4191,
        service_key=service_key,
        metrics_token=metrics_token,
        index_root=SERVICE_ROOT / "data" / "indexes",
        active_version=json.loads((SERVICE_ROOT / "data" / "indexes" / "current.json").read_text())["version"],
        engine="bootstrap",
        max_concurrency=128,
        queue_timeout_seconds=1,
        request_timeout_seconds=6,
        cache_ttl_seconds=300,
        cache_max_entries=100,
        max_top_k=12,
        official_project_root=SERVICE_ROOT / "graphrag_project",
    )


class RetrievalServiceTest(unittest.TestCase):
    def test_production_requires_strong_service_key_before_startup(self):
        base = settings()
        for weak_key in ("", "short", "x" * 64, "replace_with_service_secret"):
            production_settings = Settings(
                **{
                    field: getattr(base, field)
                    for field in base.__dataclass_fields__
                    if field not in {"service_key", "metrics_token", "engine", "environment"}
                },
                service_key=weak_key,
                metrics_token="Metrics_6mQ9sC2xV7bK4pN8tR1yF5hJ0zW3dL",
                engine="official",
                environment="production",
            )
            with self.subTest(weak_key=weak_key), self.assertRaisesRegex(
                RuntimeError,
                "PRODUCTION_GRAPHRAG_SERVICE_KEY_REQUIRED",
            ):
                create_app(production_settings)

        valid = Settings(
            **{
                field: getattr(base, field)
                for field in base.__dataclass_fields__
                if field not in {"service_key", "metrics_token", "engine", "environment"}
            },
            service_key="GraphRAG_9vD2mQ7xK4cP8tN5sL1wB6yF3hJ0zR",
            metrics_token="Metrics_6mQ9sC2xV7bK4pN8tR1yF5hJ0zW3dL",
            engine="official",
            environment="production",
        )
        self.assertIsNotNone(create_app(valid))

    def test_production_requires_independent_strong_metrics_token(self):
        base = settings()
        service_key = "GraphRAG_9vD2mQ7xK4cP8tN5sL1wB6yF3hJ0zR"
        for metrics_token, expected in (
            ("", "PRODUCTION_GRAPHRAG_METRICS_TOKEN_REQUIRED"),
            ("short", "PRODUCTION_GRAPHRAG_METRICS_TOKEN_REQUIRED"),
            (service_key, "PRODUCTION_GRAPHRAG_METRICS_TOKEN_REUSE_FORBIDDEN"),
        ):
            production_settings = Settings(
                **{
                    field: getattr(base, field)
                    for field in base.__dataclass_fields__
                    if field not in {"service_key", "metrics_token", "engine", "environment"}
                },
                service_key=service_key,
                metrics_token=metrics_token,
                engine="official",
                environment="production",
            )
            with self.subTest(metrics_token=metrics_token), self.assertRaisesRegex(RuntimeError, expected):
                create_app(production_settings)

    def test_official_context_maps_text_unit_back_to_approved_record(self):
        engine = OfficialGraphRagEngine.__new__(OfficialGraphRagEngine)
        engine.text_unit_record_ids = {"7": "KB-P-024", "text-unit-hash": "KB-P-024"}
        engine.text_unit_contents = {"7": "热玛吉的一般介绍", "text-unit-hash": "热玛吉的一般介绍"}
        engine.record_catalog = {
            "KB-P-024": {
                "record_id": "KB-P-024",
                "record_content_sha256": "a" * 64,
                "record_type": "project_record",
                "title": "热玛吉｜项目介绍",
                "text": "批准正文。热玛吉的一般介绍。恢复安排以面诊为准。",
                "source_relative_path": "项目介绍/皮肤美容科/热玛吉",
                "sensitivity": "public",
                "verification_note": "",
            }
        }
        context = {
            "sources": pd.DataFrame([{"id": "7", "text": "热玛吉的一般介绍"}]),
            "entities": pd.DataFrame([{"id": "entity-1", "description": "模型生成的实体摘要"}]),
        }
        evidence = engine._context_evidence(context, 5)
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0].record_id, "KB-P-024")
        self.assertEqual(evidence[0].source_relative_path, "项目介绍/皮肤美容科/热玛吉")
        self.assertNotEqual(evidence[0].record_id, "7")
        self.assertEqual(evidence[0].content, "热玛吉的一般介绍")
        self.assertEqual(engine._context_evidence({
            "sources": pd.DataFrame([{"id": "unmapped", "text": "不可映射"}])
        }, 5), [])
        self.assertEqual(engine._context_evidence({
            "sources": pd.DataFrame([{"id": "7", "text": "未审核的替换陈述"}])
        }, 5), [])

    def test_official_text_unit_must_be_an_approved_catalog_substring(self):
        catalog = {"KB-P-024": {"record_id": "KB-P-024", "text": "批准正文。热玛吉的一般介绍。"}}
        valid = pd.DataFrame([{
            "id": "unit-1", "human_readable_id": 7, "document_id": "KB-P-024", "text": "热玛吉的一般介绍"
        }])
        mapping, contents = OfficialGraphRagEngine._build_text_unit_bindings(valid, catalog)
        self.assertEqual(mapping["unit-1"], "KB-P-024")
        self.assertEqual(contents["7"], "热玛吉的一般介绍")

        tampered = valid.copy()
        tampered.loc[0, "text"] = "未审核的任意医疗陈述"
        with self.assertRaisesRegex(RuntimeError, "OFFICIAL_TEXT_UNIT_CONTENT_NOT_APPROVED"):
            OfficialGraphRagEngine._build_text_unit_bindings(tampered, catalog)

    def test_official_query_usage_comes_from_real_graphrag_search_result(self):
        engine = OfficialGraphRagEngine.__new__(OfficialGraphRagEngine)
        engine.version = "index-usage-v1"
        engine.text_unit_record_ids = {}
        engine.text_unit_contents = {}
        engine.record_catalog = {}
        engine.config = SimpleNamespace(
            local_search=SimpleNamespace(completion_model_id="query-model"),
            get_completion_model_config=lambda _model_id: SimpleNamespace(
                model_provider=SimpleNamespace(value="openai"),
                model="approved-query-model",
            ),
        )
        engine._run_local_search = AsyncMock(return_value=SimpleNamespace(
            response="已核验资料摘要",
            context_data={},
            llm_calls=2,
            prompt_tokens=321,
            output_tokens=45,
        ))
        result = asyncio.run(engine.search(RetrievalRequest(query="胸部整形")))
        self.assertEqual(result.query_model_usage, {
            "provider":"openai",
            "model":"approved-query-model",
            "attempts":2,
            "successes":2,
            "prompt_tokens":321,
            "output_tokens":45,
            "accounting":"official_graphrag_search_result",
        })

    def test_production_requires_explicit_index_version_not_mutable_current_pointer(self):
        with patch.dict(os.environ, {
            "HUAMEI_ENVIRONMENT": "production",
            "HUAMEI_GRAPHRAG_ENGINE": "official",
        }, clear=True):
            production_settings = Settings.from_env()
        self.assertEqual(production_settings.active_version, "")
        with self.assertRaisesRegex(RuntimeError, "PRODUCTION_GRAPHRAG_INDEX_VERSION_REQUIRED"):
            create_engine(production_settings)

    def test_official_microsoft_graphrag_dependency_and_query_api_contract(self):
        import graphrag.api as official_api

        self.assertEqual(version("graphrag"), "3.1.1")
        self.assertTrue({
            "config", "entities", "communities", "community_reports", "text_units",
            "relationships", "covariates", "community_level", "response_type", "query",
        }.issubset(inspect.signature(official_api.local_search).parameters))
        self.assertTrue({
            "config", "entities", "communities", "community_reports", "community_level",
            "dynamic_community_selection", "response_type", "query",
        }.issubset(inspect.signature(official_api.global_search).parameters))

    def test_production_cannot_use_bootstrap_or_auto_fallback(self):
        for engine in ("bootstrap", "auto"):
            production_settings = settings(
                "GraphRAG_9vD2mQ7xK4cP8tN5sL1wB6yF3hJ0zR",
                "Metrics_6mQ9sC2xV7bK4pN8tR1yF5hJ0zW3dL",
            )
            production_settings = Settings(
                **{
                    field: getattr(production_settings, field)
                    for field in production_settings.__dataclass_fields__
                    if field not in {"engine", "environment"}
                },
                engine=engine,
                environment="production",
            )
            with self.subTest(engine=engine), self.assertRaisesRegex(
                RuntimeError,
                "PRODUCTION_REQUIRES_OFFICIAL_GRAPHRAG",
            ):
                create_engine(production_settings)

    def test_health_retrieval_cache_and_sensitive_exclusion(self):
        with TestClient(create_app(settings())) as client:
            ready = client.get("/ready")
            self.assertEqual(ready.status_code, 200)
            self.assertTrue(ready.json()["ready"])
            self.assertEqual(ready.json()["engine"], "bootstrap_graph")
            self.assertIsNone(ready.json()["manifest_sha256"])

            health = client.get("/health")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(health.json()["document_count"], 925)

            payload = {"tenant_id": "huamei-shanghai", "query": "李健 擅长 专业方向", "top_k": 6}
            first = client.post("/v1/retrieve", json=payload)
            second = client.post("/v1/retrieve", json=payload)
            self.assertEqual(first.status_code, 200)
            self.assertFalse(first.json()["cache_hit"])
            self.assertTrue(second.json()["cache_hit"])
            self.assertTrue(any("李健" in item["title"] for item in first.json()["evidence"]))
            for item in first.json()["evidence"]:
                self.assertNotRegex(item["source_relative_path"], r"聊天记录|前后对比|客户画像")

            unrelated = client.post("/v1/retrieve", json={"query": "医院地址 停车"})
            self.assertEqual(unrelated.status_code, 200)
            self.assertEqual(unrelated.json()["evidence"], [])

    def test_price_requires_verification_and_global_is_blocked_in_bootstrap(self):
        with TestClient(create_app(settings())) as client:
            response = client.post("/v1/retrieve", json={"query": "双眼皮 价格 费用", "top_k": 8})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(any(item["verification_note"] for item in response.json()["evidence"]))
            global_response = client.post("/v1/retrieve", json={"query": "项目介绍", "mode": "global"})
            self.assertEqual(global_response.status_code, 422)

    def test_service_key(self):
        with TestClient(create_app(settings("a-strong-internal-key"))) as client:
            self.assertEqual(client.post("/v1/retrieve", json={"query": "热玛吉"}).status_code, 401)
            self.assertEqual(client.post(
                "/v1/retrieve",
                headers={"X-Service-Key": "a-strong-internal-key"},
                json={"query": "热玛吉"},
            ).status_code, 200)

    def test_prometheus_metrics_require_independent_token_and_bind_sanitized_query_hash(self):
        import hashlib

        metrics_token = "metrics-token-for-test"
        query = "李健 擅长 专业方向"
        query_sha256 = hashlib.sha256(query.encode("utf-8")).hexdigest()
        with TestClient(create_app(settings(metrics_token=metrics_token))) as client:
            first = client.post("/v1/retrieve", json={"query": query})
            second = client.post("/v1/retrieve", json={"query": query})
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(first.json()["query_sha256"], query_sha256)
            self.assertEqual(second.json()["query_sha256"], query_sha256)
            self.assertEqual(client.get("/metrics").status_code, 401)
            self.assertEqual(client.get("/metrics", headers={"X-Metrics-Token": "wrong"}).status_code, 401)
            metrics = client.get("/metrics", headers={"Authorization": f"Bearer {metrics_token}"})
            self.assertEqual(metrics.status_code, 200)
            self.assertTrue(metrics.headers["content-type"].startswith("text/plain"))
            self.assertIn('huamei_graphrag_cache_total{service="huamei-graphrag-retrieval",result="miss"} 1', metrics.text)
            self.assertIn('huamei_graphrag_cache_total{service="huamei-graphrag-retrieval",result="hit"} 1', metrics.text)
            self.assertIn(f'query_sha256="{query_sha256}"}} 2', metrics.text)

    def test_raw_customer_identifiers_are_rejected_before_retrieval(self):
        private_queries = (
            "我叫王小北 想了解胸部整形",
            "胸部整形 13812345678",
            "胸部整形 private.person@example.com",
            "微信 wx_private_881 胸部整形",
            "既往史甲状腺 胸部整形",
            "住在浦东新区测试路88号 想了解胸部整形",
            "胸部硬块疼痛三个月",
            "胸部整形 王小北",
            "胸部整形 甲状腺功能减退",
            "胸部整形 预算8万",
            "胸部整形 下周三下午",
            "胸部整形 检索变体1",
        )
        with TestClient(create_app(settings())) as client:
            for query in private_queries:
                with self.subTest(query=query):
                    response = client.post("/v1/retrieve", json={"query": query})
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(response.json()["detail"]["code"], "QUERY_PRIVACY_REJECTED")

            safe = client.post("/v1/retrieve", json={"query": "胸部整形 恢复 恢复期 术后"})
            self.assertEqual(safe.status_code, 200)

            private_probe = client.post(
                "/v1/retrieve",
                json={"query": "胸部硬块疼痛三个月", "readiness_probe": True},
            )
            self.assertEqual(private_probe.status_code, 422)

    def test_readiness_probe_uses_catalog_terms_and_bypasses_query_cache(self):
        with TestClient(create_app(settings())) as client:
            payload = {
                "tenant_id": "huamei-shanghai",
                "query": "医生介绍 整形外科 李健",
                "top_k": 1,
                "readiness_probe": True,
            }
            first = client.post("/v1/retrieve", json=payload)
            second = client.post("/v1/retrieve", json=payload)
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(second.status_code, 200, second.text)
            self.assertFalse(first.json()["cache_hit"])
            self.assertFalse(second.json()["cache_hit"])
            self.assertEqual(first.json()["evidence"][0]["record_id"], "kb_dir_ff0158b496b5977d")


if __name__ == "__main__":
    unittest.main()
