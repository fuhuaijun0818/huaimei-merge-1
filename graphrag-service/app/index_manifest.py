from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping


INDEX_MANIFEST_SCHEMA = "huamei.graphrag.index-manifest.v1"
RELEASE_BINDING_SCHEMA = "huamei.knowledge.release-binding.v1"
OFFICIAL_ENGINE = "official_graphrag_3_1_1"
APPROVAL_ROLES = ("business", "medical", "compliance")
REQUIRED_OFFICIAL_ARTIFACTS = (
    "entities.parquet",
    "communities.parquet",
    "community_reports.parquet",
    "text_units.parquet",
    "relationships.parquet",
    "record_catalog.jsonl",
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class IndexManifestError(RuntimeError):
    """Raised when an index cannot prove its immutable release binding."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class RequestBindingError(ValueError):
    """Raised when a query is not bound to the loaded tenant/release/index tuple."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_path(path: Path) -> str:
    """Hash a file, or a directory as sorted relative-path plus content hashes."""

    path = path.resolve()
    if path.is_file():
        return sha256_file(path)
    if not path.is_dir():
        raise IndexManifestError("KNOWLEDGE_PACKAGE_NOT_FOUND")
    entries: list[dict[str, str]] = []
    for child in sorted((item for item in path.rglob("*") if item.is_file()), key=lambda item: item.as_posix()):
        entries.append({"path": child.relative_to(path).as_posix(), "sha256": sha256_file(child)})
    if not entries:
        raise IndexManifestError("KNOWLEDGE_PACKAGE_EMPTY")
    return sha256_bytes(canonical_json_bytes(entries))


def _require_sha256(value: Any, code: str) -> str:
    normalized = str(value or "").strip().lower()
    if not SHA256_PATTERN.fullmatch(normalized):
        raise IndexManifestError(code)
    return normalized


def _required_record_text(record: Mapping[str, Any], field: str) -> str:
    value = str(record.get(field) or "").strip()
    if not value:
        raise IndexManifestError(f"OFFICIAL_INPUT_{field.upper()}_MISSING")
    return value


def canonical_record_material(record: Mapping[str, Any]) -> dict[str, Any]:
    """Return the complete, security-relevant source material for one record.

    The official GraphRAG input must carry these source fields explicitly.  The
    declared hash is never used as the hash source: it is only compared with a
    digest recomputed from the actual values below.
    """

    tags = record.get("tags")
    if not isinstance(tags, list) or not all(isinstance(item, str) for item in tags):
        raise IndexManifestError("OFFICIAL_INPUT_TAGS_INVALID")
    sensitivity = str(record.get("sensitivity") or "").strip().lower()
    if sensitivity not in {"public", "internal"}:
        raise IndexManifestError("OFFICIAL_INPUT_SENSITIVITY_INVALID")
    material = {
        "record_id": _required_record_text(record, "record_id"),
        "record_type": _required_record_text(record, "record_type"),
        "title": _required_record_text(record, "title"),
        "content": _required_record_text(record, "content"),
        "tags": tags,
        "source_relative_path": _required_record_text(record, "source_relative_path"),
        "sensitivity": sensitivity,
        "verification_note": _required_record_text(record, "verification_note"),
    }
    return material


def official_record_text(record: Mapping[str, Any]) -> str:
    material = canonical_record_material(record)
    return "\n".join([
        f"标题：{material['title']}",
        f"来源：{material['source_relative_path']}",
        f"标签：{'、'.join(material['tags'])}",
        material["content"],
        f"核验说明：{material['verification_note']}",
    ])


def record_content_sha256(record: Mapping[str, Any]) -> str:
    """Recompute and, when declared, constant-time verify the record digest."""

    computed = sha256_bytes(canonical_json_bytes(canonical_record_material(record)))
    supplied = str(record.get("record_content_sha256") or "").strip().lower()
    if supplied:
        supplied = _require_sha256(supplied, "INVALID_RECORD_CONTENT_SHA256")
        if not hmac.compare_digest(supplied, computed):
            raise IndexManifestError("RECORD_CONTENT_SHA256_MISMATCH")
    return computed


def canonical_record_list(records: Iterable[Mapping[str, Any]]) -> list[dict[str, str]]:
    by_id: dict[str, str] = {}
    for item in records:
        record_id = str(item.get("record_id") or "").strip()
        if not record_id:
            raise IndexManifestError("APPROVED_RECORD_ID_MISSING")
        content_sha = _require_sha256(item.get("record_content_sha256"), "INVALID_RECORD_CONTENT_SHA256")
        previous = by_id.setdefault(record_id, content_sha)
        if previous != content_sha:
            raise IndexManifestError("DUPLICATE_RECORD_ID_HASH_CONFLICT")
    return [
        {"record_id": record_id, "record_content_sha256": by_id[record_id]}
        for record_id in sorted(by_id)
    ]


def approved_record_list_sha256(records: Iterable[Mapping[str, Any]]) -> str:
    return sha256_bytes(canonical_json_bytes(canonical_record_list(records)))


def load_record_list(path: Path) -> list[dict[str, str]]:
    path = path.resolve()
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise IndexManifestError("APPROVED_RECORD_LIST_NOT_FOUND") from error
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            parsed = parsed.get("records")
        if not isinstance(parsed, list):
            raise ValueError("not a list")
        values = parsed
    except (json.JSONDecodeError, ValueError):
        values = []
        for line in raw.splitlines():
            if line.strip():
                try:
                    values.append(json.loads(line))
                except json.JSONDecodeError as error:
                    raise IndexManifestError("APPROVED_RECORD_LIST_INVALID_JSON") from error
    if not values:
        raise IndexManifestError("APPROVED_RECORD_LIST_EMPTY")
    if not all(isinstance(item, dict) for item in values):
        raise IndexManifestError("APPROVED_RECORD_LIST_INVALID")
    return canonical_record_list(values)


def load_official_input_records(path: Path) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    try:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise IndexManifestError("OFFICIAL_INPUT_INVALID")
                declared_hash = _require_sha256(
                    item.get("record_content_sha256"),
                    "OFFICIAL_INPUT_RECORD_HASH_MISSING",
                )
                computed_hash = record_content_sha256(item)
                actual_text = str(item.get("text") or "")
                if not actual_text:
                    raise IndexManifestError("OFFICIAL_INPUT_TEXT_MISSING")
                if not hmac.compare_digest(actual_text.encode("utf-8"), official_record_text(item).encode("utf-8")):
                    raise IndexManifestError("OFFICIAL_INPUT_TEXT_MISMATCH")
                records.append({
                    "record_id": str(item.get("record_id") or ""),
                    "record_content_sha256": computed_hash,
                })
                if not hmac.compare_digest(declared_hash, computed_hash):
                    raise IndexManifestError("RECORD_CONTENT_SHA256_MISMATCH")
    except OSError as error:
        raise IndexManifestError("OFFICIAL_INPUT_NOT_FOUND") from error
    except json.JSONDecodeError as error:
        raise IndexManifestError("OFFICIAL_INPUT_INVALID_JSONL") from error
    if not records:
        raise IndexManifestError("OFFICIAL_INPUT_EMPTY")
    return canonical_record_list(records)


def model_configuration_fingerprint(
    project_root: Path,
    environment: Mapping[str, str] | None = None,
) -> dict[str, str]:
    values = environment if environment is not None else os.environ
    settings_file = project_root / "settings.yaml"
    if not settings_file.is_file():
        raise IndexManifestError("GRAPHRAG_SETTINGS_NOT_FOUND")
    prompts_root = project_root / "prompts"
    if not prompts_root.is_dir():
        raise IndexManifestError("GRAPHRAG_PROMPTS_NOT_FOUND")
    material = {
        "model_provider": str(values.get("GRAPHRAG_MODEL_PROVIDER", "")).strip(),
        "completion_model": str(values.get("GRAPHRAG_COMPLETION_MODEL", "")).strip(),
        "embedding_model": str(values.get("GRAPHRAG_EMBEDDING_MODEL", "")).strip(),
        # The endpoint can reveal internal topology, so only its digest is persisted.
        "api_base_sha256": sha256_bytes(str(values.get("GRAPHRAG_API_BASE", "")).strip().encode("utf-8")),
        "settings_sha256": sha256_file(settings_file),
        "prompts_sha256": sha256_path(prompts_root),
    }
    if not all(material[name] for name in ("model_provider", "completion_model", "embedding_model")):
        raise IndexManifestError("GRAPHRAG_MODEL_CONFIGURATION_INCOMPLETE")
    return {**material, "fingerprint_sha256": sha256_bytes(canonical_json_bytes(material))}


def load_release_binding(
    path: Path,
    *,
    index_version: str,
    knowledge_package_sha256: str,
    approved_records_sha256: str,
) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise IndexManifestError("RELEASE_BINDING_NOT_FOUND") from error
    except json.JSONDecodeError as error:
        raise IndexManifestError("RELEASE_BINDING_INVALID_JSON") from error
    if payload.get("schema_version") != RELEASE_BINDING_SCHEMA:
        raise IndexManifestError("RELEASE_BINDING_SCHEMA_UNSUPPORTED")
    if str(payload.get("index_version") or "") != index_version:
        raise IndexManifestError("RELEASE_INDEX_VERSION_MISMATCH")
    if _require_sha256(payload.get("knowledge_package_sha256"), "RELEASE_PACKAGE_SHA_MISSING") != knowledge_package_sha256:
        raise IndexManifestError("RELEASE_PACKAGE_SHA_MISMATCH")
    if _require_sha256(payload.get("approved_record_list_sha256"), "RELEASE_RECORD_LIST_SHA_MISSING") != approved_records_sha256:
        raise IndexManifestError("RELEASE_RECORD_LIST_SHA_MISMATCH")
    tenant_id = str(payload.get("tenant_id") or "").strip()
    release_id = str(payload.get("release_id") or "").strip()
    if not tenant_id or not release_id:
        raise IndexManifestError("RELEASE_TENANT_OR_ID_MISSING")
    approvals = payload.get("approvals")
    if not isinstance(approvals, dict):
        raise IndexManifestError("THREE_REVIEW_APPROVALS_MISSING")
    normalized_approvals: dict[str, dict[str, str]] = {}
    for role in APPROVAL_ROLES:
        approval = approvals.get(role)
        if not isinstance(approval, dict) or approval.get("status") != "approved":
            raise IndexManifestError(f"{role.upper()}_REVIEW_NOT_APPROVED")
        review_id = str(approval.get("review_id") or "").strip()
        reviewed_at = str(approval.get("reviewed_at") or "").strip()
        if not review_id or not reviewed_at:
            raise IndexManifestError(f"{role.upper()}_REVIEW_RECEIPT_INCOMPLETE")
        normalized_approvals[role] = {
            "status": "approved",
            "review_id": review_id,
            "reviewed_at": reviewed_at,
        }
    return {
        "schema_version": RELEASE_BINDING_SCHEMA,
        "tenant_id": tenant_id,
        "release_id": release_id,
        "index_version": index_version,
        "knowledge_package_sha256": knowledge_package_sha256,
        "approved_record_list_sha256": approved_records_sha256,
        "approval_receipt_sha256": sha256_file(path),
        "approvals": normalized_approvals,
    }


def _artifact_entry(output_root: Path, relative_path: str) -> dict[str, Any]:
    target = (output_root / relative_path).resolve()
    try:
        target.relative_to(output_root.resolve())
    except ValueError as error:
        raise IndexManifestError("ARTIFACT_PATH_ESCAPES_INDEX_ROOT") from error
    if not target.is_file():
        raise IndexManifestError(f"INDEX_ARTIFACT_MISSING:{relative_path}")
    return {"path": relative_path, "sha256": sha256_file(target), "size_bytes": target.stat().st_size}


def build_index_manifest(
    *,
    output_root: Path,
    project_root: Path,
    index_version: str,
    method: str,
    input_file: Path,
    input_record_count: int,
    release_binding: Mapping[str, Any],
    environment: Mapping[str, str] | None = None,
    built_at: str | None = None,
) -> dict[str, Any]:
    artifacts = {
        Path(name).stem: _artifact_entry(output_root, name)
        for name in REQUIRED_OFFICIAL_ARTIFACTS
    }
    vector_store = output_root / "lancedb"
    if vector_store.is_dir():
        artifacts["vector_store"] = {
            "path": "lancedb",
            "sha256": sha256_path(vector_store),
            "size_bytes": sum(item.stat().st_size for item in vector_store.rglob("*") if item.is_file()),
        }
    index_content_material = {
        key: {"path": value["path"], "sha256": value["sha256"]}
        for key, value in sorted(artifacts.items())
    }
    manifest: dict[str, Any] = {
        "schema_version": INDEX_MANIFEST_SCHEMA,
        "index_version": index_version,
        "engine": OFFICIAL_ENGINE,
        "built_at": built_at or datetime.now(timezone.utc).isoformat(),
        "build": {"method": method, "graphrag_version": "3.1.1"},
        "input": {
            "path": input_file.name,
            "sha256": sha256_file(input_file),
            "record_count": input_record_count,
        },
        "release_binding": dict(release_binding),
        "model_fingerprint": model_configuration_fingerprint(project_root, environment),
        "artifacts": artifacts,
        "index_content_sha256": sha256_bytes(canonical_json_bytes(index_content_material)),
    }
    manifest["manifest_sha256"] = sha256_bytes(canonical_json_bytes(manifest))
    return manifest


@dataclass(frozen=True)
class IndexManifest:
    payload: dict[str, Any]
    output_root: Path

    @property
    def index_version(self) -> str:
        return str(self.payload["index_version"])

    @property
    def tenant_id(self) -> str:
        return str(self.payload["release_binding"]["tenant_id"])

    @property
    def release_id(self) -> str:
        return str(self.payload["release_binding"]["release_id"])

    @classmethod
    def load(
        cls,
        manifest_path: Path,
        *,
        expected_version: str,
        project_root: Path,
        environment: Mapping[str, str] | None = None,
    ) -> "IndexManifest":
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except OSError as error:
            raise IndexManifestError("OFFICIAL_INDEX_MANIFEST_MISSING") from error
        except json.JSONDecodeError as error:
            raise IndexManifestError("OFFICIAL_INDEX_MANIFEST_INVALID_JSON") from error
        if payload.get("schema_version") != INDEX_MANIFEST_SCHEMA:
            raise IndexManifestError("OFFICIAL_INDEX_MANIFEST_UNREVIEWED")
        expected_manifest_sha = _require_sha256(payload.get("manifest_sha256"), "MANIFEST_SHA256_MISSING")
        unsigned = dict(payload)
        del unsigned["manifest_sha256"]
        if sha256_bytes(canonical_json_bytes(unsigned)) != expected_manifest_sha:
            raise IndexManifestError("MANIFEST_SHA256_MISMATCH")
        if payload.get("engine") != OFFICIAL_ENGINE:
            raise IndexManifestError("OFFICIAL_INDEX_ENGINE_MISMATCH")
        if not expected_version or payload.get("index_version") != expected_version:
            raise IndexManifestError("ACTIVE_INDEX_VERSION_MISMATCH")
        if not str(payload.get("built_at") or "").strip():
            raise IndexManifestError("INDEX_BUILD_TIME_MISSING")
        build = payload.get("build")
        if not isinstance(build, dict) or build.get("graphrag_version") != "3.1.1":
            raise IndexManifestError("GRAPHRAG_BUILD_VERSION_MISMATCH")
        input_metadata = payload.get("input")
        if not isinstance(input_metadata, dict):
            raise IndexManifestError("INDEX_INPUT_METADATA_MISSING")
        _require_sha256(input_metadata.get("sha256"), "INDEX_INPUT_SHA_INVALID")
        if not str(input_metadata.get("path") or "").strip() or int(input_metadata.get("record_count") or 0) < 1:
            raise IndexManifestError("INDEX_INPUT_METADATA_INCOMPLETE")
        binding = payload.get("release_binding")
        if not isinstance(binding, dict) or binding.get("schema_version") != RELEASE_BINDING_SCHEMA:
            raise IndexManifestError("INDEX_RELEASE_BINDING_MISSING")
        for field in ("tenant_id", "release_id", "knowledge_package_sha256", "approved_record_list_sha256"):
            if not str(binding.get(field) or "").strip():
                raise IndexManifestError(f"INDEX_RELEASE_BINDING_{field.upper()}_MISSING")
        _require_sha256(binding.get("knowledge_package_sha256"), "INDEX_PACKAGE_SHA_INVALID")
        _require_sha256(binding.get("approved_record_list_sha256"), "INDEX_RECORD_LIST_SHA_INVALID")
        _require_sha256(binding.get("approval_receipt_sha256"), "INDEX_APPROVAL_RECEIPT_SHA_INVALID")
        if binding.get("index_version") != payload.get("index_version"):
            raise IndexManifestError("INDEX_RELEASE_VERSION_BINDING_MISMATCH")
        approvals = binding.get("approvals")
        if not isinstance(approvals, dict) or any(
            not isinstance(approvals.get(role), dict) or approvals[role].get("status") != "approved"
            for role in APPROVAL_ROLES
        ):
            raise IndexManifestError("INDEX_THREE_REVIEW_BINDING_INVALID")
        if any(
            not str(approvals[role].get("review_id") or "").strip()
            or not str(approvals[role].get("reviewed_at") or "").strip()
            for role in APPROVAL_ROLES
        ):
            raise IndexManifestError("INDEX_THREE_REVIEW_RECEIPT_INCOMPLETE")

        instance = cls(payload=payload, output_root=manifest_path.parent.resolve())
        instance.verify_artifacts()
        current_fingerprint = model_configuration_fingerprint(project_root, environment)
        recorded_fingerprint = payload.get("model_fingerprint")
        if not isinstance(recorded_fingerprint, dict) or any(
            not str(recorded_fingerprint.get(field) or "").strip()
            for field in (
                "model_provider", "completion_model", "embedding_model", "api_base_sha256",
                "settings_sha256", "prompts_sha256",
            )
        ) or (
            recorded_fingerprint.get("fingerprint_sha256") != current_fingerprint["fingerprint_sha256"]
        ):
            raise IndexManifestError("MODEL_CONFIGURATION_FINGERPRINT_MISMATCH")
        return instance

    def verify_artifacts(self) -> None:
        artifacts = self.payload.get("artifacts")
        if not isinstance(artifacts, dict):
            raise IndexManifestError("INDEX_ARTIFACT_MANIFEST_MISSING")
        expected_keys = {Path(name).stem for name in REQUIRED_OFFICIAL_ARTIFACTS}
        if not expected_keys.issubset(artifacts):
            raise IndexManifestError("INDEX_REQUIRED_ARTIFACT_HASHES_MISSING")
        verified: dict[str, dict[str, str]] = {}
        for name, metadata in sorted(artifacts.items()):
            if not isinstance(metadata, dict):
                raise IndexManifestError("INDEX_ARTIFACT_ENTRY_INVALID")
            relative_path = str(metadata.get("path") or "")
            target = (self.output_root / relative_path).resolve()
            try:
                target.relative_to(self.output_root)
            except ValueError as error:
                raise IndexManifestError("ARTIFACT_PATH_ESCAPES_INDEX_ROOT") from error
            expected_sha = _require_sha256(metadata.get("sha256"), "INDEX_ARTIFACT_SHA_INVALID")
            actual_sha = sha256_path(target)
            if actual_sha != expected_sha:
                raise IndexManifestError(f"INDEX_ARTIFACT_SHA_MISMATCH:{name}")
            verified[name] = {"path": relative_path, "sha256": actual_sha}
        expected_content_sha = _require_sha256(self.payload.get("index_content_sha256"), "INDEX_CONTENT_SHA256_INVALID")
        if sha256_bytes(canonical_json_bytes(verified)) != expected_content_sha:
            raise IndexManifestError("INDEX_CONTENT_SHA256_MISMATCH")

    def validate_request(self, *, tenant_id: str, release_id: str | None, index_version: str | None) -> None:
        if tenant_id != self.tenant_id:
            raise RequestBindingError("TENANT_INDEX_BINDING_MISMATCH")
        if not release_id:
            raise RequestBindingError("RELEASE_ID_REQUIRED")
        if release_id != self.release_id:
            raise RequestBindingError("RELEASE_INDEX_BINDING_MISMATCH")
        if not index_version:
            raise RequestBindingError("INDEX_VERSION_REQUIRED")
        if index_version != self.index_version:
            raise RequestBindingError("INDEX_VERSION_BINDING_MISMATCH")
