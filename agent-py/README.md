# LiveKit + Supabase Voice Agent (Python)

> This is the **secondary** runtime. The primary, TypeScript-first runtime lives in [`../agent-ts`](../agent-ts). Both runtimes implement the same five patterns against the same Supabase schema.

A voice AI agent built on the [LiveKit Agents Python starter](https://github.com/livekit-examples/agent-starter-python) and wired into [Supabase](https://supabase.com) (Postgres + pgvector + Auth + Edge Functions) to demonstrate five integration patterns:

1. **Pre-load context at session start** — load the user profile from Supabase into the chat context before the agent speaks.
2. **Function-tool CRUD** — `@function_tool` methods that read and write Postgres rows through PostgREST.
3. **RAG with pgvector** — embed the user's question and call the `match_knowledge` Postgres function to pull the most relevant docs from a shared knowledge base.
4. **Session report persistence** — write the structured `SessionReport` to the `sessions` table (service role) inside `on_session_end`.
5. **Agentic memory tools** — `remember_detail`, `recall_detail`, `forget_detail`, `search_memories`, and `list_user_memories` tools backed by a per-user memory store. Memory is modeled as slots (one value per `(user_id, memory_type)` via a UNIQUE upsert), and retrieval uses the `match_memories_hybrid` function — Reciprocal Rank Fusion over a pgvector branch and a `tsvector` full-text branch.

The voice pipeline uses [LiveKit Inference](https://docs.livekit.io/agents/models/inference/) (Deepgram Nova-3 STT, GPT-5.3 LLM, Cartesia Sonic-3 TTS), the [LiveKit Turn Detector](https://docs.livekit.io/agents/logic/turns/turn-detector/), Silero VAD, and ai-coustics noise cancellation. Embeddings are produced by the shared `embed` Supabase Edge Function (`gte-small`, 384 dimensions). That function is deployed `verify_jwt=false` and authorizes the `apikey` header, so the agent sends `SUPABASE_SECRET_KEY` on the `apikey` header (a `Bearer` header is sent too for compatibility).

## What's in this directory

```
agent-py/
├── src/
│   ├── agent.py           # VoiceAgent + entrypoint + on_session_end
│   ├── db/
│   │   └── client.py      # supabase-py AsyncClient singleton (secret key)
│   └── tools/
│       ├── embeddings.py  # embed Edge Function helper (embed_text, embed_texts)
│       └── memory.py      # remember/recall/forget/search_memory/list_memories
├── tests/                 # offline integration tests (fake Supabase client)
├── pyproject.toml
└── Dockerfile
```

## Prerequisites

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- A Supabase project with the schema, RLS policies, RPC functions, and the `embed` Edge Function applied (see the repo-root `supabase/` directory and `db/`)
- Supabase **modern API keys** — the agent authenticates with the secret key (`sb_secret_...`); the browser uses the publishable key
- LiveKit Cloud project

## Setup

The fastest path is to bootstrap with the LiveKit CLI:

```bash
lk cloud auth
lk app create my-agent --template agent-starter-python
```

If you cloned this repo directly:

```bash
cd agent-py
uv sync
cp .env.example .env.local
# fill in LIVEKIT_*, SUPABASE_URL, SUPABASE_SECRET_KEY, DEMO_USER_ID
uv run src/agent.py download-files   # one-time: VAD + turn detector models
```

You can populate `LIVEKIT_*` with `lk app env -w -d .env.local` if you've authenticated with `lk cloud auth`.

## Initialize Supabase

The database schema and the `embed` Edge Function live at the repo root so they're shared with the TypeScript sibling. From the repo root, after pointing the helpers at your Supabase project:

```bash
pnpm db:migrate            # apply SQL migrations (schema, RLS, RPC, triggers, indexes)
pnpm db:deploy-functions   # deploy the gte-small `embed` Edge Function
pnpm db:seed               # load sample data and print DEMO_USER_ID
```

Copy the `DEMO_USER_ID` printed by the seed step into `.env.local` so console mode resolves the seeded demo profile.

## Run the agent

```bash
uv run src/agent.py console     # speak to it in your terminal
uv run src/agent.py dev         # run for use with a frontend
uv run src/agent.py start       # production mode
```

## Tests

```bash
uv run pytest
```

The integration tests run entirely offline against an in-memory fake Supabase client, exercising all five patterns without a live database. Embeddings are stubbed with deterministic fake vectors. One test (`test_embed_edge_function_returns_correct_dimensions`) makes a real call to the deployed `embed` Edge Function and is skipped unless `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set.

## Frontend

The companion React frontend (built from [`agent-starter-react`](https://github.com/livekit-examples/agent-starter-react)) lives in `../frontend`. To wire it up:

```bash
cd ../frontend
pnpm install
pnpm dev
```

Both apps share the same LiveKit credentials. The frontend dispatches to the agent registered as `my-agent`. To use a different name, update `agent_name="my-agent"` in `src/agent.py` and `AGENT_NAME` in `../frontend/.env.local`.

## Who is the user?

Every Supabase read and write in the agent is scoped by `user_id` (= `auth.uid()`). The browser uses Supabase Auth anonymous sign-ins; the Next.js token route verifies that session server-side, extracts the verified `user_id`, and stamps it onto [agent dispatch metadata](https://docs.livekit.io/agents/server/agent-dispatch/). LiveKit forwards the metadata string to `ctx.job.metadata`:

```python
meta = json.loads(ctx.job.metadata) if ctx.job.metadata else {}
user_id = meta.get("user_id", DEFAULT_USER_ID)
```

`my_agent` parses the metadata before `ctx.connect()` so `preload_user` runs in parallel with the room connection. See the LiveKit [external data guide](https://docs.livekit.io/agents/logic/external-data/) for why this ordering matters.

The agent connects with the **secret key** (`SUPABASE_SECRET_KEY`, an `sb_secret_...` value), which bypasses Row Level Security, so it must scope every query by the verified `user_id` itself. RLS is what protects the browser-side anon client. The resolved id is also stashed on `ctx.proc.userdata` so `on_session_end` can write the session report under the correct user.

Console mode (`uv run src/agent.py console`) has no frontend, so `user_id` falls back to the `DEMO_USER_ID` environment variable and the seeded demo profile.

## Table layout

| Table | Purpose | Notes |
| --- | --- | --- |
| `profiles` | User profiles loaded at session start | PK `id` = `auth.users(id)`; owner-only RLS; auto-created by a signup trigger |
| `orders` | Sample CRUD target for `lookup_order` | shared demo data (RLS SELECT for authenticated), looked up by `order_id` |
| `knowledge` | RAG corpus | `vector(384)` embedding, HNSW cosine index; shared demo data |
| `memories` | Agentic memory store | `UNIQUE(user_id, memory_type)`; HNSW vector index + GIN `fts` index; owner-only RLS |
| `sessions` | Session reports written by `on_session_end` | `session_id` unique; INSERT only via service role |

## Customizing for your domain

This is intentionally minimal. To adapt it:

- Swap `profiles`/`orders`/`knowledge` for your own tables in the `supabase/migrations` SQL and the `db/` seed.
- Add or remove `@function_tool` methods on `VoiceAgent` in `src/agent.py`.
- Adjust the agent's `instructions` to match your domain.
- Change the embedding model in the `embed` Edge Function and update `EMBEDDING_DIMENSIONS` in `src/tools/embeddings.py` plus the `vector(384)` columns in the migrations to match.

## License

MIT
