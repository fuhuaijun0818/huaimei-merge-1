from __future__ import annotations

from pathlib import Path
from typing import Any
from importlib.metadata import version as package_version
import asyncio
import json
import re
import unicodedata

import pandas as pd

from .models import Evidence, RetrievalRequest, RetrievalResult
from .index_manifest import IndexManifest


class OfficialGraphRagEngine:
    """Pinned adapter for the Microsoft GraphRAG 3.1.1 query API.

    The official API documents that it is still evolving. Keeping the adapter in one
    module gives the service a stable internal contract and makes upgrades testable.
    """

    name = "official_graphrag_3_1_1"

    REQUIRED_TABLES = ("entities", "communities", "community_reports", "text_units", "relationships")

    def __init__(self, project_root: Path, version: str):
        from graphrag.cli.query import _resolve_output_files
        from graphrag.config.load_config import load_config

        if package_version("graphrag") != "3.1.1":
            raise RuntimeError("UNSUPPORTED_OFFICIAL_GRAPHRAG_RUNTIME_VERSION")
        self.project_root = project_root
        manifest_path = project_root / "output" / "manifest.json"
        self.manifest = IndexManifest.load(
            manifest_path,
            expected_version=version,
            project_root=project_root,
        )
        self.version = self.manifest.index_version
        self.config = load_config(project_root)
        tables = _resolve_output_files(
            config=self.config,
            output_list=list(self.REQUIRED_TABLES),
            optional_list=["covariates"],
        )
        self.tables = tables
        self.record_catalog = self._load_record_catalog(project_root / "output" / "record_catalog.jsonl")
        expected_count = int(self.manifest.payload.get("input", {}).get("record_count") or 0)
        if len(self.record_catalog) != expected_count:
            raise RuntimeError("OFFICIAL_RECORD_CATALOG_COUNT_MISMATCH")
        catalog_artifact = self.manifest.payload.get("artifacts", {}).get("record_catalog", {})
        if catalog_artifact.get("sha256") != self.manifest.payload.get("input", {}).get("sha256"):
            raise RuntimeError("OFFICIAL_RECORD_CATALOG_INPUT_HASH_MISMATCH")
        self.text_unit_record_ids, self.text_unit_contents = self._build_text_unit_bindings(
            self.tables["text_units"],
            self.record_catalog,
        )

    @staticmethod
    def is_available(project_root: Path) -> bool:
        settings = project_root / "settings.yaml"
        output = project_root / "output"
        if not settings.exists() or not output.exists() or not (output / "manifest.json").exists():
            return False
        names = {path.stem for path in output.glob("*.parquet")}
        return all(name in names for name in OfficialGraphRagEngine.REQUIRED_TABLES)

    def validate_request(self, request: RetrievalRequest) -> None:
        if request.mode != "local":
            raise ValueError("GLOBAL_RETRIEVAL_DISABLED")
        self.manifest.validate_request(
            tenant_id=request.tenant_id,
            release_id=request.release_id,
            index_version=request.index_version,
        )

    @staticmethod
    def _load_record_catalog(path: Path) -> dict[str, dict[str, Any]]:
        records: dict[str, dict[str, Any]] = {}
        try:
            with path.open(encoding="utf-8") as stream:
                for line in stream:
                    if not line.strip():
                        continue
                    item = json.loads(line)
                    record_id = str(item.get("record_id") or "").strip()
                    if not record_id or not str(item.get("text") or "").strip():
                        raise RuntimeError("OFFICIAL_RECORD_CATALOG_ENTRY_INVALID")
                    if record_id in records:
                        raise RuntimeError("OFFICIAL_RECORD_CATALOG_DUPLICATE_ID")
                    records[record_id] = item
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("OFFICIAL_RECORD_CATALOG_INVALID") from error
        if not records:
            raise RuntimeError("OFFICIAL_RECORD_CATALOG_EMPTY")
        return records

    @staticmethod
    def _normalized_source_text(value: Any) -> str:
        return unicodedata.normalize("NFKC", str(value or "")).replace("\r\n", "\n").replace("\r", "\n").strip()

    @staticmethod
    def _normalized_content_fingerprint(value: Any) -> str:
        normalized = unicodedata.normalize("NFKC", str(value or "")).lower()
        return re.sub(r"[^\w\u3400-\u9fff]+", "", normalized)

    @classmethod
    def _build_text_unit_bindings(
        cls,
        text_units: pd.DataFrame,
        record_catalog: dict[str, dict[str, Any]],
    ) -> tuple[dict[str, str], dict[str, str]]:
        mapping: dict[str, str] = {}
        contents: dict[str, str] = {}
        for frame_index, row in text_units.iterrows():
            record_id = str(row.get("document_id") or "").strip()
            if not record_id:
                raise RuntimeError("OFFICIAL_TEXT_UNIT_DOCUMENT_ID_MISSING")
            catalog = record_catalog.get(record_id)
            if not catalog:
                raise RuntimeError("OFFICIAL_TEXT_UNIT_RECORD_MAPPING_INCOMPLETE")
            text = cls._normalized_source_text(row.get("text"))
            approved_text = cls._normalized_source_text(catalog.get("text"))
            if not text:
                raise RuntimeError("OFFICIAL_TEXT_UNIT_TEXT_MISSING")
            text_fingerprint = cls._normalized_content_fingerprint(text)
            approved_fingerprint = cls._normalized_content_fingerprint(approved_text)
            if not approved_text or not text_fingerprint or text_fingerprint not in approved_fingerprint:
                raise RuntimeError("OFFICIAL_TEXT_UNIT_CONTENT_NOT_APPROVED")
            for candidate in (frame_index, row.get("human_readable_id"), row.get("id")):
                if candidate is None:
                    continue
                key = str(candidate).strip()
                if key and key.lower() != "nan":
                    previous = mapping.setdefault(key, record_id)
                    if previous != record_id:
                        raise RuntimeError("OFFICIAL_TEXT_UNIT_CONTEXT_ID_CONFLICT")
                    previous_text = contents.setdefault(key, text)
                    if previous_text != text:
                        raise RuntimeError("OFFICIAL_TEXT_UNIT_CONTEXT_TEXT_CONFLICT")
        return mapping, contents

    def _context_evidence(self, context: Any, top_k: int) -> list[Evidence]:
        frames: list[pd.DataFrame] = []
        if isinstance(context, pd.DataFrame):
            frames = [context]
        elif isinstance(context, dict):
            # Only source/text-unit context has a deterministic path back to an
            # approved record. Entity and community summaries are generated
            # artifacts and may never be presented as if they were source rows.
            frames = [
                value for key, value in context.items()
                if isinstance(value, pd.DataFrame) and str(key).lower() in {"source", "sources", "text_unit", "text_units"}
            ]
        elif isinstance(context, list):
            frames = [value for value in context if isinstance(value, pd.DataFrame)]
        evidence: list[Evidence] = []
        seen: set[str] = set()
        for frame in frames:
            for _, row in frame.head(top_k * 3).iterrows():
                data = {str(key): value for key, value in row.to_dict().items()}
                context_id = str(data.get("id") or data.get("human_readable_id") or "").strip()
                record_id = self.text_unit_record_ids.get(context_id)
                approved_text_unit = self.text_unit_contents.get(context_id)
                catalog = self.record_catalog.get(record_id or "")
                context_text = self._normalized_source_text(
                    data.get("text") or data.get("description") or data.get("content")
                )
                if not record_id or not catalog or not approved_text_unit:
                    continue
                # Query context is model/runtime output.  It may identify a
                # source row, but it is never trusted as citation content.
                if context_text and context_text != approved_text_unit:
                    continue
                if record_id in seen:
                    continue
                seen.add(record_id)
                evidence.append(Evidence(
                    record_id=record_id,
                    record_type=str(catalog.get("record_type") or "approved_knowledge_record"),
                    title=str(catalog.get("title") or "已审核资料"),
                    content=approved_text_unit[:4000],
                    source_relative_path=str(catalog.get("source_relative_path") or ""),
                    sensitivity=str(catalog.get("sensitivity") or "internal"),
                    verification_note=str(catalog.get("verification_note") or ""),
                    score=float(data.get("score") or data.get("rank") or 1.0),
                    metadata={
                        "official_context": True,
                        "record_content_sha256": str(catalog.get("record_content_sha256") or ""),
                    },
                ))
                if len(evidence) >= top_k:
                    return evidence
        return evidence

    def _local_search_inputs(self):
        """Cache immutable indexer inputs once per worker process.

        Building these DataFrames and the LanceDB embedding store on every
        request was the dominant CPU cost under concurrent evidence retrieval.
        The inputs are read-only; per-request parameters stay on a fresh engine.
        """
        cached = getattr(self, "_local_search_inputs_cache", None)
        if cached is not None:
            return cached
        from graphrag.config.embeddings import entity_description_embedding
        from graphrag.query.indexer_adapters import (
            read_indexer_communities,
            read_indexer_covariates,
            read_indexer_entities,
            read_indexer_relationships,
            read_indexer_reports,
            read_indexer_text_units,
        )
        from graphrag.utils.api import get_embedding_store, load_search_prompt
        community_level = 2
        covariates_table = self.tables.get("covariates")
        cached = {
            "communities": read_indexer_communities(self.tables["communities"], self.tables["community_reports"]),
            "reports": read_indexer_reports(self.tables["community_reports"], self.tables["communities"], community_level),
            "entities": read_indexer_entities(self.tables["entities"], self.tables["communities"], community_level),
            "text_units": read_indexer_text_units(self.tables["text_units"]),
            "relationships": read_indexer_relationships(self.tables["relationships"]),
            "covariates": {"claims": read_indexer_covariates(covariates_table) if covariates_table is not None else []},
            "embedding_store": get_embedding_store(
                config=self.config.vector_store,
                embedding_name=entity_description_embedding,
            ),
            "system_prompt": load_search_prompt(self.config.local_search.prompt),
        }
        self._local_search_inputs_cache = cached
        return cached

    def _build_local_search(self, request: RetrievalRequest):
        """Run the pinned official engine while retaining its real usage result.

        ``graphrag.api.local_search`` deliberately returns only answer/context
        and discards ``SearchResult`` usage. This is the same GraphRAG 3.1.1
        construction path, kept in the version-pinned adapter so Prometheus can
        report the query engine's actual llm_calls/prompt/output token counts.
        """
        from graphrag.query.factory import get_local_search_engine
        inputs = self._local_search_inputs()
        return get_local_search_engine(
            config=self.config,
            reports=inputs["reports"],
            text_units=inputs["text_units"],
            entities=inputs["entities"],
            relationships=inputs["relationships"],
            covariates=inputs["covariates"],
            response_type="简洁的客观资料摘要",
            description_embedding_store=inputs["embedding_store"],
            system_prompt=inputs["system_prompt"],
        )

    def _context_params(self, engine, request: RetrievalRequest) -> dict[str, Any]:
        params = dict(engine.context_builder_params or {})
        if request.top_k_entities is not None:
            params["top_k_mapped_entities"] = request.top_k_entities
        if request.top_k_relationships is not None:
            params["top_k_relationships"] = request.top_k_relationships
        if request.max_context_tokens is not None:
            params["max_context_tokens"] = request.max_context_tokens
        return params

    async def _run_context_search(self, request: RetrievalRequest) -> RetrievalResult:
        """Build the official local context without invoking the answer model."""
        engine = self._build_local_search(request)
        context_result = await asyncio.to_thread(
            engine.context_builder.build_context,
            query=request.query,
            conversation_history=None,
            **self._context_params(engine, request),
        )
        return RetrievalResult(
            engine=self.name,
            index_version=self.version,
            mode=request.mode,
            evidence=self._context_evidence(context_result.context_records, request.top_k),
            answer_draft=None,
            graph_entities=[],
            query_model_usage={
                "provider":"none",
                "model":"none",
                "attempts":0,
                "successes":0,
                "prompt_tokens":0,
                "output_tokens":0,
                "accounting":"evidence_only",
                "context_characters":len(context_result.context_chunks or ""),
                "context_tokens":len(engine.tokenizer.encode(context_result.context_chunks or "")),
            },
        )

    async def _run_local_search(self, request: RetrievalRequest):
        engine = self._build_local_search(request)
        engine.context_builder_params.update(self._context_params(engine, request))
        return await asyncio.to_thread(engine.search, query=request.query)

    async def search(self, request: RetrievalRequest) -> RetrievalResult:
        if request.evidence_only:
            return await self._run_context_search(request)
        search_result = await self._run_local_search(request)
        response = search_result.response
        context = search_result.context_data
        answer = response if isinstance(response, str) else str(response)
        completion_model = self.config.get_completion_model_config(
            self.config.local_search.completion_model_id
        )
        provider = getattr(completion_model.model_provider, "value", completion_model.model_provider)
        attempts = max(0, int(search_result.llm_calls or 0))
        usage = {
            "provider": str(provider or "unknown"),
            "model": str(completion_model.model or "unknown"),
            "attempts": attempts,
            "successes": attempts if answer.strip() else 0,
            "prompt_tokens": max(0, int(search_result.prompt_tokens or 0)),
            "output_tokens": max(0, int(search_result.output_tokens or 0)),
            "accounting": "official_graphrag_search_result",
        }
        if not answer.strip():
            error = RuntimeError("OFFICIAL_QUERY_MODEL_EMPTY_RESPONSE")
            error.query_model_usage = usage
            raise error
        return RetrievalResult(
            engine=self.name,
            index_version=self.version,
            mode=request.mode,
            evidence=self._context_evidence(context, request.top_k),
            answer_draft=answer,
            query_model_usage=usage,
        )
