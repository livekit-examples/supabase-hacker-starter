"""Shared pytest fixtures.

These tests run entirely offline against an in-memory fake Supabase client
(see `FakeSupabase` below), so the suite never requires a live database. The
fake implements the slice of the PostgREST/`supabase-py` query builder the
agent uses — `table().select()/insert()/upsert()/delete()` with `.eq()`,
`.order()`, `.limit()`, plus `.rpc()` for `match_knowledge` and
`match_memories_hybrid`.

Embeddings normally go through the `embed` Edge Function over HTTP. To keep
tests hermetic, `embed_text`/`embed_texts` are stubbed here with deterministic
384-dimensional fake vectors derived from the input text. The plumbing under
test (scope filters, slot upsert semantics, RPC shapes, preload context) is
identical regardless of where the vectors come from.
"""

import hashlib

import pytest
from dotenv import load_dotenv

from tools.embeddings import EMBEDDING_DIMENSIONS

load_dotenv(".env.local")

# A stable UUID standing in for the seeded demo user (= auth.uid()).
DEMO_USER_ID = "00000000-0000-0000-0000-000000000001"


def _fake_vector(text: str, dimensions: int = EMBEDDING_DIMENSIONS) -> list[float]:
    """Deterministic unit vector seeded by the input text."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    raw = [(b - 128) / 128.0 for b in (digest * (dimensions // 32 + 1))[:dimensions]]
    norm = sum(x * x for x in raw) ** 0.5 or 1.0
    return [x / norm for x in raw]


# --- In-memory fake Supabase client -------------------------------------------


class _Result:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _Query:
    def __init__(
        self, store, table, op, *, payload=None, on_conflict=None, cols="*"
    ) -> None:
        self._store = store
        self._table = table
        self._op = op
        self._payload = payload
        self._on_conflict = on_conflict
        self._cols = cols
        self._filters: list[tuple[str, object]] = []
        self._order: str | None = None
        self._desc = False
        self._limit: int | None = None

    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def order(self, col, desc=False):
        self._order = col
        self._desc = desc
        return self

    def limit(self, n):
        self._limit = n
        return self

    def _match(self, row) -> bool:
        return all(row.get(c) == v for c, v in self._filters)

    def _project(self, row) -> dict:
        if self._cols == "*":
            return dict(row)
        cols = [c.strip() for c in self._cols.split(",")]
        return {c: row.get(c) for c in cols}

    async def execute(self) -> _Result:
        rows = self._store.setdefault(self._table, [])
        if self._op == "select":
            out = [r for r in rows if self._match(r)]
            if self._order is not None:
                out.sort(key=lambda r: r.get(self._order) or "", reverse=self._desc)
            if self._limit is not None:
                out = out[: self._limit]
            return _Result([self._project(r) for r in out])
        if self._op == "insert":
            items = (
                self._payload if isinstance(self._payload, list) else [self._payload]
            )
            for p in items:
                rows.append(dict(p))
            return _Result([dict(p) for p in items])
        if self._op == "upsert":
            keys = [
                k.strip() for k in (self._on_conflict or "").split(",") if k.strip()
            ]
            items = (
                self._payload if isinstance(self._payload, list) else [self._payload]
            )
            result_rows = []
            for p in items:
                existing = None
                if keys:
                    for r in rows:
                        if all(r.get(k) == p.get(k) for k in keys):
                            existing = r
                            break
                if existing is not None:
                    existing.update(p)
                    result_rows.append(dict(existing))
                else:
                    new = dict(p)
                    rows.append(new)
                    result_rows.append(dict(new))
            return _Result(result_rows)
        if self._op == "delete":
            removed = [r for r in rows if self._match(r)]
            self._store[self._table] = [r for r in rows if not self._match(r)]
            return _Result([dict(r) for r in removed])
        raise NotImplementedError(self._op)


class _Rpc:
    def __init__(self, store, fn, params) -> None:
        self._store = store
        self._fn = fn
        self._params = params or {}

    async def execute(self) -> _Result:
        if self._fn == "match_knowledge":
            rows = self._store.get("knowledge", [])
            limit = self._params.get("match_count", 3)
            return _Result(
                [
                    {"title": r.get("title"), "content": r.get("content")}
                    for r in rows[:limit]
                ]
            )
        if self._fn == "match_memories_hybrid":
            uid = self._params.get("p_user_id")
            limit = self._params.get("match_count", 5)
            rows = [
                r for r in self._store.get("memories", []) if r.get("user_id") == uid
            ]
            return _Result(
                [
                    {
                        "memory_type": r.get("memory_type"),
                        "content": r.get("content"),
                    }
                    for r in rows[:limit]
                ]
            )
        raise NotImplementedError(self._fn)


class _Table:
    def __init__(self, store, name) -> None:
        self._store = store
        self._name = name

    def select(self, cols="*"):
        return _Query(self._store, self._name, "select", cols=cols)

    def insert(self, payload):
        return _Query(self._store, self._name, "insert", payload=payload)

    def upsert(self, payload, on_conflict=None):
        return _Query(
            self._store,
            self._name,
            "upsert",
            payload=payload,
            on_conflict=on_conflict,
        )

    def delete(self):
        return _Query(self._store, self._name, "delete")


class FakeSupabase:
    """Minimal in-memory stand-in for an async supabase-py client."""

    def __init__(self) -> None:
        self._store: dict[str, list[dict]] = {}

    def table(self, name):
        return _Table(self._store, name)

    def rpc(self, fn, params=None):
        return _Rpc(self._store, fn, params)


# --- Fixtures -----------------------------------------------------------------


@pytest.fixture(autouse=True)
def _stub_embeddings(monkeypatch):
    """Replace embed_text/embed_texts with deterministic fake vectors.

    We patch in every module that does `from tools.embeddings import ...`
    because Python binds those names at import time.
    """

    async def fake_embed_text(text):
        return _fake_vector(text)

    async def fake_embed_texts(texts):
        return [_fake_vector(t) for t in texts]

    for module_path in ("tools.embeddings", "tools.memory", "agent"):
        monkeypatch.setattr(f"{module_path}.embed_text", fake_embed_text, raising=False)
        monkeypatch.setattr(
            f"{module_path}.embed_texts", fake_embed_texts, raising=False
        )


@pytest.fixture
def seeded_client() -> FakeSupabase:
    """A fake client preloaded with a demo profile, order, and knowledge docs."""
    client = FakeSupabase()
    store = client._store
    store["profiles"] = [
        {
            "id": DEMO_USER_ID,
            "name": "Jordan",
            "email": "jordan@example.com",
            "preferences": {"language": "en"},
        }
    ]
    store["orders"] = [
        {
            "order_id": "order_1001",
            "user_id": DEMO_USER_ID,
            "items": ["Widget A", "Widget B"],
            "total": 49.99,
            "status": "delivered",
        }
    ]
    store["knowledge"] = [
        {
            "id": 1,
            "title": "RAG pattern",
            "content": "Inject vector search results into chat context.",
            "embedding": _fake_vector("RAG pattern"),
        },
        {
            "id": 2,
            "title": "Memory pattern",
            "content": "Use tools to remember and recall details.",
            "embedding": _fake_vector("Memory pattern"),
        },
    ]
    store["memories"] = []
    store["sessions"] = []
    return client


@pytest.fixture(autouse=True)
def _patch_get_client(monkeypatch, seeded_client: FakeSupabase):
    """Pin agent.get_client() to the per-test fake client."""

    async def _fake_get_client():
        return seeded_client

    monkeypatch.setattr("agent.get_client", _fake_get_client)
    monkeypatch.setattr("db.client.get_client", _fake_get_client, raising=False)
