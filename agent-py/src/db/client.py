"""Supabase async client (supabase-py AsyncClient).

A single AsyncClient is shared across the agent process. The agent connects
with the modern secret key (``sb_secret_...``), which bypasses Row Level
Security so it can read and write any row after the server has verified the
caller's identity. Every query in the agent is still scoped explicitly by
``user_id`` (= ``auth.uid()``); RLS is what protects the browser-side anon
client.

Call ``aclose()`` at shutdown to drop the shared client.
"""

import os

from supabase import AsyncClient, acreate_client

_client: AsyncClient | None = None


async def get_client() -> AsyncClient:
    """Return the shared secret-key Supabase client, creating it on first use."""
    global _client
    if _client is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SECRET_KEY")
        if not url:
            raise RuntimeError("SUPABASE_URL environment variable is not set.")
        if not key:
            raise RuntimeError("SUPABASE_SECRET_KEY environment variable is not set.")
        _client = await acreate_client(url, key)
    return _client


async def aclose() -> None:
    """Drop the shared client so a fresh one is built on next use."""
    global _client
    _client = None
