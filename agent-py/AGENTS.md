# AGENTS.md

This is a LiveKit Agents project. LiveKit Agents is a Python SDK for building voice AI agents. This project is intended to be used with LiveKit Cloud. See @README.md for more about the rest of the LiveKit ecosystem.

The following is a guide for working with this project.

## Project structure

This Python project uses the `uv` package manager. You should always use `uv` to install dependencies, run the agent, and run tests.

All app-level code is in the `src/` directory. The entrypoint is `src/agent.py` (the Dockerfile depends on this). Supabase-specific helpers are split into `src/db/` (the shared async client) and `src/tools/` (the embeddings helper and agentic memory tools).

Be sure to maintain code formatting. You can use the ruff formatter/linter as needed: `uv run ruff format` and `uv run ruff check`.

## Supabase integration

This agent integrates Supabase across five hooks:

| Pattern | Hook | File |
| --- | --- | --- |
| Pre-load user context | `entrypoint` -> `preload_user` | `src/agent.py` |
| Function-tool CRUD | `@function_tool lookup_order` | `src/agent.py` |
| RAG via pgvector (`match_knowledge`) | `@function_tool search_knowledge` | `src/agent.py` |
| Session report persistence | `on_session_end` | `src/agent.py` |
| Agentic memory tools | `@function_tool remember/recall/forget/search_memories` | `src/agent.py` + `src/tools/memory.py` |

The agent talks to Postgres through the async `supabase-py` client (`from supabase import acreate_client`). It connects with the **secret key** (`SUPABASE_SECRET_KEY`, a modern `sb_secret_...` key), which bypasses Row Level Security, so every read and write is scoped explicitly by the verified `user_id` (= `auth.uid()`). Table reads/writes go through PostgREST (`client.table(...)`); vector and hybrid retrieval go through Postgres functions called with `client.rpc(...)`:

- `match_knowledge(query_embedding, match_count)` — cosine similarity over `knowledge.embedding` (shared demo corpus, no user scoping).
- `match_memories_hybrid(query_embedding, query_text, p_user_id, match_count)` — Reciprocal Rank Fusion over a pgvector branch and a `tsvector` full-text branch, both filtered to `user_id = p_user_id`.

Embeddings go through the shared `embed` Supabase Edge Function (`gte-small`, 384 dimensions) via `src/tools/embeddings.py`, which POSTs `{ input }` and receives `{ embeddings }`. The function is deployed `verify_jwt=false` and authorizes the `apikey` header, so the helper sends `SUPABASE_SECRET_KEY` on the `apikey` header (plus a `Bearer` header for compatibility). If you change the model, update `EMBEDDING_DIMENSIONS` and the `vector(384)` columns in the SQL migrations so the dimensions match.

Database schema, RLS policies, RPC functions, and the `embed` Edge Function live under the repo-root `supabase/` directory so both runtimes share one source of truth. From the repo root run `pnpm db:migrate` to apply the SQL migrations, `pnpm db:deploy-functions` to deploy the `embed` function, and `pnpm db:seed` to load sample data (it prints a `DEMO_USER_ID`).

## Identity and scoping

The agent never decides who the user is. The Next.js token route verifies the Supabase session server-side, extracts `user_id = auth.uid()`, and packs `{ "user_id": "<uuid>" }` into the agent dispatch metadata. The agent parses `ctx.job.metadata`, scopes every query by that id, and falls back to the `DEMO_USER_ID` environment variable in console mode (no metadata). There is no tenant concept — scoping is purely by `user_id`.

## LiveKit Documentation

LiveKit Agents is a fast-evolving project, and the documentation is updated frequently. You should always refer to the latest documentation when working with this project. For your convenience, LiveKit offers both a CLI and an MCP server that can be used to browse and search its documentation. If the developer has not yet installed the CLI, you should recommend that they install it.

### LiveKit CLI

The [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) `lk docs` subcommand gives full access to LiveKit documentation from the terminal. Requires CLI version 2.15.0+. Check with `lk --version`.

Install or update the CLI:

- **macOS:** `brew install livekit-cli` (update: `brew update && brew upgrade livekit-cli`)
- **Linux:** `curl -sSL https://get.livekit.io/cli | bash`
- **Windows:** `winget install LiveKit.LiveKitCLI` (update: `winget upgrade LiveKit.LiveKitCLI`)

Run `lk docs --help` to see all available commands. Key commands: `lk docs overview`, `lk docs search`, `lk docs get-page`, `lk docs code-search`, `lk docs changelog`, `lk docs submit-feedback`. Run `lk docs <command> --help` before using a command for the first time, as the help text includes advice on usage and interpreting results. Prefer browsing (`overview`, `get-page`) over search, and prefer `search` over `code-search`, as docs pages are more up-to-date and provide better context than raw code.

### LiveKit Docs MCP Server

For deeper IDE integration, LiveKit also offers an [MCP server](https://docs.livekit.io/reference/developer-tools/docs-mcp/) with the same documentation access. It uses Streamable HTTP transport at `https://docs.livekit.io/mcp`. Refer to your IDE's documentation for how to add it.

### Submit docs feedback to LiveKit

If you use the LiveKit CLI or MCP Server to search or browse documentation, also submit constructive feedback to LiveKit with `lk docs submit-feedback` or the MCP `submit_docs_feedback` tool. Add this to your to-do list when planning work, to ensure you file feedback after completing your other tasks. Useful feedback includes incomplete documentation, broken examples, missing steps or any other documentation gap or issue.

## Handoffs and tasks ("workflows")

Voice AI agents are highly sensitive to excessive latency. For this reason, it's important to design complex agents in a structured manner that minimizes the amount of irrelevant context and unnecessary tools included in requests to the LLM. LiveKit Agents supports handoffs (one agent hands control to another) and tasks (tightly-scoped prompts to achieve a specific outcome) to support building reliable workflows. You should make use of these features, instead of writing long instruction prompts that cover multiple phases of a conversation.  Refer to the [documentation](https://docs.livekit.io/agents/build/workflows/) for more information.

## Testing

When possible, add tests for agent behavior. Read the [documentation](https://docs.livekit.io/agents/start/testing/), and refer to existing tests in the `tests/` directory.  Run tests with `uv run pytest`.

The test suite runs entirely offline against an in-memory fake Supabase client (`tests/conftest.py`), so it never requires a live database. Embeddings are stubbed with deterministic fake vectors. One test (`test_embed_edge_function_returns_correct_dimensions`) makes a real call to the deployed `embed` Edge Function and is skipped unless `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set.

Important: When modifying core agent behavior such as instructions, tool descriptions, and tasks/workflows/handoffs, never just guess what will work. Always use test-driven development (TDD) and begin by writing tests for the desired behavior. For instance, if you're planning to add a new tool, write one or more tests for the tool's behavior, then iterate on the tool until the tests pass correctly. This will ensure you are able to produce a working, reliable agent for the user.

## LiveKit CLI

Beyond documentation access, the LiveKit CLI (`lk`) supports other tasks such as managing SIP trunks for telephony-based agents. Run `lk --help` to explore available commands.
