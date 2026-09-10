from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import random
import re
import statistics
import sys
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx


# Formal capacity stays on the AI consultation path. Human handover and safety
# paths have separate suites; putting them here would turn most of the soak into
# a cheap handover-receipt loop.
JOURNEYS = [
    ["我想做双眼皮，希望自然一点", "双眼皮项目通常先了解哪些术式资料？", "恢复期一般需要关注什么？", "院方有哪些眼部整形医生资料？", "面诊前需要准备哪些信息？"],
    ["我想了解丰胸，希望外观自然一些", "假体和自体脂肪两类资料怎么区分？", "恢复期通常需要关注哪些事项？", "院方有哪些胸部整形医生资料？", "面诊时一般会核验哪些基础信息？"],
    ["我想了解胎记相关项目的一般资料", "院方资料里常见的胎记项目有哪些？", "初次到院通常先了解哪些流程？", "皮肤科有哪些医生资料可以查看？", "面诊前需要准备哪些既往资料？"],
    ["想了解面部抗衰的一般项目资料", "热玛吉和拉皮的资料重点有什么不同？", "恢复时间通常需要关注什么？", "院方有哪些面部抗衰医生资料？", "第一次面诊通常会沟通哪些关注点？"],
    ["想了解光子嫩肤的一般项目介绍", "院方资料如何介绍色斑类关注点？", "项目周期通常受哪些因素影响？", "院方有哪些皮肤美容医生资料？", "到院前一般需要准备哪些信息？"],
]

FORMAL_TAXONOMY_MANIFEST_SCHEMA = "huamei.formal-load-taxonomy-manifest.v1"
FORMAL_TAXONOMY_CATALOG_SCHEMA = "huamei.formal-load-taxonomy-catalog.v1"
FORMAL_TAXONOMY_ALGORITHM = "factoradic-token-permutation.v1"
FORMAL_TAXONOMY_ENTRY_HEADER = "X-Huamei-Formal-Load-Entry-Id"


def redact(value: object, secrets: tuple[str, ...], limit: int = 500) -> str:
    rendered = str(value)
    for secret in secrets:
        if secret:
            rendered = rendered.replace(secret, "[REDACTED]")
    return rendered[:limit]


def percentile(values: list[float], probability: float) -> float:
    if not values:
        return math.inf
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(probability * len(ordered)) - 1))
    return ordered[index]


