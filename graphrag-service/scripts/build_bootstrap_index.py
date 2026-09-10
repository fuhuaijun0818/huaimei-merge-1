from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.index_manifest import IndexManifestError, approved_record_list_sha256, load_official_input_records  # noqa: E402

BLOCKED_PATH = re.compile(r"(?:前后对比|聊天记录|客户画像相关资料|案例库|术前术后)", re.I)
PUBLIC_TYPES = {"directory_overview", "image_ocr"}
DOCTOR_PATTERN = re.compile(r"([\u4e00-\u9fff]{2,4}(?:院长|医生|主任|教授))")
HAN_RUN = re.compile(r"[\u3400-\u9fff]{2,}")
ASCII_WORD = re.compile(r"[a-z0-9][a-z0-9._-]{1,40}")
DOMAIN_TERMS = [
    "双眼皮", "重睑", "眼综合", "眼袋", "泪沟", "提眉", "隆鼻", "鼻综合", "鼻部整形", "隆胸", "胸部整形",
    "热玛吉", "线雕", "拉皮", "微拉美", "光子嫩肤", "皮秒", "水光", "玻尿酸", "瘦脸针", "肉毒", "吸脂", "脂肪填充",
    "毛发移植", "植发", "牙齿矫正", "口腔", "抗衰", "抗初老", "祛斑", "痘坑", "脱毛", "项目价格", "医生介绍",
]


def normalize(value: str) -> str:
    return re.sub(r"[^\w\u3400-\u9fff]+", "", unicodedata.normalize("NFKC", str(value)).lower())


def terms_for(value: str, max_terms: int = 25000) -> set[str]:
    text = unicodedata.normalize("NFKC", value).lower()
    terms: set[str] = set(ASCII_WORD.findall(text))
    for run in HAN_RUN.findall(text):
        if 2 <= len(run) <= 30:
            terms.add(run)
        for size in (2, 3, 4, 5):
            if len(run) >= size:
                terms.update(run[index:index + size] for index in range(len(run) - size + 1))
        if len(terms) >= max_terms:
            break
    return terms


def public_eligible(record: dict) -> bool:
    return (
        record.get("record_type") in PUBLIC_TYPES
        and record.get("sensitivity") != "restricted"
        and not BLOCKED_PATH.search(str(record.get("source_relative_path", "")))
    )


def entity_pairs(record: dict) -> list[tuple[str, str]]:
    combined = " ".join([
        str(record.get("title", "")),
        str(record.get("content", "")),
        str(record.get("source_relative_path", "")),
        " ".join(map(str, record.get("tags") or [])),
    ])
    entities: list[tuple[str, str]] = []
    for term in DOMAIN_TERMS:
        if term.lower() in combined.lower():
            entities.append((term, "domain_term"))
    for doctor in DOCTOR_PATTERN.findall(combined):
        entities.append((doctor, "doctor"))
    for tag in record.get("tags") or []:
        label = str(tag).strip()
        if 2 <= len(label) <= 32 and label.lower() != "image":
            entities.append((label, "tag"))
    for segment in str(record.get("source_relative_path", "")).split("/")[:-1]:
        label = segment.strip()
        if 2 <= len(label) <= 40:
            entities.append((label, "source_group"))
    unique: dict[str, tuple[str, str]] = {}
    for label, kind in entities:
        key = normalize(label)
        if len(key) >= 2:
            unique.setdefault(key, (label, kind))
    return list(unique.values())[:24]


def load_reviewed_catalog(source: Path) -> tuple[list[dict], bytes]:
    """Load the immutable, already-reviewed public-safe catalog verbatim.

    This builder is deliberately not a preparation/sanitisation step.  Hashes,
    GraphRAG text and every canonical source field are validated by the shared
    official-input contract, then the exact records are indexed without edits.
    """

    source_bytes = source.read_bytes()
    validated = load_official_input_records(source)
    records: list[dict] = []
    for raw in source_bytes.decode("utf-8").splitlines():
        if not raw.strip():
            continue
        record = json.loads(raw)
        if not isinstance(record, dict):
            raise IndexManifestError("PUBLIC_SAFE_CATALOG_RECORD_INVALID")
        if not public_eligible(record):
            raise IndexManifestError("PUBLIC_SAFE_CATALOG_CONTAINS_BLOCKED_RECORD")
        records.append(record)
    if len(records) != len(validated):
        raise IndexManifestError("PUBLIC_SAFE_CATALOG_DUPLICATE_RECORD_ID")
    return records, source_bytes


