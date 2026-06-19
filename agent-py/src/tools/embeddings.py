"""Text-embedding helper backed by the shared `embed` Supabase Edge Function.

Embeddings are produced by the `gte-small` model (384 dimensions) running
inside `supabase/functions/embed`. The agent never loads a model locally; it
POSTs text to the Edge Function, which keeps both runtimes (TypeScript and
Python) on a single, identical embedding path.

The vector columns in the database (`knowledge.embedding`, `memories.embedding`)
are declared `vector(384)`, so EMBEDDING_DIMENSIONS must match the model.
"""

import os

import httpx

# gte-small, as produced by `Supabase.ai.Session('gte-small')` in the
# `embed` Edge Function.
EMBEDDING_DIMENSIONS = 384

_DEFAULT_TIMEOUT = 30.0


def _embed_endpoint() -> tuple[str, str]:
    """Return (url, secret_key) for the `embed` Edge Function."""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY")
    if not url:
        raise RuntimeError("SUPABASE_URL environment variable is not set.")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY environment variable is not set.")
    return f"{url.rstrip('/')}/functions/v1/embed", key


async def _embed(inputs: list[str]) -> list[list[float]]:
    """POST inputs to the `embed` Edge Function and return one vector each.

    The Edge Function contract is `{ input: string | string[] }` in and
    `{ embeddings: number[][] }` out (always array-of-arrays, one row per
    input), so this helper is the single place that speaks HTTP to it.
    """
    endpoint, key = _embed_endpoint()
    async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as http:
        resp = await http.post(
            endpoint,
            json={"input": inputs},
            headers={
                # The `embed` function is deployed verify_jwt=false and
                # authorizes the `apikey` header. We send the modern secret
                # key there; the Bearer header is kept for compatibility.
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        return resp.json()["embeddings"]


async def embed_text(text: str) -> list[float]:
    """Return a 384-dimensional embedding for a single text."""
    embeddings = await _embed([text])
    return embeddings[0]


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Batch-embed a list of texts (one HTTP round-trip)."""
    return await _embed(texts)
