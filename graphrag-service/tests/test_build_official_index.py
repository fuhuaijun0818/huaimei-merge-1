from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.index_manifest import (
    RELEASE_BINDING_SCHEMA,
    approved_record_list_sha256,
    official_record_text,
    record_content_sha256,
    sha256_path,
)
from scripts import build_official_index


class OfficialIndexBuildEntrypointTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.project = self.root / "project"
        (self.project / "input").mkdir(parents=True)
        (self.project / "settings.yaml").write_text("input:\n  type: jsonl\n", encoding="utf-8")
        (self.project / "prompts").mkdir()
        (self.project / "prompts" / "local.txt").write_text("prompt", encoding="utf-8")
        source_record = {
            "record_id": "record-a",
            "record_type": "image_ocr",
            "title": "记录A",
            "content": "记录A的三审正文。",
            "tags": ["项目介绍"],
            "source_relative_path": "项目介绍/记录A",
            "sensitivity": "internal",
            "verification_note": "三审通过。",
        }
        source_record["record_content_sha256"] = record_content_sha256(source_record)
        source_record["text"] = official_record_text(source_record)
        self.records = [source_record]
        (self.project / "input" / "huamei-public-safe.jsonl").write_text(
            json.dumps(self.records[0]) + "\n",
            encoding="utf-8",
        )
        self.package = self.root / "package.jsonl"
        self.package.write_bytes((self.project / "input" / "huamei-public-safe.jsonl").read_bytes())
        self.record_list = self.root / "approved-records.json"
        self.record_list.write_text(json.dumps({"records": self.records}), encoding="utf-8")
        self.receipt = self.root / "release-binding.json"
        self.receipt_payload = {
            "schema_version": RELEASE_BINDING_SCHEMA,
            "tenant_id": "huamei-shanghai",
            "release_id": "release-a",
            "index_version": "index-a",
            "knowledge_package_sha256": sha256_path(self.package),
            "approved_record_list_sha256": approved_record_list_sha256(self.records),
            "approvals": {
                role: {"status": "approved", "review_id": f"review-{role}", "reviewed_at": "2026-08-26T00:00:00Z"}
                for role in ("business", "medical", "compliance")
            },
        }
        self.receipt.write_text(json.dumps(self.receipt_payload), encoding="utf-8")
        self.environment = {
            "GRAPHRAG_EXTERNAL_INDEXING_APPROVED": build_official_index.ACKNOWLEDGEMENT,
            "GRAPHRAG_API_KEY": "test-only-key",
            "GRAPHRAG_API_BASE": "https://model.example.invalid/v1",
            "GRAPHRAG_MODEL_PROVIDER": "openai",
            "GRAPHRAG_COMPLETION_MODEL": "completion-model",
            "GRAPHRAG_EMBEDDING_MODEL": "embedding-model",
        }
        self.argv = [
            "build_official_index.py",
            "--project-root", str(self.project),
            "--version", "index-a",
            "--release-binding", str(self.receipt),
            "--knowledge-package", str(self.package),
            "--approved-record-list", str(self.record_list),
            "--dry-run",
        ]

    def tearDown(self):
        self.temporary.cleanup()

    def test_invokes_real_official_graphrag_module_entrypoint(self):
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, "argv", self.argv), patch.object(
            build_official_index.subprocess,
            "run",
            return_value=SimpleNamespace(returncode=0),
        ) as run:
            self.assertEqual(build_official_index.main(), 0)
        command = run.call_args.args[0]
        self.assertEqual(command[:4], [sys.executable, "-m", "graphrag", "index"])
        self.assertIn("--dry-run", command)

    def test_three_review_failure_blocks_before_external_indexer(self):
        self.receipt_payload["approvals"]["medical"]["status"] = "pending"
        self.receipt.write_text(json.dumps(self.receipt_payload), encoding="utf-8")
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, "argv", self.argv), patch.object(
            build_official_index.subprocess,
            "run",
        ) as run:
            self.assertEqual(build_official_index.main(), 4)
        run.assert_not_called()

    def test_stale_approved_hash_cannot_authorize_tampered_input(self):
        tampered = dict(self.records[0])
        tampered["content"] = "未审批的替换正文"
        (self.project / "input" / "huamei-public-safe.jsonl").write_text(
            json.dumps(tampered, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, "argv", self.argv), patch.object(
            build_official_index.subprocess,
            "run",
        ) as run:
            self.assertEqual(build_official_index.main(), 4)
        run.assert_not_called()

    def test_different_package_cannot_be_bound_to_official_input(self):
        self.package.write_text("different reviewed package", encoding="utf-8")
        self.receipt_payload["knowledge_package_sha256"] = sha256_path(self.package)
        self.receipt.write_text(json.dumps(self.receipt_payload), encoding="utf-8")
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, "argv", self.argv), patch.object(
            build_official_index.subprocess,
            "run",
        ) as run:
            self.assertEqual(build_official_index.main(), 4)
        run.assert_not_called()

    def test_successful_build_publishes_exact_approved_record_catalog(self):
        self.argv = [item for item in self.argv if item != "--dry-run"]
        (self.project / "output").mkdir(exist_ok=True)
        for name in build_official_index.REQUIRED_OUTPUTS:
            (self.project / "output" / name).write_bytes(f"fixture:{name}".encode())
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, "argv", self.argv), patch.object(
            build_official_index.subprocess,
            "run",
            return_value=SimpleNamespace(returncode=0),
        ):
            self.assertEqual(build_official_index.main(), 0)
        catalog = self.project / "output" / "record_catalog.jsonl"
        self.assertEqual(catalog.read_bytes(), (self.project / "input" / "huamei-public-safe.jsonl").read_bytes())
        manifest = json.loads((self.project / "output" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["artifacts"]["record_catalog"]["sha256"], manifest["input"]["sha256"])


if __name__ == "__main__":
    unittest.main()
