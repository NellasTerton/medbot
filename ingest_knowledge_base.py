#!/usr/bin/env python3
"""Load Markdown knowledge into Neon pgvector using Voyage AI embeddings."""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path
from typing import Iterable, Sequence

# Dependencies are installed locally so the script works without modifying the
# bundled/system Python runtime.
LOCAL_PACKAGES = Path(__file__).resolve().parent / ".python_packages"
if LOCAL_PACKAGES.is_dir():
    sys.path.insert(0, str(LOCAL_PACKAGES))

import psycopg2
from psycopg2.extras import execute_values
import requests


VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings"
VOYAGE_MODEL = "voyage-3"
EMBEDDING_DIMENSION = 1024
MIN_CHUNK_SIZE = 500
MAX_CHUNK_SIZE = 1000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Embed Markdown files with Voyage AI and load them into Neon."
    )
    parser.add_argument(
        "--keys",
        type=Path,
        default=Path("keys.txt"),
        help="File containing a Voyage key and a PostgreSQL URL (default: keys.txt).",
    )
    parser.add_argument(
        "--md-dir",
        type=Path,
        default=Path("."),
        help="Directory searched recursively for Markdown files (default: current directory).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=64,
        help="Number of chunks per Voyage request (default: 64).",
    )
    return parser.parse_args()


def load_credentials(keys_path: Path) -> tuple[str, str]:
    voyage_key = os.environ.get("VOYAGE_API_KEY")
    database_url = os.environ.get("DATABASE_URL")

    if keys_path.exists():
        raw_lines = keys_path.read_text(encoding="utf-8-sig").splitlines()
        values: dict[str, str] = {}
        literals: list[str] = []

        for raw_line in raw_lines:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            match = re.match(
                r"^([A-Za-z_][A-Za-z0-9_]*)\s*(?:[=:]|\s+-)\s*(.+)$",
                line,
            )
            if match:
                name, value = match.groups()
                values[name.upper()] = value.strip().strip("\"'")
            else:
                literals.append(line.strip().strip("\"'"))

        voyage_key = voyage_key or values.get("VOYAGE_API_KEY")
        database_url = (
            database_url
            or values.get("DATABASE_URL")
            or values.get("NEON_DATABASE_URL")
            or values.get("NEON_URI")
            or values.get("POSTGRES_URL")
        )

        for value in literals:
            if not voyage_key and value.startswith("pa-"):
                voyage_key = value
            if not database_url and re.match(r"^postgres(?:ql)?://", value):
                database_url = value

    if not voyage_key:
        raise ValueError(
            "Voyage API key not found in keys file or VOYAGE_API_KEY environment variable."
        )
    if not database_url:
        raise ValueError(
            "PostgreSQL URL not found in keys file or DATABASE_URL environment variable."
        )

    return voyage_key, database_url


def split_oversized_unit(unit: str) -> list[str]:
    """Split only when a single sentence itself exceeds the maximum size."""
    pieces: list[str] = []
    remaining = unit.strip()
    while len(remaining) > MAX_CHUNK_SIZE:
        cut = remaining.rfind(" ", 0, MAX_CHUNK_SIZE + 1)
        if cut < MIN_CHUNK_SIZE:
            cut = MAX_CHUNK_SIZE
        pieces.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        pieces.append(remaining)
    return pieces


def sentence_units(text: str) -> list[str]:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return []

    raw_units = re.split(r"(?<=[.!?…])(?:[ \t]+|\n+)|\n{2,}", text)
    units: list[str] = []
    for raw_unit in raw_units:
        unit = re.sub(r"\s*\n\s*", " ", raw_unit).strip()
        if not unit:
            continue
        units.extend(split_oversized_unit(unit))
    return units


def units_length(units: Sequence[str]) -> int:
    return sum(map(len, units)) + max(0, len(units) - 1)


def chunk_text(text: str) -> list[str]:
    units = sentence_units(text)
    if not units:
        return []

    grouped: list[list[str]] = []
    current: list[str] = []

    for unit in units:
        candidate = current + [unit]
        if current and units_length(candidate) > MAX_CHUNK_SIZE:
            grouped.append(current)
            current = [unit]
        else:
            current = candidate
    if current:
        grouped.append(current)

    # Repair short chunks by merging or moving complete sentence units.
    index = 0
    while index < len(grouped):
        if units_length(grouped[index]) >= MIN_CHUNK_SIZE or len(grouped) == 1:
            index += 1
            continue

        if index > 0 and units_length(grouped[index - 1] + grouped[index]) <= MAX_CHUNK_SIZE:
            grouped[index - 1].extend(grouped[index])
            del grouped[index]
            continue

        if (
            index + 1 < len(grouped)
            and units_length(grouped[index] + grouped[index + 1]) <= MAX_CHUNK_SIZE
        ):
            grouped[index].extend(grouped[index + 1])
            del grouped[index + 1]
            continue

        if index > 0:
            while (
                len(grouped[index - 1]) > 1
                and units_length(grouped[index]) < MIN_CHUNK_SIZE
            ):
                moved = grouped[index - 1][-1]
                new_left = grouped[index - 1][:-1]
                new_right = [moved] + grouped[index]
                if (
                    units_length(new_left) < MIN_CHUNK_SIZE
                    or units_length(new_right) > MAX_CHUNK_SIZE
                ):
                    break
                grouped[index - 1] = new_left
                grouped[index] = new_right

        index += 1

    return [" ".join(group).strip() for group in grouped if group]


