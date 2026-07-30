#!/usr/bin/env python3
"""Create and verify the match_documents function in Neon."""

from pathlib import Path

from ingest_knowledge_base import load_credentials
import psycopg2


CREATE_FUNCTION_SQL = """
CREATE OR REPLACE FUNCTION match_documents (
    query_embedding vector(1024),
    match_threshold float,
    match_count int
)
RETURNS TABLE (
    id bigint,
    content text,
    similarity float
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        id,
        content,
        1 - (embedding <=> query_embedding) AS similarity
    FROM knowledge_base
    WHERE 1 - (embedding <=> query_embedding) > match_threshold
    ORDER BY similarity DESC
    LIMIT match_count;
$$;
"""


def main() -> None:
    _, database_url = load_credentials(Path("keys.txt"))

    with psycopg2.connect(database_url, connect_timeout=20) as connection:
        with connection.cursor() as cursor:
            cursor.execute(CREATE_FUNCTION_SQL)
        connection.commit()

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    pg_get_function_identity_arguments(p.oid),
                    pg_get_function_result(p.oid),
                    p.provolatile
                FROM pg_proc AS p
                JOIN pg_namespace AS n ON n.oid = p.pronamespace
                WHERE n.nspname = current_schema()
                  AND p.proname = 'match_documents';
                """
            )
            rows = cursor.fetchall()

    if len(rows) != 1:
        raise RuntimeError(
            f"Expected exactly one match_documents function, found {len(rows)}."
        )

    arguments, result, volatility = rows[0]
    print(f"created=yes arguments={arguments}")
    print(f"result={result}")
    print(f"stable={volatility == 's'}")


if __name__ == "__main__":
    main()
