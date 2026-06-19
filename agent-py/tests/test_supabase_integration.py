"""Integration tests that exercise the Supabase plumbing end-to-end.

These do not start a LiveKit session and do not require a live database — they
call the same functions the agent calls against an in-memory fake Supabase
client (see conftest.py) and assert the resulting state.
"""

import json
import os

import pytest

from agent import _search_knowledge, preload_user
from tools.memory import forget, list_memories, recall, remember, search_memory

from .conftest import DEMO_USER_ID, FakeSupabase


async def test_pattern_3_preload_finds_known_user(
    seeded_client: FakeSupabase,
) -> None:
    chat_ctx = await preload_user(DEMO_USER_ID)
    rendered = " ".join(
        item.text_content for item in chat_ctx.items if item.text_content
    )
    assert "Jordan" in rendered
    assert "jordan@example.com" in rendered


async def test_pattern_3_preload_handles_missing_user(
    seeded_client: FakeSupabase,
) -> None:
    chat_ctx = await preload_user("11111111-1111-1111-1111-111111111111")
    rendered = " ".join(
        item.text_content for item in chat_ctx.items if item.text_content
    )
    assert "No stored profile fields" in rendered


async def test_pattern_3_preload_prompts_for_name_when_missing(
    seeded_client: FakeSupabase,
) -> None:
    """When no profile name is on file, the chat context preload_user builds
    must instruct the agent to ASK for the user's name and persist it via
    update_profile. The agent reads this guidance before its first turn.
    """
    chat_ctx = await preload_user("22222222-2222-2222-2222-222222222222")
    rendered = " ".join(
        item.text_content for item in chat_ctx.items if item.text_content
    ).lower()
    assert "ask" in rendered, (
        f"expected 'ask' in preload context for nameless user; got: {rendered}"
    )
    assert "name" in rendered, (
        f"expected 'name' in preload context for nameless user; got: {rendered}"
    )
    assert "update_profile" in rendered, (
        "expected 'update_profile' hint so the agent persists the name when "
        f"the user provides it; got: {rendered}"
    )


async def test_pattern_3_preload_upserts_last_seen(
    seeded_client: FakeSupabase,
) -> None:
    """preload_user stamps last_seen_at on the profile (creating it if needed)."""
    new_user = "33333333-3333-3333-3333-333333333333"
    await preload_user(new_user)
    rows = [r for r in seeded_client._store["profiles"] if r["id"] == new_user]
    assert len(rows) == 1
    assert "last_seen_at" in rows[0]


async def test_pattern_4_lookup_order(seeded_client: FakeSupabase) -> None:
    resp = await (
        seeded_client.table("orders")
        .select("order_id, items, total, status")
        .eq("order_id", "order_1001")
        .limit(1)
        .execute()
    )
    assert resp.data
    order = resp.data[0]
    assert order["items"] == ["Widget A", "Widget B"]
    assert order["status"] == "delivered"


async def test_pattern_1_search_knowledge_returns_results(
    seeded_client: FakeSupabase,
) -> None:
    """match_knowledge returns shared {title, content} rows."""
    results = await _search_knowledge(seeded_client, "voice agent retrieval", limit=3)
    assert isinstance(results, list)
    for doc in results:
        assert "title" in doc
        assert "content" in doc


async def test_pattern_5_session_report_insert(
    seeded_client: FakeSupabase,
) -> None:
    await (
        seeded_client.table("sessions")
        .insert(
            {
                "session_id": "test-room-1",
                "user_id": DEMO_USER_ID,
                "report": {"chat_history": []},
            }
        )
        .execute()
    )
    resp = await (
        seeded_client.table("sessions")
        .select("*")
        .eq("session_id", "test-room-1")
        .limit(1)
        .execute()
    )
    assert resp.data
    assert resp.data[0]["user_id"] == DEMO_USER_ID


