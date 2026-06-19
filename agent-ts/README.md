# LiveKit + Supabase Voice Agent (Node.js)

A voice AI agent built on the [LiveKit Agents Node.js starter](https://github.com/livekit-examples/agent-starter-node) and wired into [Supabase](https://supabase.com) (Postgres + pgvector + Auth + Edge Functions) to demonstrate five integration patterns:

1. **RAG over pgvector** — embed the user's question and run the `match_knowledge` RPC (cosine similarity over a pgvector index), then inject the top hits into the chat context. Exposed as the `search_knowledge` tool.
2. **Agentic memory tools** — `remember_detail`, `recall_detail`, `forget_detail`, `search_memories`, and `list_user_memories`, backed by a per-user memory store. Memory is modeled as slots (`UNIQUE(user_id, memory_type)`, upserted via `ON CONFLICT`), and retrieval uses the `match_memories_hybrid` RPC, which fuses pgvector cosine similarity and Postgres full-text search with Reciprocal Rank Fusion.
3. **Pre-load context at session start** — load the user's `profiles` row into the chat context before the agent speaks, and stamp `last_seen_at`.
4. **Function-tool CRUD** — `lookup_order` reads the shared `orders` table by `order_id`.
5. **Session report persistence** — write the structured `SessionReport` to the `sessions` table inside `addShutdownCallback`, using the secret key.

The voice pipeline uses [LiveKit Inference](https://docs.livekit.io/agents/models/inference/) (Deepgram Nova-3 STT, GPT-5.3 LLM, Cartesia Sonic-3 TTS), the [LiveKit Turn Detector](https://docs.livekit.io/agents/logic/turns/turn-detector/), Silero VAD, and ai-coustics noise cancellation. Embeddings come from a shared Supabase [Edge Function](https://supabase.com/docs/guides/functions) (`embed`) running the `gte-small` model (384 dimensions).

> This Node.js (TypeScript) agent is the **primary** runtime for this starter. A Python sibling lives at [`../agent-py`](../agent-py) and registers under the same agent name.

## What's in this directory

```
agent-ts/
├── src/
│   ├── main.ts            # defineAgent + prewarm + entry + cli.runApp
│   ├── agent.ts           # VoiceAgent class + 8 tools
│   ├── preload.ts         # Pattern 3: profile + memory pre-load
│   ├── db/
│   │   └── client.ts      # Supabase secret-key client singleton
│   └── tools/
│       ├── embeddings.ts  # embed Edge Function helper (embedText, embedTexts)
│       └── memory.ts      # remember/recall/forget/searchMemory/listMemories
├── tests/                 # offline vitest suite + live embed smoke test
├── package.json
└── Dockerfile
```

The database schema, RLS policies, RPCs, and the `embed` Edge Function live under [`../supabase`](../supabase); seed/migration helpers live under [`../db`](../db).

## Prerequisites

- Node 22+ and [pnpm](https://pnpm.io/) 10+
- LiveKit Cloud project
- A Supabase project with the `vector` extension enabled, the schema applied (see [`../supabase/migrations`](../supabase/migrations)), and the `embed` Edge Function deployed

## Setup

The fastest path is to bootstrap with the LiveKit CLI:

```bash
lk cloud auth
lk app create my-agent --template agent-starter-node
```

If you cloned this repo directly:

```bash
cd agent-ts
pnpm install
cp .env.example .env.local
# fill in LIVEKIT_*, SUPABASE_URL, SUPABASE_SECRET_KEY, DEMO_USER_ID in .env.local
pnpm download-files   # one-time: VAD + turn detector models
```

You can populate `LIVEKIT_*` with `lk app env -w -d .env.local` if you've authenticated with `lk cloud auth`.

### Environment variables

| Variable                                               | Purpose                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit Cloud credentials                                                                                   |
| `SUPABASE_URL`                                         | Your Supabase project URL                                                                                   |
| `SUPABASE_SECRET_KEY`                                  | Supabase secret key (`sb_secret_...`), server-only — the agent runs server-side and bypasses RLS. The browser/frontend uses the publishable key (`sb_publishable_...`) and is constrained by RLS. |
| `DEMO_USER_ID`                                         | UUID of the seeded demo user, used as the fallback when there is no dispatch metadata (e.g. local dev runs) |

## Initialize Supabase

From the repo root, after configuring your Supabase credentials:

```bash
pnpm db:migrate          # apply schema, RLS, RPCs, indexes, triggers
pnpm db:deploy-functions # deploy the gte-small `embed` Edge Function
pnpm db:seed             # create the demo user, profile, knowledge docs, and orders
```

`pnpm db:seed` prints the demo user's UUID — copy it into `DEMO_USER_ID` in `.env.local` so local runs exercise the preload path.

## Run the agent

```bash
pnpm dev     # development mode (rebuilds, runs `node dist/main.js dev`)
pnpm start   # production mode (assumes `pnpm build` already ran)
```

### Testing locally with the Agent Console

To test this Node agent locally, run it in **dev mode** and interact with it from the [LiveKit Agent Console](https://docs.livekit.io/agents/start/voice-ai/#connect-to-agent-console) in your browser:

```bash
pnpm dev
```

Then, in the LiveKit Cloud **Agents** dashboard, click **Launch Console**, set the Agent name to `my-agent`, and talk to the agent in the browser. The Agent Console connects to your locally-running agent (it requires the Node SDK `>=1.2.4`; this starter uses 1.4.5), so there is nothing else to deploy. The bundled [`../frontend`](../frontend) is the other way to talk to the agent locally.

## Tests

```bash
pnpm test
```

The suite runs fully offline: the agent code is exercised against an in-memory fake Supabase client that emulates the Canonical Contract (table ops + `match_knowledge` / `match_memories_hybrid` RPCs), and embeddings are stubbed with deterministic vectors. One optional test (`embed_returns_correct_dimensions` in `tests/embed.test.ts`) calls the real `embed` Edge Function to verify dimensions; it skips unless `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set.

## Frontend

The companion React frontend (built from [`agent-starter-react`](https://github.com/livekit-examples/agent-starter-react)) lives in [`../frontend`](../frontend). To wire it up:

```bash
cd ../frontend
pnpm install
pnpm dev
```

Both apps share the same LiveKit credentials. The frontend dispatches to whichever agent registers under `AGENT_NAME` (default `my-agent`). This Node agent and the Python sibling at `../agent-py` both register under `my-agent`, so **only run one of them at a time**. Either:

- Stop the Python `uv run src/agent.py dev` process before running `pnpm dev` here, or
- Change `agentName: "my-agent"` in `src/main.ts` and `AGENT_NAME` in `../frontend/.env.local` to a different name to run them side by side.

## Who is the user?

Every Supabase read and write in the agent is scoped by `user_id` (= `auth.uid()`). The Next.js token route verifies the Supabase session server-side, extracts the verified user id, and stamps it onto [agent dispatch metadata](https://docs.livekit.io/agents/server/agent-dispatch/). LiveKit forwards the metadata string to `ctx.job.metadata`:

```ts
const meta = ctx.job.metadata ? JSON.parse(ctx.job.metadata) : {};
const userId = meta.user_id ?? process.env.DEMO_USER_ID;
```

`main.ts` resolves the id before `ctx.connect()` so `preloadUser` runs in parallel with the room connection. See the LiveKit [external data guide](https://docs.livekit.io/agents/logic/external-data/) for why this ordering matters. The resolved id is also stashed on `ctx.proc.userData` so the shutdown callback writes the session report under the correct user.

The agent uses the **secret key** (`sb_secret_...`) and so bypasses row-level security; the browser uses the **publishable key** (`sb_publishable_...`) and is constrained by RLS. The server (token route) is the sole authority for identity.

## Table layout

| Table       | Purpose                                          | Notes                                                                        |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `profiles`  | User profiles loaded at session start            | `id` = `auth.users.id`; owner-only RLS; auto-created on signup               |
| `orders`    | Shared CRUD target for `lookup_order`            | RLS `SELECT` for authenticated; looked up by `order_id`                      |
| `knowledge` | RAG corpus                                       | `embedding vector(384)`, HNSW cosine index; `match_knowledge` RPC            |
| `memories`  | Agentic memory store                             | `UNIQUE(user_id, memory_type)`; HNSW + GIN(fts); `match_memories_hybrid` RPC |
| `sessions`  | Session reports written by the shutdown callback | owner-only `SELECT`; INSERT only via the secret key                          |

## Customizing for your domain

This is intentionally minimal. To adapt it:

- Edit the schema, RLS, and RPCs under `../supabase/migrations`, and the seed values under `../db`.
- Add or remove `llm.tool` definitions on `VoiceAgent` in `src/agent.ts`.
- Adjust the agent's `instructions` constant to match your domain.
- To change the embedding model, update the `embed` Edge Function and `EMBEDDING_DIMENSIONS` in `src/tools/embeddings.ts`, then update the `vector(N)` columns and indexes in the migrations to match.

## License

MIT
