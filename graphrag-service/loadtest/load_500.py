from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import statistics
import sys
import time
import uuid
from collections import Counter
from datetime import UTC, datetime

import httpx


CUSTOMER_UTTERANCES = [
    "李健院长擅长什么？",
    "我想做胸部整形，有哪些医生资料？",
    "双眼皮一般怎么了解？",
    "鼻部整形有哪些项目资料？",
    "热玛吉是什么？",
    "眼袋项目需要核验哪些信息？",
    "光子嫩肤的一般介绍",
    "我想了解面部抗衰的项目方向",
    "拉皮和微拉美的资料有哪些？",
    "叶丽萍院长有哪些介绍？",
]

# The retrieval service contract accepts only taxonomy search phrases. Raw
# customer utterances belong to the acquisition-agent target above and must
# never be forwarded directly to the GraphRAG/query-model target.
GRAPHRAG_QUERIES = [
    "李健 擅长 专业方向",
    "胸部整形 医生 擅长",
    "眼部整形 项目介绍",
    "鼻部整形 项目介绍",
    "热玛吉 项目介绍",
    "眼袋 核验 项目介绍",
    "光子嫩肤 项目介绍",
    "面部年轻化 项目方向",
    "拉皮 微拉美 项目介绍",
    "叶丽萍 擅长 专业方向",
]


def redact(value: object, secret: str, limit: int = 500) -> str:
    rendered = str(value)
    if secret:
        rendered = rendered.replace(secret, "[REDACTED]")
    return rendered[:limit]


def percentile(values: list[float], probability: float) -> float:
    if not values:
        return math.inf
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(probability * len(ordered)) - 1))
    return ordered[index]