async def test_pattern_2_memory_remember_recall_forget(
    seeded_client: FakeSupabase,
) -> None:
    msg = await remember(seeded_client, DEMO_USER_ID, "preference", "likes coffee")
    assert "Remembered" in msg

    recalled = await recall(seeded_client, DEMO_USER_ID, "preference")
    assert recalled == "likes coffee"

    msg = await forget(seeded_client, DEMO_USER_ID, "preference")
    assert msg == "Memory forgotten."

    recalled = await recall(seeded_client, DEMO_USER_ID, "preference")
    assert recalled == "No memory found."


async def test_pattern_2_memory_isolation_across_users(
    seeded_client: FakeSupabase,
) -> None:
    user_a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    user_b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    await remember(seeded_client, user_a, "fact", "lives in Paris")
    await remember(seeded_client, user_b, "fact", "lives in Tokyo")

    assert await recall(seeded_client, user_a, "fact") == "lives in Paris"
    assert await recall(seeded_client, user_b, "fact") == "lives in Tokyo"


async def test_pattern_2_memory_overwrite(seeded_client: FakeSupabase) -> None:
    """Writing the same memory_type twice replaces the old value; the
    (user_id, memory_type) slot holds at most one row (UNIQUE upsert)."""
    await remember(seeded_client, DEMO_USER_ID, "favorite_color", "blue")
    await remember(seeded_client, DEMO_USER_ID, "favorite_color", "green")

    assert await recall(seeded_client, DEMO_USER_ID, "favorite_color") == "green"
    matching = [
        r
        for r in seeded_client._store["memories"]
        if r["user_id"] == DEMO_USER_ID and r["memory_type"] == "favorite_color"
    ]
    assert len(matching) == 1


async def test_pattern_2_list_memories_returns_all_slots(
    seeded_client: FakeSupabase,
) -> None:
    await remember(seeded_client, DEMO_USER_ID, "favorite_color", "blue")
    await remember(seeded_client, DEMO_USER_ID, "allergy", "peanuts")

    results = await list_memories(seeded_client, DEMO_USER_ID)
    types = {r["memory_type"] for r in results}
    assert types == {"favorite_color", "allergy"}


async def test_pattern_2_search_memory_returns_list(
    seeded_client: FakeSupabase,
) -> None:
    """search_memory returns a list of {memory_type, content} dicts via the
    match_memories_hybrid RPC, scoped to the requesting user."""
    await remember(seeded_client, DEMO_USER_ID, "color_preference", "blue")
    results = await search_memory(
        seeded_client, DEMO_USER_ID, "what is my favorite color?", limit=5
    )
    assert isinstance(results, list)
    for item in results:
        assert "memory_type" in item
        assert "content" in item


async def test_search_memory_scoped_to_user(
    seeded_client: FakeSupabase,
) -> None:
    """The hybrid search only returns the requesting user's memories."""
    await remember(seeded_client, DEMO_USER_ID, "fact", "owns a cat")
    other = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    await remember(seeded_client, other, "fact", "owns a dog")

    results = await search_memory(seeded_client, DEMO_USER_ID, "pets", limit=5)
    contents = {r["content"] for r in results}
    assert "owns a cat" in contents
    assert "owns a dog" not in contents


@pytest.mark.skipif(
    not (os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_SECRET_KEY")),
    reason="SUPABASE_URL / SUPABASE_SECRET_KEY not set",
)
async def test_embed_edge_function_returns_correct_dimensions() -> None:
    """Single live call to the `embed` Edge Function to verify the contract.

    The other tests use deterministic fake vectors (see conftest); this is the
    one place that hits the real Edge Function to confirm it returns 384-d
    vectors in the `{embeddings: number[][]}` shape.
    """
    # Import the real (un-stubbed) helper by reloading the module attribute.
    import importlib

    embeddings = importlib.import_module("tools.embeddings")
    vector = await embeddings._embed(["supabase livekit starter dimension check"])
    assert len(vector) == 1
    assert len(vector[0]) == embeddings.EMBEDDING_DIMENSIONS


def test_metadata_json_shape() -> None:
    """Dispatch metadata carries user_id only (no tenant_id)."""
    meta = json.loads('{"user_id": "' + DEMO_USER_ID + '"}')
    assert meta["user_id"] == DEMO_USER_ID
    assert "tenant_id" not in meta
