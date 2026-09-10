from __future__ import annotations

import gzip
import json
import tempfile
import unittest
from pathlib import Path

from app.index_manifest import official_record_text, record_content_sha256, sha256_path
from scripts.build_bootstrap_index import build


class BootstrapIndexImmutableCatalogTest(unittest.TestCase):
    def test_reviewed_catalog_is_indexed_and_copied_without_field_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "huamei-public-safe.jsonl"
            long_content = "价格资料只用于测试不可变字段。" * 1000
            record = {
                "record_id": "reviewed-record-a",
                "record_type": "image_ocr",
                "title": "已审价格资料",
                "content": long_content,
                "tags": ["价格", "测试"],
                "source_relative_path": "项目价格/已审资料.png",
                "sensitivity": "internal",
                "verification_note": "原始三审核验说明，建图不得追加文字。",
            }
            record["record_content_sha256"] = record_content_sha256(record)
            record["text"] = official_record_text(record)
            source.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
            exact_source = source.read_bytes()
            official_copy = root / "official" / "huamei-public-safe.jsonl"

            metadata = build(source, root / "indexes", "immutable-v1", False, official_copy)

            self.assertEqual(metadata["source_sha256"], sha256_path(source))
            self.assertEqual(official_copy.read_bytes(), exact_source)
            with gzip.open(root / "indexes" / "immutable-v1" / "bootstrap.json.gz", "rt", encoding="utf-8") as stream:
                payload = json.load(stream)
            indexed = payload["documents"][0]
            self.assertEqual(indexed, record)
            self.assertEqual(indexed["content"], long_content)
            self.assertEqual(indexed["verification_note"], record["verification_note"])


if __name__ == "__main__":
    unittest.main()
