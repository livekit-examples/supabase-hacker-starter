"""LiveKit voice agent with Supabase integration.

Demonstrates five integration patterns:

1. RAG with pgvector                    -> search_knowledge tool (match_knowledge)
2. Agentic memory tools                 -> remember/recall/forget/search_memories
3. Identify + pre-load context          -> preload_user (entrypoint)
4. Function-tool CRUD                   -> @function_tool methods
5. Session report persistence           -> on_session_end
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    ChatContext,
    JobContext,
    JobProcess,
    RunContext,
    ToolError,
    TurnHandlingOptions,
    cli,
    function_tool,
    inference,
    room_io,
)
from livekit.plugins import ai_coustics, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel
from supabase import AsyncClient

from db.client import aclose, get_client
from tools.embeddings import embed_text
from tools.memory import forget, list_memories, recall, remember, search_memory

load_dotenv(".env.local")

logger = logging.getLogger("agent")

# Fallback identity used only when ctx.job.metadata is absent, e.g. when
# running `uv run src/agent.py console`. The frontend always provides a real
# per-browser user_id (= auth.uid()) via agent dispatch metadata. In console
# mode we fall back to the seeded demo user printed by the seed script.
DEFAULT_USER_ID = os.getenv("DEMO_USER_ID")

# Identity fields `update_profile` may write. `name`/`email` are first-class
# columns on `profiles`; `preferred_language`/`timezone` are nested keys in the
# `preferences` jsonb column. Anything outside this map belongs in `memories`.
_PROFILE_COLUMNS = {"name", "email"}
_PREFERENCE_KEYS = {
    "preferred_language": "language",
    "timezone": "timezone",
}
_PROFILE_FIELDS = _PROFILE_COLUMNS | set(_PREFERENCE_KEYS)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


async def _search_knowledge(
    client: AsyncClient, query: str, limit: int = 3
) -> list[dict]:
    """Run the shared knowledge vector search and return {title, content} rows."""
    query_embedding = await embed_text(query)
    resp = await client.rpc(
        "match_knowledge",
        {"query_embedding": query_embedding, "match_count": limit},
    ).execute()
    return resp.data or []


class VoiceAgent(Agent):
    """Voice agent that wires Supabase into the LiveKit pipeline."""

    def __init__(self, *, chat_ctx: ChatContext, user_id: str) -> None:
        super().__init__(
            chat_ctx=chat_ctx,
            instructions=(
                "You are a friendly voice assistant with Supabase-backed tools. "
                "The user is speaking to you, so reply in plain text without "
                "markdown, lists, or emojis. Keep replies short. "
                "Use lookup_order to retrieve order details by id. "
                "Use search_knowledge for any question about voice agents, "
                "Supabase, LiveKit, STT/LLM/TTS providers, session handling, "
                "or related topics you are not confident answering from "
                "prior context. Call it before answering; the tool itself "
                "keeps the user engaged while it runs. "
                "When the user tells you their name, email, preferred language, "
                "or timezone, call update_profile with the matching field so it "
                "persists in their profile. "
                "Use remember_detail for any other fact the user volunteers, "
                "under a short specific label like 'favorite_color', 'allergy', "
                "or 'preferred_pronouns'. Each label is a slot and writing a "
                "new value replaces the old one. Use recall_detail only when "
                "you know the exact label; otherwise call search_memories with "
                "a natural-language query. Use forget_detail to drop a slot and "
                "list_user_memories when the user asks what you remember."
            ),
        )
        self._user_id = user_id

    async def on_enter(self) -> None:
        await self.session.generate_reply(
            instructions=(
                "Greet the user by name if the loaded profile or remembered "
                "facts contain one. If no name is on file, briefly introduce "
                "yourself as a Supabase-backed voice assistant and ask the "
                "user for their name. When they tell you, call update_profile "
                "with field='name' so it persists for next time."
            )
        )

    @function_tool()
    async def lookup_order(self, context: RunContext, order_id: str) -> str:
        """Look up an order by its ID. Returns items, total, and status."""
        client = await get_client()
        resp = await (
            client.table("orders")
            .select("order_id, items, total, status")
            .eq("order_id", order_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            raise ToolError(f"Order {order_id} not found.")
        order = rows[0]
        return json.dumps(
            {
                "order_id": order["order_id"],
                "items": order["items"],
                "total": order["total"],
                "status": order["status"],
            }
        )

    @function_tool()
    async def search_knowledge(self, context: RunContext, query: str) -> str:
        """Search the shared knowledge base for facts the user asks about.

        Use when the user asks a question about voice agents, Supabase,
        LiveKit, STT/LLM/TTS providers, session handling, or anything
        else you are not confident answering from prior context. Returns
        a JSON object with a `results` array of `{title, content}`.
        """

        async def _speak_status_update(delay: float = 0.5) -> None:
            await asyncio.sleep(delay)
            await context.session.generate_reply(
                instructions=(
                    f"You are searching the knowledge base for '{query}' "
                    "but it is taking a moment. Give the user a brief, "
                    "one-sentence update that you are looking it up."
                )
            )

        status_task = asyncio.create_task(_speak_status_update(0.5))
        try:
            client = await get_client()
            results = await _search_knowledge(client, query, limit=3)
        finally:
            status_task.cancel()
        return json.dumps({"results": results})

    @function_tool()
    async def update_profile(self, context: RunContext, field: str, value: str) -> str:
        """Update an identity field on the user's profile.

        Use for name, email, preferred_language, or timezone. These are
        first-class profile fields stored on the `profiles` row and loaded
        at session start. For anything else, use remember_detail.
        """
        if field not in _PROFILE_FIELDS:
            raise ToolError(
                f"Unknown profile field '{field}'. Allowed: {sorted(_PROFILE_FIELDS)}"
            )
        client = await get_client()
        if field in _PROFILE_COLUMNS:
            payload = {"id": self._user_id, field: value}
        else:
            # Merge into the `preferences` jsonb column without clobbering
            # other keys: read the current value, set the one key, write back.
            resp = await (
                client.table("profiles")
                .select("preferences")
                .eq("id", self._user_id)
                .limit(1)
                .execute()
            )
            rows = resp.data or []
            prefs = (rows[0].get("preferences") if rows else None) or {}
            prefs[_PREFERENCE_KEYS[field]] = value
            payload = {"id": self._user_id, "preferences": prefs}
        await client.table("profiles").upsert(payload, on_conflict="id").execute()
        return f"Updated {field} to {value}."

    @function_tool()
    async def remember_detail(
        self, context: RunContext, memory_type: str, content: str
    ) -> str:
        """Store or replace a fact under memory_type.

        Use for preferences, allergies, pronouns, or anything the user
        volunteers. Pick a short specific label like 'favorite_color'
        rather than a generic one like 'preferences'.
        """
        client = await get_client()
        return await remember(client, self._user_id, memory_type, content)

    @function_tool()
    async def recall_detail(self, context: RunContext, memory_type: str) -> str:
        """Return the value stored under memory_type by exact label.

        Returns 'No memory found' when the label is not set. Prefer
        search_memories when you are unsure which label stores the fact.
        """
        client = await get_client()
        return await recall(client, self._user_id, memory_type)

    @function_tool()
    async def forget_detail(self, context: RunContext, memory_type: str) -> str:
        """Delete the value stored under memory_type."""
        client = await get_client()
        return await forget(client, self._user_id, memory_type)

    @function_tool()
    async def search_memories(self, context: RunContext, query: str) -> str:
        """Find memories by meaning using hybrid vector and text search.

        Use when you do not know the exact label or when pulling
        background context. Returns a list of {memory_type, content}
        objects so you can follow up with recall_detail or forget_detail.
        """
        client = await get_client()
        results = await search_memory(client, self._user_id, query, limit=3)
        return json.dumps({"results": results})

    @function_tool()
    async def list_user_memories(self, context: RunContext) -> str:
        """Return every slot stored for this user, newest first."""
        client = await get_client()
        results = await list_memories(client, self._user_id)
        return json.dumps(
            {
                "results": [
                    {"memory_type": r["memory_type"], "content": r["content"]}
                    for r in results
                ]
            }
        )


async def preload_user(user_id: str) -> ChatContext:
    """Pattern 3: load user data into the chat context before the session.

    Upserts the `profiles` row (stamping `last_seen_at`) so every connected
    user — including anonymous Supabase Auth visitors — has a stable profile,
    then appends any memory slots the agent has learned for this user in prior
    sessions. Both writes land as assistant messages so the LLM sees them
    before the first reply.
    """
    client = await get_client()
    resp = await (
        client.table("profiles")
        .upsert(
            {"id": user_id, "last_seen_at": _now_iso()},
            on_conflict="id",
        )
        .execute()
    )
    rows = resp.data or []
    user = rows[0] if rows else {}

    chat_ctx = ChatContext()
    name = user.get("name")
    email = user.get("email")
    prefs = user.get("preferences") or {}
    if name or email or prefs:
        chat_ctx.add_message(
            role="assistant",
            content=(
                f"User profile: name={name or 'unknown'}, "
                f"email={email or 'unknown'}, preferences={prefs}."
            ),
        )
    else:
        chat_ctx.add_message(
            role="assistant",
            content=(
                f"No stored profile fields yet for user_id {user_id}. "
                "Greet them as a new user, then ask for their name and "
                "call update_profile with field='name' so it persists."
            ),
        )
    if not name:
        chat_ctx.add_message(
            role="assistant",
            content=(
                "No name on file for this user. Ask them for their name "
                "and call update_profile with field='name' to save it."
            ),
        )

    memories = await list_memories(client, user_id)
    if memories:
        lines = "\n".join(f"- {m['memory_type']}: {m['content']}" for m in memories)
        chat_ctx.add_message(
            role="assistant",
            content=f"Remembered facts from prior sessions:\n{lines}",
        )
    return chat_ctx


async def on_session_end(ctx: JobContext) -> None:
    """Pattern 5: persist a session report to Supabase on hangup.

    Written with the secret key, which is the only path allowed to INSERT
    into `sessions` (the table has no insert policy for browser clients).
    """
    try:
        report = ctx.make_session_report()
        client = await get_client()
        user_id = ctx.proc.userdata.get("user_id", DEFAULT_USER_ID)
        await (
            client.table("sessions")
            .insert(
                {
                    "session_id": ctx.room.name,
                    "user_id": user_id,
                    "room_name": ctx.room.name,
                    "report": report.to_dict(),
                }
            )
            .execute()
        )
        logger.info("Persisted session report for %s", ctx.room.name)
    except Exception:
        logger.exception("Failed to persist session report")
    finally:
        await aclose()


server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session(agent_name="my-agent", on_session_end=on_session_end)
async def my_agent(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

    # Pattern 3 setup: identify the user from agent dispatch metadata.
    # The frontend packs {"user_id"} into ctx.job.metadata via
    # room_config.agents[0].metadata, where user_id is the server-verified
    # auth.uid(). Parsing here (before ctx.connect) keeps the preload network
    # call out of the connection critical path. See:
    # https://docs.livekit.io/agents/logic/external-data/
    meta: dict[str, str] = {}
    if ctx.job.metadata:
        try:
            meta = json.loads(ctx.job.metadata)
        except json.JSONDecodeError:
            logger.warning("ctx.job.metadata was not valid JSON; using defaults")

    user_id = meta.get("user_id", DEFAULT_USER_ID)
    ctx.proc.userdata["user_id"] = user_id

    initial_ctx = await preload_user(user_id)

    session = AgentSession(
        stt=inference.STT(model="deepgram/nova-3", language="multi"),
        llm=inference.LLM(model="openai/gpt-5.3-chat-latest"),
        tts=inference.TTS(
            model="cartesia/sonic-3", voice="9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
        ),
        vad=ctx.proc.userdata["vad"],
        turn_handling=TurnHandlingOptions(
            turn_detection=MultilingualModel(),
            preemptive_generation={"enabled": True},
        ),
    )

    await session.start(
        agent=VoiceAgent(chat_ctx=initial_ctx, user_id=user_id),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=ai_coustics.audio_enhancement(
                    model=ai_coustics.EnhancerModel.QUAIL_VF_L
                ),
            ),
        ),
    )

    await ctx.connect()


if __name__ == "__main__":
    cli.run_app(server)
