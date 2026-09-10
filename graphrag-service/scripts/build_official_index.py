from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.index_manifest import (  # noqa: E402
    IndexManifestError,
    approved_record_list_sha256,
    build_index_manifest,
    load_official_input_records,
    load_record_list,
    load_release_binding,
    sha256_path,
)
from scripts.build_bootstrap_index import load_reviewed_catalog  # noqa: E402


ACKNOWLEDGEMENT = "I_UNDERSTAND_DATA_WILL_BE_SENT_TO_MODEL_PROVIDER"
REQUIRED_OUTPUTS = ("entities.parquet", "communities.parquet", "community_reports.parquet", "text_units.parquet", "relationships.parquet")


def main() -> int:
    parser = argparse.ArgumentParser(description="Explicitly build and publish the official Microsoft GraphRAG index.")
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1] / "graphrag_project")
    parser.add_argument("--version", required=True)
    parser.add_argument("--method", choices=["standard", "fast"], default="standard")
    parser.add_argument(
        "--release-binding",
        type=Path,
        required=True,
        help="Three-review release receipt using huamei.knowledge.release-binding.v1.",
    )
    parser.add_argument(
        "--knowledge-package",
        type=Path,
        required=True,
        help="Immutable knowledge package file or directory referenced by the release.",
    )
    parser.add_argument(
        "--approved-record-list",
        type=Path,
        required=True,
        help="JSON/JSONL list of record_id + record_content_sha256 pairs.",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        installed_version = package_version("graphrag")
    except PackageNotFoundError:
        installed_version = ""
    if installed_version != "3.1.1":
        print(
            f"Official GraphRAG runtime mismatch: expected 3.1.1, found {installed_version or 'missing'}.",
            file=sys.stderr,
        )
        return 2

    if os.getenv("GRAPHRAG_EXTERNAL_INDEXING_APPROVED") != ACKNOWLEDGEMENT:
        print("Refusing external indexing: explicit data-transfer and cost acknowledgement is missing.", file=sys.stderr)
        return 2
    required_env = ["GRAPHRAG_API_KEY", "GRAPHRAG_API_BASE", "GRAPHRAG_MODEL_PROVIDER", "GRAPHRAG_COMPLETION_MODEL", "GRAPHRAG_EMBEDDING_MODEL"]
    missing = [name for name in required_env if not os.getenv(name, "").strip()]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        return 2

    project_root = args.project_root.resolve()
    input_file = project_root / "input" / "huamei-public-safe.jsonl"
    if not input_file.exists():
        print(f"Prepared public-safe input not found: {input_file}", file=sys.stderr)
        return 2
    output = project_root / "output"
    if (output / "manifest.json").exists():
        print(
            "Refusing to overwrite an immutable published index; use a fresh versioned project root.",
            file=sys.stderr,
        )
        return 4

    # Validate release approval and exact input membership before any data is
    # transferred to the model provider or any indexing cost is incurred.
    try:
        approved_records = load_record_list(args.approved_record_list)
        reviewed_records, _ = load_reviewed_catalog(input_file)
        input_records = load_official_input_records(input_file)
        if len(reviewed_records) != len(input_records):
            raise IndexManifestError("OFFICIAL_INPUT_NOT_EXACT_PUBLIC_SAFE_CATALOG")
        if input_records != approved_records:
            raise IndexManifestError("OFFICIAL_INPUT_NOT_EXACT_APPROVED_RECORD_SET")
        package_sha = sha256_path(args.knowledge_package)
        input_sha = sha256_path(input_file)
        if package_sha != input_sha:
            raise IndexManifestError("KNOWLEDGE_PACKAGE_NOT_EXACT_PUBLIC_SAFE_CATALOG")
        record_list_sha = approved_record_list_sha256(approved_records)
        release_binding = load_release_binding(
            args.release_binding.resolve(),
            index_version=args.version,
            knowledge_package_sha256=package_sha,
            approved_records_sha256=record_list_sha,
        )
    except IndexManifestError as error:
        print(f"Refusing official index build: {error.code}", file=sys.stderr)
        return 4

    # `python -m graphrag.cli.main` does not invoke the Typer application in
    # GraphRAG 3.1.1. The supported module entrypoint below is the real official
    # indexing pipeline (`graphrag index`).
    command = [sys.executable, "-m", "graphrag", "index", "--root", str(project_root), "--method", args.method]
    if args.dry_run:
        command.append("--dry-run")
    completed = subprocess.run(command, check=False)
    if completed.returncode or args.dry_run:
        return completed.returncode

    missing_outputs = [name for name in REQUIRED_OUTPUTS if not (output / name).exists()]
    if missing_outputs:
        print(f"Index build did not produce required tables: {', '.join(missing_outputs)}", file=sys.stderr)
        return 3
    # GraphRAG context exposes generated text-unit ids, not the approved
    # knowledge record ids used by the release admission service. Publish the
    # exact, already-approved public-safe input beside the index as an immutable
    # catalog. The manifest hashes this file, and the runtime joins
    # text_units.document_id back to these record ids before returning evidence.
    catalog = output / "record_catalog.jsonl"
    temporary_catalog = output / ".record_catalog.jsonl.tmp"
    shutil.copyfile(input_file, temporary_catalog)
    temporary_catalog.replace(catalog)
    try:
        manifest = build_index_manifest(
            output_root=output,
            project_root=project_root,
            index_version=args.version,
            method=args.method,
            input_file=input_file,
            input_record_count=len(input_records),
            release_binding=release_binding,
        )
    except IndexManifestError as error:
        print(f"Index artifacts cannot be published: {error.code}", file=sys.stderr)
        return 4
    temporary = output / ".manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output / "manifest.json")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
