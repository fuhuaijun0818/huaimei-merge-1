from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.index_manifest import (
    INDEX_MANIFEST_SCHEMA,
    RELEASE_BINDING_SCHEMA,
    REQUIRED_OFFICIAL_ARTIFACTS,
    IndexManifest,
    IndexManifestError,
    RequestBindingError,
    approved_record_list_sha256,
    build_index_manifest,
    load_official_input_records,
    load_record_list,
    load_release_binding,
    official_record_text,
    record_content_sha256,
    sha256_path,
)


MODEL_ENVIRONMENT = {
    "GRAPHRAG_MODEL_PROVIDER": "openai",
    "GRAPHRAG_COMPLETION_MODEL": "approved-completion-model",
    "GRAPHRAG_EMBEDDING_MODEL": "approved-embedding-model",
    "GRAPHRAG_API_BASE": "https://model.example.invalid/v1",
}


def content_sha(character: str) -> str:
    return character * 64


def official_record(record_id: str, title: str) -> dict:
    record = {
        "record_id": record_id,
        "record_type": "knowledge_article",
        "title": title,
        "content": f"{title}的已审核正文。",
        "tags": ["项目介绍"],
        "source_relative_path": f"项目介绍/{title}",
        "sensitivity": "internal",
        "verification_note": "业务、医务、合规三审通过。",
    }
    record["record_content_sha256"] = record_content_sha256(record)
    record["text"] = official_record_text(record)
    return record


class IndexManifestContractTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.project = self.root / "project"
        self.output = self.project / "output"
        self.input_file = self.project / "input" / "huamei-public-safe.jsonl"
        self.output.mkdir(parents=True)
        self.input_file.parent.mkdir(parents=True)
        (self.project / "settings.yaml").write_text("input:\n  type: jsonl\n", encoding="utf-8")
        (self.project / "prompts").mkdir()
        (self.project / "prompts" / "local.txt").write_text("approved prompt", encoding="utf-8")
        for artifact in REQUIRED_OFFICIAL_ARTIFACTS:
            (self.output / artifact).write_bytes(f"fixture:{artifact}".encode())
        self.records = [official_record("record-a", "记录A"), official_record("record-b", "记录B")]
        self.input_file.write_text("".join(
            json.dumps(item, ensure_ascii=False) + "\n" for item in self.records
        ), encoding="utf-8")
        self.release_binding = {
            "schema_version": RELEASE_BINDING_SCHEMA,
            "tenant_id": "huamei-shanghai",
            "release_id": "release-2026-08-26",
            "index_version": "index-2026-08-26.1",
            "knowledge_package_sha256": content_sha("c"),
            "approved_record_list_sha256": approved_record_list_sha256(self.records),
            "approval_receipt_sha256": content_sha("d"),
            "approvals": {
                role: {"status": "approved", "review_id": f"review-{role}", "reviewed_at": "2026-08-26T00:00:00Z"}
                for role in ("business", "medical", "compliance")
            },
        }

    def tearDown(self):
        self.temporary.cleanup()

    def write_manifest(self) -> Path:
        manifest = build_index_manifest(
            output_root=self.output,
            project_root=self.project,
            index_version="index-2026-08-26.1",
            method="standard",
            input_file=self.input_file,
            input_record_count=2,
            release_binding=self.release_binding,
            environment=MODEL_ENVIRONMENT,
            built_at="2026-08-26T00:00:00Z",
        )
        self.assertEqual(manifest["schema_version"], INDEX_MANIFEST_SCHEMA)
        path = self.output / "manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path

    def test_manifest_binds_tenant_release_index_and_all_artifact_hashes(self):
        manifest = IndexManifest.load(
            self.write_manifest(),
            expected_version="index-2026-08-26.1",
            project_root=self.project,
            environment=MODEL_ENVIRONMENT,
        )
        manifest.validate_request(
            tenant_id="huamei-shanghai",
            release_id="release-2026-08-26",
            index_version="index-2026-08-26.1",
        )
        for kwargs, expected in (
            ({"tenant_id": "other", "release_id": "release-2026-08-26", "index_version": "index-2026-08-26.1"}, "TENANT_INDEX_BINDING_MISMATCH"),
            ({"tenant_id": "huamei-shanghai", "release_id": None, "index_version": "index-2026-08-26.1"}, "RELEASE_ID_REQUIRED"),
            ({"tenant_id": "huamei-shanghai", "release_id": "other", "index_version": "index-2026-08-26.1"}, "RELEASE_INDEX_BINDING_MISMATCH"),
            ({"tenant_id": "huamei-shanghai", "release_id": "release-2026-08-26", "index_version": None}, "INDEX_VERSION_REQUIRED"),
            ({"tenant_id": "huamei-shanghai", "release_id": "release-2026-08-26", "index_version": "other"}, "INDEX_VERSION_BINDING_MISMATCH"),
        ):
            with self.subTest(expected=expected), self.assertRaisesRegex(RequestBindingError, expected):
                manifest.validate_request(**kwargs)

    def test_artifact_tamper_and_model_drift_fail_closed(self):
        manifest_path = self.write_manifest()
        (self.output / "relationships.parquet").write_bytes(b"tampered")
        with self.assertRaisesRegex(IndexManifestError, "INDEX_ARTIFACT_SHA_MISMATCH"):
            IndexManifest.load(
                manifest_path,
                expected_version="index-2026-08-26.1",
                project_root=self.project,
                environment=MODEL_ENVIRONMENT,
            )
        (self.output / "relationships.parquet").write_bytes(b"fixture:relationships.parquet")
        changed = {**MODEL_ENVIRONMENT, "GRAPHRAG_EMBEDDING_MODEL": "different-embedding-model"}
        with self.assertRaisesRegex(IndexManifestError, "MODEL_CONFIGURATION_FINGERPRINT_MISMATCH"):
            IndexManifest.load(
                manifest_path,
                expected_version="index-2026-08-26.1",
                project_root=self.project,
                environment=changed,
            )

    def test_release_receipt_requires_exact_package_record_set_and_three_reviews(self):
        package = self.root / "knowledge-package.jsonl"
        package.write_text("immutable package\n", encoding="utf-8")
        record_list = self.root / "approved-record-list.json"
        record_list.write_text(json.dumps({"records": self.records}), encoding="utf-8")
        canonical = load_record_list(record_list)
        self.assertEqual(load_official_input_records(self.input_file), canonical)
        receipt = {
            "schema_version": RELEASE_BINDING_SCHEMA,
            "tenant_id": "huamei-shanghai",
            "release_id": "release-2026-08-26",
            "index_version": "index-2026-08-26.1",
            "knowledge_package_sha256": sha256_path(package),
            "approved_record_list_sha256": approved_record_list_sha256(canonical),
            "approvals": {
                role: {"status": "approved", "review_id": f"review-{role}", "reviewed_at": "2026-08-26T00:00:00Z"}
                for role in ("business", "medical", "compliance")
            },
        }
        receipt_path = self.root / "release-binding.json"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        loaded = load_release_binding(
            receipt_path,
            index_version="index-2026-08-26.1",
            knowledge_package_sha256=sha256_path(package),
            approved_records_sha256=approved_record_list_sha256(canonical),
        )
        self.assertEqual(loaded["tenant_id"], "huamei-shanghai")

        receipt["approvals"]["medical"]["status"] = "pending"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(IndexManifestError, "MEDICAL_REVIEW_NOT_APPROVED"):
            load_release_binding(
                receipt_path,
                index_version="index-2026-08-26.1",
                knowledge_package_sha256=sha256_path(package),
                approved_records_sha256=approved_record_list_sha256(canonical),
            )

    def test_official_input_recomputes_actual_content_hash_and_rejects_stale_hash(self):
        for field, changed in (
            ("content", "未经三审的替换正文"),
            ("title", "被替换的标题"),
            ("source_relative_path", "未审批/替换路径"),
            ("verification_note", "伪造核验说明"),
        ):
            with self.subTest(field=field):
                tampered = dict(self.records[0])
                tampered[field] = changed
                self.input_file.write_text(json.dumps(tampered, ensure_ascii=False) + "\n", encoding="utf-8")
                with self.assertRaisesRegex(IndexManifestError, "RECORD_CONTENT_SHA256_MISMATCH"):
                    load_official_input_records(self.input_file)

    def test_official_input_text_is_deterministic_and_complete(self):
        tampered = dict(self.records[0])
        tampered["text"] = "任意替换的 GraphRAG 输入文本"
        self.input_file.write_text(json.dumps(tampered, ensure_ascii=False) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(IndexManifestError, "OFFICIAL_INPUT_TEXT_MISMATCH"):
            load_official_input_records(self.input_file)

        missing = dict(self.records[0])
        missing.pop("content")
        self.input_file.write_text(json.dumps(missing, ensure_ascii=False) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(IndexManifestError, "OFFICIAL_INPUT_CONTENT_MISSING"):
            load_official_input_records(self.input_file)

    def test_unreviewed_legacy_manifest_is_rejected(self):
        path = self.output / "manifest.json"
        path.write_text(json.dumps({"version": "legacy"}), encoding="utf-8")
        with self.assertRaisesRegex(IndexManifestError, "OFFICIAL_INDEX_MANIFEST_UNREVIEWED"):
            IndexManifest.load(
                path,
                expected_version="legacy",
                project_root=self.project,
                environment=MODEL_ENVIRONMENT,
            )


if __name__ == "__main__":
    unittest.main()