def ratio(numerator: int | float, denominator: int | float) -> float:
    return round(float(numerator) / float(denominator), 6) if denominator else 0.0


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def formal_https_target(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and parsed.hostname not in {None, "localhost", "127.0.0.1", "::1"}


def safe_reference(value: str) -> bool:
    return 4 <= len(value) <= 192 and value[0].isalnum() and all(
        character.isalnum() or character in "._:/-" for character in value
    )


def load_callers(args) -> tuple[list[dict[str, str]], dict]:
    encoded = os.getenv("HUAMEI_LOAD_CALLERS_JSON", "").strip()
    records: list[dict[str, str]] = []
    if encoded:
        try:
            document = json.loads(encoded)
        except json.JSONDecodeError as error:
            raise ValueError("HUAMEI_LOAD_CALLERS_JSON must be valid JSON") from error
        items = document.items() if isinstance(document, dict) else enumerate(document) if isinstance(document, list) else []
        for key, raw in items:
            item = raw if isinstance(raw, dict) else {}
            caller_id = str(item.get("caller_id") or key).strip()
            secret = str(item.get("secret") or item.get("service_key") or "").strip()
            if safe_reference(caller_id) and len(secret) >= 24:
                records.append({"caller_id": caller_id, "service_key": secret})
        if len({item["caller_id"] for item in records}) != len(records):
            raise ValueError("HUAMEI_LOAD_CALLERS_JSON caller ids must be unique")
    if len(records) >= args.users:
        selected = records[: args.users]
        return selected, {
            "mode": "per_virtual_user_callers",
            "caller_count": len(selected),
            "caller_ids_sha256": sha256_text("\n".join(sorted(item["caller_id"] for item in selected))),
            "approved_rate_limit_per_minute": None,
            "rate_limit_approval_id": None,
        }

    if not args.caller_id or not args.service_key:
        raise ValueError("provide HUAMEI_LOAD_CALLERS_JSON or a shared --caller-id/--service-key")
    conservative_required_limit = math.ceil(args.users * 60 / max(args.think_min_seconds, 0.25))
    approved = args.approved_rate_limit_per_minute >= conservative_required_limit and safe_reference(args.rate_limit_approval_id)
    if args.formal and not approved:
        raise ValueError(
            "formal shared-caller load requires an approved rate limit of at least "
            f"{conservative_required_limit}/minute and a rate-limit approval id"
        )
    shared = [{"caller_id": args.caller_id, "service_key": args.service_key}] * args.users
    return shared, {
        "mode": "shared_caller_with_approved_limit" if approved else "shared_caller_development_only",
        "caller_count": 1,
        "caller_ids_sha256": sha256_text(args.caller_id),
        "approved_rate_limit_per_minute": args.approved_rate_limit_per_minute or None,
        "required_rate_limit_per_minute": conservative_required_limit,
        "rate_limit_approval_id": args.rate_limit_approval_id or None,
    }


def binding_from_args(args) -> dict:
    return {
        "release_id": args.release_id,
        "knowledge_release_id": args.knowledge_release_id,
        "application_image": args.application_image,
        "graphrag_image": args.graphrag_image,
        "index_version": args.index_version,
        "knowledge_manifest_sha256": args.knowledge_manifest_sha256.lower(),
        "llm_provider": args.llm_provider,
        "llm_model": args.llm_model,
        "graphrag_model_provider": args.graphrag_model_provider,
        "graphrag_model": args.graphrag_model,
        "environment": args.environment,
    }


def binding_complete(binding: dict) -> bool:
    required = [
        "release_id", "knowledge_release_id", "application_image", "graphrag_image", "index_version",
        "llm_provider", "llm_model", "graphrag_model_provider", "graphrag_model", "environment",
    ]
    return all(str(binding.get(field) or "").strip() for field in required) and len(binding["knowledge_manifest_sha256"]) == 64


def load_formal_taxonomy_plan(args, binding: dict) -> dict | None:
    if not args.formal:
        return None
    manifest_path = Path(args.taxonomy_manifest_path)
    catalog_path = Path(args.taxonomy_catalog_path)
    expected_manifest_sha = args.taxonomy_manifest_sha256.lower()
    if not manifest_path.is_absolute() or not re.fullmatch(r"[a-f0-9]{64}", expected_manifest_sha):
        raise ValueError("formal load requires an absolute taxonomy manifest path and SHA-256")
    manifest_bytes = manifest_path.read_bytes()
    if not manifest_bytes or len(manifest_bytes) > 512 * 1024 or hashlib.sha256(manifest_bytes).hexdigest() != expected_manifest_sha:
        raise ValueError("formal taxonomy manifest SHA-256 mismatch")
    catalog_bytes = catalog_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    catalog = json.loads(catalog_bytes)
    if manifest.get("schema_version") != FORMAL_TAXONOMY_MANIFEST_SCHEMA:
        raise ValueError("formal taxonomy manifest schema mismatch")
    if catalog.get("schema_version") != FORMAL_TAXONOMY_CATALOG_SCHEMA:
        raise ValueError("formal taxonomy catalog schema mismatch")
    if manifest.get("algorithm_version") != FORMAL_TAXONOMY_ALGORITHM or catalog.get("algorithm_version") != FORMAL_TAXONOMY_ALGORITHM:
        raise ValueError("formal taxonomy algorithm mismatch")
    if manifest.get("catalog_sha256") != hashlib.sha256(catalog_bytes).hexdigest():
        raise ValueError("formal taxonomy catalog SHA-256 mismatch")
    expected = {
        "tenant_id": args.tenant_id,
        "environment": binding["environment"],
        "release_id": binding["release_id"],
        "knowledge_release_id": binding["knowledge_release_id"],
        "index_version": binding["index_version"],
        "knowledge_manifest_sha256": binding["knowledge_manifest_sha256"],
    }
    if any(str(manifest.get(field) or "") != value for field, value in expected.items()):
        raise ValueError("formal taxonomy manifest release binding mismatch")
    now = datetime.now(timezone.utc).timestamp()
    try:
        not_before = datetime.fromisoformat(str(manifest["not_before"]).replace("Z", "+00:00")).timestamp()
        not_after = datetime.fromisoformat(str(manifest["not_after"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError):
        raise ValueError("formal taxonomy manifest approval window invalid") from None
    if not_before > now or now > not_after:
        raise ValueError("formal taxonomy manifest is outside its approved window")
    attestation = manifest.get("approval_attestation") if isinstance(manifest.get("approval_attestation"), dict) else {}
    signer_id = str(attestation.get("signer_id") or "")
    signed_payload_sha = str(attestation.get("signed_payload_sha256") or "").lower()
    if not safe_reference(signer_id) or not re.fullmatch(r"[a-f0-9]{64}", signed_payload_sha):
        raise ValueError("formal taxonomy manifest approval attestation is missing")
    profiles = catalog.get("profiles") if isinstance(catalog.get("profiles"), list) else []
    profile_by_journey = {
        int(profile["journey_index"]): str(profile["id"])
        for profile in profiles
        if isinstance(profile, dict) and isinstance(profile.get("journey_index"), int)
    }
    allowed = set(str(value) for value in manifest.get("allowed_profile_ids", []))
    if len(profile_by_journey) != len(JOURNEYS) or any(profile_by_journey.get(index) not in allowed for index in range(len(JOURNEYS))):
        raise ValueError("formal taxonomy manifest does not approve every load journey")
    ordinal_limit = int(manifest.get("max_ordinal_per_profile") or 0)
    maximum_requests = int(manifest.get("maximum_requests") or 0)
    if ordinal_limit < 20 or maximum_requests < args.minimum_requests:
        raise ValueError("formal taxonomy manifest request capacity is insufficient")
    return {
        "manifest_id": str(manifest.get("manifest_id") or ""),
        "manifest_sha256": expected_manifest_sha,
        "signer_id": signer_id,
        "signed_payload_sha256": signed_payload_sha,
        "catalog_sha256": str(manifest["catalog_sha256"]),
        "algorithm_version": FORMAL_TAXONOMY_ALGORITHM,
        "profile_by_journey": profile_by_journey,
        "max_ordinal_per_profile": ordinal_limit,
        "maximum_requests": maximum_requests,
    }


async def run(args) -> dict:
    callers, load_identity = load_callers(args)
    binding = binding_from_args(args)
    taxonomy_plan = load_formal_taxonomy_plan(args, binding)
    if args.formal:
        if not formal_https_target(args.base_url):
            raise ValueError("formal load target must be a non-loopback HTTPS endpoint")
        if args.users < 20 or args.duration_seconds - args.ramp_seconds < 1_800:
            raise ValueError("formal load requires at least 20 users and 1800 seconds after ramp")
        if not binding_complete(binding):
            raise ValueError("formal load requires complete release/image/index/model binding")

    test_id = f"soak-{uuid.uuid4()}"
    started_at = datetime.now(timezone.utc).isoformat()
    stop_at = time.monotonic() + args.duration_seconds
    limits = httpx.Limits(
        max_connections=args.users + max(50, args.users // 5),
        max_keepalive_connections=args.users,
        keepalive_expiry=75,
    )
    timeout = httpx.Timeout(args.timeout)
    statuses: Counter[int | str] = Counter()
    latencies: list[float] = []
    query_hashes: list[str] = []
    taxonomy_entry_ids: set[str] = set()
    taxonomy_applied = 0
    taxonomy_issued = 0
    turn_latencies: defaultdict[int, list[float]] = defaultdict(list)
    bucket_counts: defaultdict[int, Counter[int | str]] = defaultdict(Counter)
    error_samples: list[dict] = []
    contract_failures: Counter[str] = Counter()
    dependency_counts: Counter[str] = Counter()
    request_total = 0
    started_monotonic = time.monotonic()
    lock = asyncio.Lock()
    user_summaries: list[dict | None] = [None] * args.users
    secrets = tuple({item["service_key"] for item in callers})
    url = f"{args.base_url.rstrip('/')}/v1/conversations/reply"

    async with httpx.AsyncClient(limits=limits, timeout=timeout, http2=False) as client:
        async def virtual_user(user_index: int) -> None:
            nonlocal request_total, taxonomy_applied, taxonomy_issued
            await asyncio.sleep(args.ramp_seconds * user_index / max(args.users - 1, 1))
            conversation_canary = f"{test_id}-u{user_index:04d}"
            conversation_id = f"{conversation_canary}-conversation"
            journey = JOURNEYS[user_index % len(JOURNEYS)]
            caller = callers[user_index]
            turn = valid_turns = llm_successes = graph_successes = 0
            user_started_at = datetime.now(timezone.utc).isoformat()
            while time.monotonic() < stop_at:
                base_text = journey[turn % len(journey)]
                request_canary = f"{conversation_canary}-t{turn:06d}"
                text = f"{base_text}（会话校验码 {request_canary}）"
                message_id = f"{request_canary}-message"
                payload = {
                    "tenant_id": args.tenant_id,
                    "channel": "api",
                    "conversation_id": conversation_id,
                    "message": {"id": message_id, "text": text},
                }
                request_headers = {
                    "X-Caller-Id": caller["caller_id"], "X-Service-Key": caller["service_key"],
                    "X-Tenant-Id": args.tenant_id, "X-Request-Id": message_id, "Idempotency-Key": message_id,
                }
                taxonomy_entry_id: str | None = None
                if taxonomy_plan:
                    profile_id = taxonomy_plan["profile_by_journey"][user_index % len(JOURNEYS)]
                    ordinal = turn * args.users + user_index
                    if ordinal >= taxonomy_plan["max_ordinal_per_profile"]:
                        raise RuntimeError("FORMAL_LOAD_TAXONOMY_ENTRY_SPACE_EXHAUSTED")
                    taxonomy_entry_id = f"{profile_id}.{ordinal}"
                    async with lock:
                        if taxonomy_issued >= taxonomy_plan["maximum_requests"]:
                            raise RuntimeError("FORMAL_LOAD_TAXONOMY_APPROVED_REQUEST_LIMIT_EXHAUSTED")
                        taxonomy_issued += 1
                    request_headers[FORMAL_TAXONOMY_ENTRY_HEADER] = taxonomy_entry_id
                began = time.perf_counter()
                status_key: int | str
                sample: dict | None = None
                failures: list[str] = []
                llm_used = graphrag_used = False
                taxonomy_valid = False
                query_hash: str | None = None
                try:
                    response = await client.post(url, json=payload, headers=request_headers)
                    status_key = response.status_code
                    if response.status_code == 200:
                        try:
                            document = response.json()
                            profile = document.get("profile_signals") if isinstance(document.get("profile_signals"), dict) else {}
                            guardrails = document.get("guardrails") if isinstance(document.get("guardrails"), dict) else {}
                            reply = document.get("reply") if isinstance(document.get("reply"), dict) else {}
                            handover = document.get("handover") if isinstance(document.get("handover"), dict) else {}
                            delivery = document.get("delivery") if isinstance(document.get("delivery"), dict) else {}
                            if document.get("tenant_id") != args.tenant_id:
                                failures.append("TENANT_CONTRACT_MISMATCH")
                            if document.get("conversation_id") != conversation_id or profile.get("session_id") != conversation_id:
                                failures.append("CONVERSATION_CANARY_MISMATCH")
                            if document.get("message_id") != message_id:
                                failures.append("MESSAGE_CANARY_MISMATCH")
                            if profile.get("turn_count") != turn + 1:
                                failures.append("TURN_SEQUENCE_MISMATCH")
                            if not isinstance(reply.get("segments"), list) or not reply.get("segments"):
                                failures.append("REPLY_CONTRACT_MISMATCH")
                            if handover.get("required") is True or delivery.get("suppress_ai") is True:
                                failures.append("UNEXPECTED_HANDOVER_PATH")
                            llm_used = guardrails.get("llm_used") is True
                            graphrag_used = guardrails.get("graphrag_used") is True
                            if not llm_used:
                                failures.append("LIVE_MODEL_NOT_USED")
                            if not graphrag_used:
                                failures.append("GRAPHRAG_NOT_USED")
                            if graphrag_used and guardrails.get("graphrag_engine") != "official_graphrag_3_1_1":
                                failures.append("GRAPHRAG_ENGINE_MISMATCH")
                            if graphrag_used and args.index_version and guardrails.get("graphrag_index_version") != args.index_version:
                                failures.append("GRAPHRAG_INDEX_MISMATCH")
                            if graphrag_used:
                                candidate_hash = str(guardrails.get("graphrag_query_sha256") or "").lower()
                                if re.fullmatch(r"[a-f0-9]{64}", candidate_hash):
                                    query_hash = candidate_hash
                                else:
                                    failures.append("GRAPHRAG_SANITIZED_QUERY_HASH_MISSING")
                            if taxonomy_plan:
                                taxonomy = guardrails.get("formal_load_taxonomy") if isinstance(guardrails.get("formal_load_taxonomy"), dict) else {}
                                taxonomy_valid = (
                                    taxonomy.get("entry_id") == taxonomy_entry_id
                                    and taxonomy.get("manifest_id") == taxonomy_plan["manifest_id"]
                                    and taxonomy.get("manifest_sha256") == taxonomy_plan["manifest_sha256"]
                                    and taxonomy.get("signer_id") == taxonomy_plan["signer_id"]
                                    and taxonomy.get("signed_payload_sha256") == taxonomy_plan["signed_payload_sha256"]
                                    and taxonomy.get("catalog_sha256") == taxonomy_plan["catalog_sha256"]
                                    and taxonomy.get("algorithm_version") == taxonomy_plan["algorithm_version"]
                                )
                                if not taxonomy_valid:
                                    failures.append("FORMAL_LOAD_TAXONOMY_NOT_APPLIED")
                            if args.knowledge_release_id and guardrails.get("knowledge_release_id") != args.knowledge_release_id:
                                failures.append("KNOWLEDGE_RELEASE_MISMATCH")
                            status_key = failures[0] if failures else 200
                            valid_turns += int(not failures)
                        except Exception:
                            failures.append("INVALID_JSON_RESPONSE")
                            status_key = "INVALID_JSON_RESPONSE"
                    if status_key != 200:
                        sample = {
                            "status": status_key, "failure_codes": failures,
                            "body": redact(response.text, secrets), "user": user_index, "turn": turn,
                        }
                except Exception as error:
                    status_key = type(error).__name__
                    failures.append(status_key)
                    sample = {"exception": status_key, "message": redact(error, secrets), "user": user_index, "turn": turn}
                latency = (time.perf_counter() - began) * 1000
                bucket = int((time.monotonic() - started_monotonic) // 60)
                async with lock:
                    request_total += 1
                    statuses[status_key] += 1
                    bucket_counts[bucket][status_key] += 1
                    latencies.append(latency)
                    # This is the digest returned by the retrieval service for
                    # the exact privacy-approved query it received. Never hash
                    # the raw customer/load utterance for cache-miss evidence.
                    query_hashes.append(query_hash or "")
                    if taxonomy_plan and taxonomy_entry_id:
                        taxonomy_entry_ids.add(taxonomy_entry_id)
                        taxonomy_applied += int(taxonomy_valid and not failures)
                    turn_latencies[turn % len(journey)].append(latency)
                    dependency_counts["llm_required"] += 1
                    dependency_counts["graphrag_required"] += 1
                    dependency_counts["llm_success"] += int(llm_used)
                    dependency_counts["graphrag_success"] += int(graphrag_used)
                    for code in failures:
                        contract_failures[code] += 1
                    if sample and len(error_samples) < 50:
                        error_samples.append(sample)
                llm_successes += int(llm_used)
                graph_successes += int(graphrag_used)
                turn += 1
                if args.think_max_seconds > 0:
                    await asyncio.sleep(random.uniform(args.think_min_seconds, args.think_max_seconds))
            user_summaries[user_index] = {
                "user_index": user_index,
                "conversation_canary_sha256": sha256_text(conversation_canary),
                "started_at": user_started_at, "finished_at": datetime.now(timezone.utc).isoformat(),
                "turns": turn, "valid_turns": valid_turns,
                "llm_successes": llm_successes, "graphrag_successes": graph_successes,
            }

        await asyncio.gather(*(virtual_user(index) for index in range(args.users)))

    duration = time.monotonic() - started_monotonic
    success = statuses[200]
    error_rate = 1 - success / max(request_total, 1)
    p95 = percentile(latencies, 0.95)
    llm_coverage = ratio(dependency_counts["llm_success"], dependency_counts["llm_required"])
    graph_coverage = ratio(dependency_counts["graphrag_success"], dependency_counts["graphrag_required"])
    distinct_queries = len(set(query_hashes))
    query_ratio = ratio(distinct_queries, len(query_hashes))
    taxonomy_application_ratio = ratio(taxonomy_applied, request_total) if taxonomy_plan else 0.0
    steady_seconds = max(0.0, duration - args.ramp_seconds)
    formal_candidate = (
        args.formal and formal_https_target(args.base_url) and args.users >= 20 and steady_seconds >= 1_800
        and binding_complete(binding)
        and load_identity["mode"] in {"per_virtual_user_callers", "shared_caller_with_approved_limit"}
        and taxonomy_plan is not None and taxonomy_application_ratio == 1
        and len(taxonomy_entry_ids) == request_total
    )
    accepted = (
        error_rate <= args.max_error_rate and p95 <= args.max_p95_ms and request_total >= args.minimum_requests
        and llm_coverage >= args.minimum_dependency_success_rate
        and graph_coverage >= args.minimum_dependency_success_rate
        and query_ratio >= args.minimum_query_diversity_ratio and not contract_failures
        and (not args.formal or (taxonomy_application_ratio == 1 and len(taxonomy_entry_ids) == request_total))
    )
    return {
        "schema_version": "huamei.load.soak.v2",
        "evidence_class": "sustained_ai_main_path",
        "formal_acceptance_eligible": formal_candidate and accepted,
        "test_id": test_id, "started_at": started_at, "finished_at": datetime.now(timezone.utc).isoformat(),
        "target": "acquisition-agent", "base_url": args.base_url, "tenant_id": args.tenant_id,
        "binding": binding, "load_identity": load_identity,
        "virtual_users": args.users, "ramp_seconds": args.ramp_seconds,
        "requested_duration_seconds": args.duration_seconds,
        "actual_duration_seconds": round(duration, 3),
        "steady_state_duration_seconds": round(steady_seconds, 3),
        "requests": request_total, "success": success,
        "status_counts": {str(key): value for key, value in statuses.items()},
        "error_samples": error_samples, "error_rate": round(error_rate, 6),
        "throughput_rps": round(request_total / max(duration, 0.001), 2),
        "latency_ms": {
            "min": round(min(latencies), 2) if latencies else None,
            "mean": round(statistics.fmean(latencies), 2) if latencies else None,
            "p50": round(percentile(latencies, 0.50), 2), "p95": round(p95, 2),
            "p99": round(percentile(latencies, 0.99), 2),
            "max": round(max(latencies), 2) if latencies else None,
        },
        "latency_samples_ms": [round(value, 3) for value in latencies],
        "turn_latency_p95_ms": {str(turn): round(percentile(values, 0.95), 2) for turn, values in sorted(turn_latencies.items())},
        "minute_buckets": {
            str(bucket): {str(status): count for status, count in counts.items()}
            for bucket, counts in sorted(bucket_counts.items())
        },
        "dependency_usage": {
            "live_model": {
                "required_requests": dependency_counts["llm_required"],
                "successful_requests": dependency_counts["llm_success"],
                "fallback_or_skip_requests": dependency_counts["llm_required"] - dependency_counts["llm_success"],
                "observed_success_ratio": llm_coverage,
            },
            "graphrag": {
                "required_requests": dependency_counts["graphrag_required"],
                "successful_requests": dependency_counts["graphrag_success"],
                "fallback_or_skip_requests": dependency_counts["graphrag_required"] - dependency_counts["graphrag_success"],
                "observed_success_ratio": graph_coverage,
                "engine": "official_graphrag_3_1_1", "expected_cache_miss_count": distinct_queries,
            },
        },
        "query_diversity": {
            "query_hashes": query_hashes, "request_count": len(query_hashes),
            "distinct_query_count": distinct_queries, "unique_ratio": query_ratio,
            "query_hash_source": "graphrag_response_sanitized_query_sha256",
        },
        "formal_load_taxonomy": {
            "required": bool(args.formal),
            "manifest_id": taxonomy_plan["manifest_id"] if taxonomy_plan else None,
            "manifest_sha256": taxonomy_plan["manifest_sha256"] if taxonomy_plan else None,
            "signer_id": taxonomy_plan["signer_id"] if taxonomy_plan else None,
            "signed_payload_sha256": taxonomy_plan["signed_payload_sha256"] if taxonomy_plan else None,
            "catalog_sha256": taxonomy_plan["catalog_sha256"] if taxonomy_plan else None,
            "algorithm_version": taxonomy_plan["algorithm_version"] if taxonomy_plan else None,
            "requests_checked": request_total,
            "applied_responses": taxonomy_applied,
            "application_ratio": taxonomy_application_ratio,
            "distinct_entry_count": len(taxonomy_entry_ids),
            "entry_ids_sha256": sha256_text("\n".join(sorted(taxonomy_entry_ids))) if taxonomy_entry_ids else None,
        },
        "contract_checks": {
            "responses_checked": request_total, "valid_responses": success,
            "failure_counts": dict(contract_failures),
            "canary_isolation_passed": not any(
                contract_failures[code]
                for code in ["TENANT_CONTRACT_MISMATCH", "CONVERSATION_CANARY_MISMATCH", "MESSAGE_CANARY_MISMATCH", "TURN_SEQUENCE_MISMATCH"]
            ),
        },
        "user_summaries": user_summaries,
        "acceptance": {
            "max_error_rate": args.max_error_rate, "max_p95_ms": args.max_p95_ms,
            "minimum_requests": args.minimum_requests,
            "minimum_dependency_attempt_coverage": args.minimum_dependency_attempt_coverage,
            "minimum_dependency_success_rate": args.minimum_dependency_success_rate,
            "minimum_query_diversity_ratio": args.minimum_query_diversity_ratio,
            "formal_candidate": formal_candidate, "passed": accepted,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Sustained, cache-resistant AI-main-path load test for Huamei acquisition agent.")
    parser.add_argument("--base-url", default="http://127.0.0.1:4180")
    parser.add_argument("--tenant-id", default=os.getenv("HUAMEI_LOAD_TENANT_ID", "huamei-shanghai"))
    parser.add_argument("--caller-id", default="", help="shared caller compatibility mode; prefer HUAMEI_LOAD_CALLERS_JSON")
    parser.add_argument("--service-key", default="", help="shared caller compatibility mode; prefer environment injection")
    parser.add_argument("--users", type=int, default=20)
    parser.add_argument("--duration-seconds", type=int, default=1920)
    parser.add_argument("--ramp-seconds", type=int, default=120)
    parser.add_argument("--think-min-seconds", type=float, default=3)
    parser.add_argument("--think-max-seconds", type=float, default=8)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--max-error-rate", type=float, default=0.005)
    parser.add_argument("--max-p95-ms", type=float, default=10000)
    parser.add_argument("--minimum-requests", type=int, default=2500)
    parser.add_argument("--minimum-dependency-attempt-coverage", type=float, default=0.95)
    parser.add_argument("--minimum-dependency-success-rate", type=float, default=0.99)
    parser.add_argument("--minimum-query-diversity-ratio", type=float, default=0.95)
    parser.add_argument("--approved-rate-limit-per-minute", type=int, default=int(os.getenv("HUAMEI_LOAD_APPROVED_RATE_LIMIT_PER_MINUTE", "0") or 0))
    parser.add_argument("--rate-limit-approval-id", default=os.getenv("HUAMEI_LOAD_RATE_LIMIT_APPROVAL_ID", ""))
    parser.add_argument("--formal", action="store_true")
    parser.add_argument("--taxonomy-manifest-path", default=os.getenv("HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_PATH", ""))
    parser.add_argument("--taxonomy-manifest-sha256", default=os.getenv("HUAMEI_FORMAL_LOAD_TAXONOMY_MANIFEST_SHA256", ""))
    parser.add_argument(
        "--taxonomy-catalog-path",
        default=str(Path(__file__).resolve().parents[2] / "config" / "formal-load-taxonomy-catalog.v1.json"),
    )
    parser.add_argument("--release-id", default=os.getenv("HUAMEI_RELEASE_ID", ""))
    parser.add_argument("--knowledge-release-id", default=os.getenv("HUAMEI_ACTIVE_KNOWLEDGE_RELEASE_ID", ""))
    parser.add_argument("--application-image", default=os.getenv("HUAMEI_APP_IMAGE", ""))
    parser.add_argument("--graphrag-image", default=os.getenv("HUAMEI_GRAPHRAG_IMAGE", ""))
    parser.add_argument("--index-version", default=os.getenv("HUAMEI_GRAPHRAG_INDEX_VERSION", ""))
    parser.add_argument("--knowledge-manifest-sha256", default=os.getenv("HUAMEI_RELEASE_GRAPHRAG_MANIFEST_SHA256", ""))
    parser.add_argument("--llm-provider", default=os.getenv("HUAMEI_LLM_PROVIDER", ""))
    parser.add_argument("--llm-model", default=os.getenv("HUAMEI_LLM_MODEL", ""))
    parser.add_argument("--graphrag-model-provider", default=os.getenv("GRAPHRAG_MODEL_PROVIDER", ""))
    parser.add_argument("--graphrag-model", default=os.getenv("GRAPHRAG_COMPLETION_MODEL", ""))
    parser.add_argument("--environment", default=os.getenv("HUAMEI_EVIDENCE_ENVIRONMENT", os.getenv("HUAMEI_RUNTIME_ENV", "development")))
    parser.add_argument("--output", default="artifacts/acquisition-agent-soak-20-v2.json")
    args = parser.parse_args()
    args.caller_id = os.getenv("HUAMEI_LOAD_CALLER_ID", "").strip() or args.caller_id
    args.service_key = os.getenv("HUAMEI_LOAD_SERVICE_KEY", "").strip() or args.service_key
    if args.users < 1 or args.duration_seconds < 1 or args.ramp_seconds < 0:
        parser.error("users/duration must be positive and ramp must be non-negative")
    if args.think_min_seconds < 0 or args.think_max_seconds < args.think_min_seconds:
        parser.error("think time range is invalid")
    if not 0 < args.minimum_dependency_attempt_coverage <= 1 or not 0 < args.minimum_dependency_success_rate <= 1:
        parser.error("dependency thresholds must be in (0,1]")
    if not 0 < args.minimum_query_diversity_ratio <= 1:
        parser.error("query diversity threshold must be in (0,1]")
    try:
        report = asyncio.run(run(args))
    except ValueError as error:
        parser.error(str(error))
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    return 0 if report["acceptance"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