def copy_official_input(source_bytes: bytes, official_input: Path) -> None:
    """Publish a byte-for-byte copy; never reserialize reviewed records."""

    official_input.parent.mkdir(parents=True, exist_ok=True)
    temporary_input = official_input.with_suffix(official_input.suffix + ".tmp")
    temporary_input.write_bytes(source_bytes)
    temporary_input.replace(official_input)


def build(source: Path, index_root: Path, version: str, publish: bool, official_input: Path | None = None) -> dict:
    records, source_bytes = load_reviewed_catalog(source)

    postings: dict[str, dict[int, float]] = defaultdict(dict)
    entity_docs: dict[str, set[int]] = defaultdict(set)
    entity_meta: dict[str, dict] = {}
    edges: Counter[tuple[str, str]] = Counter()
    for index, record in enumerate(records):
        fields = [
            (record["title"], 8.0),
            (record["source_relative_path"], 6.0),
            (" ".join(record["tags"]), 4.0),
            (record["content"], 1.0),
        ]
        for value, weight in fields:
            for term in terms_for(value):
                postings[term][index] = max(weight, postings[term].get(index, 0.0))
        doc_entity_keys: list[str] = []
        for label, kind in entity_pairs(record):
            key = normalize(label)
            entity_docs[key].add(index)
            entity_meta.setdefault(key, {"label": label, "normalized": key, "type": kind})
            doc_entity_keys.append(key)
        for left, right in combinations(sorted(set(doc_entity_keys)), 2):
            edges[(left, right)] += 1

    maximum_df = max(20, int(len(records) * 0.8))
    serial_postings = {
        term: [[doc_index, weight] for doc_index, weight in sorted(values.items())]
        for term, values in postings.items()
        if len(values) <= maximum_df
    }
    entities = {
        key: {**entity_meta[key], "documents": sorted(document_indexes)}
        for key, document_indexes in entity_docs.items()
    }
    neighbor_map: dict[str, list[list]] = defaultdict(list)
    for (left, right), weight in edges.items():
        neighbor_map[left].append([right, weight])
        neighbor_map[right].append([left, weight])
    neighbors = {
        key: sorted(values, key=lambda item: (-item[1], item[0]))[:30]
        for key, values in neighbor_map.items()
    }
    metadata = {
        "version": version,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "source_file": source.name,
        "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "document_count": len(records),
        "entity_count": len(entities),
        "relationship_count": len(edges),
        "posting_term_count": len(serial_postings),
        "admission_policy": "immutable_reviewed_public_safe_catalog_v1",
        "rejected_by_type": {},
        "engine": "bootstrap_graph",
        "production_eligible": False,
        "candidate_record_list_sha256": approved_record_list_sha256(records),
    }
    if official_input:
        copy_official_input(source_bytes, official_input)
        metadata["official_input"] = str(official_input)
    target_dir = index_root / version
    staging = index_root / f".{version}.staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=False)
    with gzip.open(staging / "bootstrap.json.gz", "wt", encoding="utf-8", compresslevel=6) as stream:
        json.dump({
            "metadata": metadata,
            "documents": records,
            "postings": serial_postings,
            "entities": entities,
            "neighbors": neighbors,
        }, stream, ensure_ascii=False, separators=(",", ":"))
    (staging / "manifest.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    if target_dir.exists():
        raise RuntimeError(f"Index version already exists: {target_dir}")
    staging.rename(target_dir)
    if publish:
        pointer_temp = index_root / ".current.json.tmp"
        pointer_temp.write_text(json.dumps({"version": version, "published_at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False, indent=2), encoding="utf-8")
        pointer_temp.replace(index_root / "current.json")
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description="Build from an immutable, already-reviewed public-safe GraphRAG catalog without changing fields.")
    parser.add_argument("--source", type=Path, required=True, help="Reviewed huamei-public-safe.jsonl; hashes/text/fields must already be final.")
    parser.add_argument("--index-root", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "indexes")
    parser.add_argument("--version", required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--official-input", type=Path)
    args = parser.parse_args()
    metadata = build(
        args.source.resolve(),
        args.index_root.resolve(),
        args.version,
        args.publish,
        args.official_input.resolve() if args.official_input else None,
    )
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