def find_markdown_files(root: Path, keys_path: Path) -> list[Path]:
    ignored_parts = {
        ".git",
        ".python_packages",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
    }
    keys_resolved = keys_path.resolve()
    return sorted(
        path
        for path in root.rglob("*.md")
        if path.resolve() != keys_resolved
        and not any(part in ignored_parts for part in path.parts)
    )


def load_chunks(files: Iterable[Path]) -> list[str]:
    chunks: list[str] = []
    seen: set[str] = set()
    for path in files:
        text = path.read_text(encoding="utf-8-sig")
        for chunk in chunk_text(text):
            if chunk not in seen:
                seen.add(chunk)
                chunks.append(chunk)
    return chunks


def embed_batch(
    session: requests.Session,
    voyage_key: str,
    texts: Sequence[str],
    max_attempts: int = 6,
) -> list[list[float]]:
    payload = {
        "input": list(texts),
        "model": VOYAGE_MODEL,
        "input_type": "document",
    }
    headers = {
        "Authorization": f"Bearer {voyage_key}",
        "Content-Type": "application/json",
    }

    for attempt in range(1, max_attempts + 1):
        try:
            response = session.post(
                VOYAGE_EMBEDDINGS_URL,
                headers=headers,
                json=payload,
                timeout=(15, 120),
            )
            if response.status_code == 429 or response.status_code >= 500:
                if attempt == max_attempts:
                    response.raise_for_status()
                retry_after = response.headers.get("Retry-After")
                delay = float(retry_after) if retry_after else min(2 ** attempt, 30)
                print(
                    f"Voyage returned HTTP {response.status_code}; retrying in {delay:g}s.",
                    flush=True,
                )
                time.sleep(delay)
                continue

            response.raise_for_status()
            body = response.json()
            items = sorted(body["data"], key=lambda item: item["index"])
            embeddings = [item["embedding"] for item in items]

            if len(embeddings) != len(texts):
                raise RuntimeError(
                    f"Voyage returned {len(embeddings)} embeddings for {len(texts)} texts."
                )
            for embedding in embeddings:
                if len(embedding) != EMBEDDING_DIMENSION:
                    raise RuntimeError(
                        f"Expected {EMBEDDING_DIMENSION}-dimensional embedding, "
                        f"received {len(embedding)}."
                    )
            return embeddings
        except (requests.Timeout, requests.ConnectionError):
            if attempt == max_attempts:
                raise
            delay = min(2 ** attempt, 30)
            print(f"Voyage request failed; retrying in {delay}s.", flush=True)
            time.sleep(delay)

    raise RuntimeError("Embedding request failed unexpectedly.")


def vector_literal(embedding: Sequence[float]) -> str:
    return "[" + ",".join(format(value, ".9g") for value in embedding) + "]"


def main() -> int:
    args = parse_args()
    if not 1 <= args.batch_size <= 128:
        raise ValueError("--batch-size must be between 1 and 128.")

    voyage_key, database_url = load_credentials(args.keys)
    files = find_markdown_files(args.md_dir, args.keys)
    if not files:
        raise FileNotFoundError(f"No Markdown files found under {args.md_dir.resolve()}.")

    chunks = load_chunks(files)
    print(f"Found {len(files)} Markdown files and prepared {len(chunks)} unique chunks.")
    if chunks:
        sizes = [len(chunk) for chunk in chunks]
        print(f"Chunk sizes: min={min(sizes)}, max={max(sizes)} characters.")

    with psycopg2.connect(database_url, connect_timeout=20) as connection:
        with connection.cursor() as cursor:
            cursor.execute("CREATE EXTENSION IF NOT EXISTS vector;")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS knowledge_base (
                    id bigserial PRIMARY KEY,
                    content text,
                    embedding vector(1024)
                );
                """
            )
        connection.commit()

        with connection.cursor() as cursor:
            cursor.execute("SELECT content FROM knowledge_base;")
            existing = {row[0] for row in cursor.fetchall()}

        pending = [chunk for chunk in chunks if chunk not in existing]
        print(
            f"Database already contains {len(existing)} rows; "
            f"{len(pending)} new chunks need embeddings."
        )

        if pending:
            session = requests.Session()
            inserted = 0
            for start in range(0, len(pending), args.batch_size):
                batch = pending[start : start + args.batch_size]
                embeddings = embed_batch(session, voyage_key, batch)
                rows = [
                    (content, vector_literal(embedding))
                    for content, embedding in zip(batch, embeddings)
                ]
                with connection.cursor() as cursor:
                    execute_values(
                        cursor,
                        """
                        INSERT INTO knowledge_base (content, embedding)
                        VALUES %s
                        """,
                        rows,
                        template="(%s, %s::vector)",
                        page_size=args.batch_size,
                    )
                connection.commit()
                inserted += len(rows)
                print(f"Inserted {inserted}/{len(pending)} new chunks.", flush=True)

        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM knowledge_base;")
            total_rows = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT count(*)
                FROM knowledge_base
                WHERE vector_dims(embedding) <> %s OR embedding IS NULL;
                """,
                (EMBEDDING_DIMENSION,),
            )
            invalid_rows = cursor.fetchone()[0]

    print(
        f"Done. knowledge_base contains {total_rows} rows; "
        f"invalid embeddings: {invalid_rows}."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
