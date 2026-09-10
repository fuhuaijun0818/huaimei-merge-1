from __future__ import annotations

import gzip
import json
import math
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

from .models import Evidence, RetrievalRequest, RetrievalResult


HAN_RUN = re.compile(r"[\u3400-\u9fff]{2,}")
ASCII_WORD = re.compile(r"[a-z0-9][a-z0-9._-]{1,40}")
GRAPH_STOP_ENTITIES = {"医生介绍", "项目介绍", "项目价格"}


def normalize(value: str) -> str:
    return re.sub(r"[^\w\u3400-\u9fff]+", "", unicodedata.normalize("NFKC", str(value)).lower())


def query_terms(value: str) -> list[str]:
    text = unicodedata.normalize("NFKC", value).lower()
    terms: set[str] = set(ASCII_WORD.findall(text))
    for run in HAN_RUN.findall(text):
        if 2 <= len(run) <= 14:
            terms.add(run)
        for size in (2, 3, 4, 5):
            if len(run) < size:
                continue
            terms.update(run[index:index + size] for index in range(len(run) - size + 1))
    compact = normalize(text)
    if 2 <= len(compact) <= 24:
        terms.add(compact)
    return sorted(terms, key=lambda item: (-len(item), item))[:120]


class BootstrapGraphEngine:
    """Read-only Chinese graph retrieval used before an LLM-built GraphRAG index is published."""

    name = "bootstrap_graph"

    def __init__(self, index_file: Path):
        with gzip.open(index_file, "rt", encoding="utf-8") as stream:
            payload = json.load(stream)
        self.index_file = index_file
        self.version = payload["metadata"]["version"]
        self.metadata = payload["metadata"]
        self.documents: list[dict[str, Any]] = payload["documents"]
        self.postings: dict[str, list[list[float]]] = payload["postings"]
        self.entities: dict[str, dict[str, Any]] = payload["entities"]
        self.neighbors: dict[str, list[list[Any]]] = payload["neighbors"]
        self.document_count = max(1, len(self.documents))

    def validate_request(self, request: RetrievalRequest) -> None:
        # Bootstrap is deliberately a development-only candidate index. It has
        # no production release binding; create_engine rejects it in production.
        return None

    def search(self, request: RetrievalRequest) -> RetrievalResult:
        if request.mode == "global":
            raise ValueError("BOOTSTRAP_GLOBAL_SEARCH_DISABLED")
        terms = query_terms(request.query)
        scores: dict[int, float] = defaultdict(float)
        matched_terms: dict[int, set[str]] = defaultdict(set)
        for term in terms:
            postings = self.postings.get(term)
            if not postings:
                continue
            idf = math.log(1 + self.document_count / max(1, len(postings)))
            for doc_index, field_weight in postings:
                scores[int(doc_index)] += idf * float(field_weight) * (1 + min(len(term), 8) / 10)
                if len(matched_terms[int(doc_index)]) < 8:
                    matched_terms[int(doc_index)].add(term)

        normalized_query = normalize(request.query)
        doctor_intent = bool(re.search(r"(?:医生|院长|专家|擅长|资质|推荐谁)", request.query))
        price_intent = bool(re.search(r"(?:价格|报价|多少钱|费用|预算|活动|优惠|政策|套餐)", request.query))
        matched_entities: list[str] = []
        entity_boosts: dict[int, list[str]] = defaultdict(list)
        for entity_key, entity in self.entities.items():
            label = entity["label"]
            normalized_label = entity.get("normalized") or normalize(label)
            if len(normalized_label) < 2:
                continue
            if normalized_label in normalized_query or (len(normalized_query) >= 3 and normalized_query in normalized_label):
                matched_entities.append(label)
                for doc_index in entity["documents"]:
                    scores[int(doc_index)] += 18.0
                    entity_boosts[int(doc_index)].append(label)
                for neighbor_key, weight in self.neighbors.get(entity_key, [])[:8]:
                    neighbor = self.entities.get(neighbor_key)
                    if not neighbor or neighbor.get("label") in GRAPH_STOP_ENTITIES or neighbor.get("type") not in {"domain_term", "doctor"}:
                        continue
                    boost = min(8.0, 1.5 + math.log1p(float(weight)))
                    for doc_index in neighbor["documents"]:
                        scores[int(doc_index)] += boost
                        if len(entity_boosts[int(doc_index)]) < 6:
                            entity_boosts[int(doc_index)].append(f"{label}→{neighbor['label']}")

        for doc_index in list(scores):
            path = str(self.documents[doc_index].get("source_relative_path", ""))
            if doctor_intent:
                if path.startswith("医生介绍/"):
                    scores[doc_index] += 180.0 if entity_boosts.get(doc_index) else 55.0
                else:
                    scores[doc_index] -= 12.0
            if price_intent:
                scores[doc_index] += 140.0 if path.startswith(("项目价格/", "6月份政策/", "荟员升级权益/")) else -8.0

        record_types = set(request.filters.record_types)
        path_prefixes = tuple(request.filters.path_prefixes)
        ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
        evidence: list[Evidence] = []
        for doc_index, score in ranked:
            if score < 12.0:
                continue
            doc = self.documents[doc_index]
            if record_types and doc["record_type"] not in record_types:
                continue
            if path_prefixes and not str(doc["source_relative_path"]).startswith(path_prefixes):
                continue
            evidence.append(Evidence(
                record_id=doc["record_id"],
                record_type=doc["record_type"],
                title=doc["title"],
                content=doc["content"],
                source_relative_path=doc["source_relative_path"],
                sensitivity=doc.get("sensitivity", "internal"),
                verification_note=doc.get("verification_note", ""),
                score=round(float(score), 4),
                graph_paths=list(dict.fromkeys(entity_boosts.get(doc_index, [])))[:6],
                metadata={"matched_terms": sorted(matched_terms.get(doc_index, set()), key=len, reverse=True)[:8]},
            ))
            if len(evidence) >= request.top_k:
                break
        return RetrievalResult(
            engine=self.name,
            index_version=self.version,
            mode="local",
            evidence=evidence,
            graph_entities=list(dict.fromkeys(matched_entities))[:12],
        )