async def run(args) -> dict:
    limits = httpx.Limits(max_connections=args.concurrency + 50, max_keepalive_connections=args.concurrency)
    timeout = httpx.Timeout(args.timeout)
    semaphore = asyncio.Semaphore(args.concurrency)
    start_gate = asyncio.Event()
    latencies: list[float] = []
    statuses: Counter[int | str] = Counter()
    error_samples: list[dict] = []
    test_id = f"load-{uuid.uuid4()}"
    started_at = datetime.now(UTC).isoformat()

    async with httpx.AsyncClient(limits=limits, timeout=timeout, http2=False) as client:
        async def one(index: int):
            async with semaphore:
                await start_gate.wait()
                customer_utterance = CUSTOMER_UTTERANCES[index % len(CUSTOMER_UTTERANCES)]
                headers = {"X-Request-Id": f"{test_id}-{index}"}
                if args.service_key:
                    headers["X-Service-Key"] = args.service_key
                if args.caller_id:
                    headers["X-Caller-Id"] = args.caller_id
                headers["X-Tenant-Id"] = args.tenant_id
                if args.target == "graphrag":
                    url = f"{args.base_url.rstrip('/')}/v1/retrieve"
                    query = GRAPHRAG_QUERIES[index % len(GRAPHRAG_QUERIES)]
                    # This direct GraphRAG burst is a latency/saturation probe,
                    # not cache-resistant formal evidence. Query diversity is
                    # available only through the acquisition service's signed
                    # entry-ID taxonomy mechanism.
                    payload = {"tenant_id": args.tenant_id, "query": query, "top_k": 6}
                    if args.index_version:
                        payload["index_version"] = args.index_version
                    if args.release_id:
                        payload["release_id"] = args.release_id
                    if args.evidence_only:
                        payload["evidence_only"] = True
                    if args.cache_bypass:
                        payload["readiness_probe"] = True
                else:
                    url = f"{args.base_url.rstrip('/')}/v1/conversations/reply"
                    payload = {
                        "tenant_id": args.tenant_id, "channel": "api",
                        "conversation_id": f"{test_id}-conversation-{index}",
                        "message": {"id": f"{test_id}-message-{index}", "text": customer_utterance},
                    }
                started = time.perf_counter()
                try:
                    response = await client.post(url, json=payload, headers=headers)
                    status_key: int | str = response.status_code
                    if response.status_code == 200 and args.target == "agent":
                        try:
                            document = response.json()
                            if document.get("tenant_id") != args.tenant_id or document.get("conversation_id") != payload["conversation_id"]:
                                status_key = "CONTRACT_MISMATCH"
                        except Exception:
                            status_key = "INVALID_JSON_RESPONSE"
                    statuses[status_key] += 1
                    if status_key != 200 and len(error_samples) < 5:
                        error_samples.append({
                            "status": status_key,
                            "body": redact(response.text, args.service_key),
                            "headers": {key: value for key, value in response.headers.items() if key.lower() in {"server", "connection", "x-request-id"}},
                        })
                except Exception as error:
                    statuses[type(error).__name__] += 1
                    if len(error_samples) < 5:
                        error_samples.append({"exception": type(error).__name__, "message": redact(error, args.service_key)})
                finally:
                    latencies.append((time.perf_counter() - started) * 1000)

        tasks = [asyncio.create_task(one(index)) for index in range(args.requests)]
        started = time.perf_counter()
        start_gate.set()
        await asyncio.gather(*tasks)
        duration = time.perf_counter() - started

    success = statuses[200]
    error_rate = 1 - success / args.requests
    return {
        "target": args.target,
        "base_url": args.base_url,
        "test_id": test_id,
        "started_at": started_at,
        "finished_at": datetime.now(UTC).isoformat(),
        "tenant_id": args.tenant_id,
        "index_version": args.index_version or None,
        "concurrent_users": args.concurrency,
        "requests": args.requests,
        "success": success,
        "status_counts": {str(key): value for key, value in statuses.items()},
        "error_samples": error_samples,
        "error_rate": round(error_rate, 6),
        "duration_seconds": round(duration, 3),
        "throughput_rps": round(args.requests / duration, 2),
        "latency_ms": {
            "min": round(min(latencies), 2),
            "mean": round(statistics.fmean(latencies), 2),
            "p50": round(percentile(latencies, 0.50), 2),
            "p95": round(percentile(latencies, 0.95), 2),
            "p99": round(percentile(latencies, 0.99), 2),
            "max": round(max(latencies), 2),
        },
        "acceptance": {
            "max_error_rate": args.max_error_rate,
            "max_p95_ms": args.max_p95_ms,
            "passed": error_rate <= args.max_error_rate and percentile(latencies, 0.95) <= args.max_p95_ms,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="20 concurrent-user baseline for GraphRAG or the acquisition agent.")
    parser.add_argument("--target", choices=["graphrag", "agent"], default="graphrag")
    parser.add_argument("--base-url", default="http://127.0.0.1:4191")
    parser.add_argument("--concurrency", type=int, default=20)
    parser.add_argument("--requests", type=int, default=100)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--service-key", default="", help="兼容参数；生产不建议使用，优先读取HUAMEI_LOAD_SERVICE_KEY")
    parser.add_argument("--caller-id", default="huamei_load_test", help="兼容参数；优先读取HUAMEI_LOAD_CALLER_ID")
    parser.add_argument("--tenant-id", default=os.getenv("HUAMEI_LOAD_TENANT_ID", "huamei-shanghai"))
    parser.add_argument("--index-version", default=os.getenv("HUAMEI_LOAD_INDEX_VERSION", ""))
    parser.add_argument("--release-id", default=os.getenv("HUAMEI_LOAD_RELEASE_ID", ""))
    parser.add_argument("--evidence-only", action="store_true", help="只构建检索证据，不调用GraphRAG回答模型")
    parser.add_argument("--cache-bypass", action="store_true", help="压测时绕过证据缓存，测量真实检索路径")
    parser.add_argument("--max-error-rate", type=float, default=0.005)
    parser.add_argument("--max-p95-ms", type=float, default=2000)
    parser.add_argument("--output", default="")
    args = parser.parse_args()
    args.caller_id = os.getenv("HUAMEI_LOAD_CALLER_ID", "").strip() or args.caller_id
    args.service_key = os.getenv("HUAMEI_LOAD_SERVICE_KEY", "").strip() or args.service_key
    report = asyncio.run(run(args))
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        from pathlib import Path
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    return 0 if report["acceptance"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
