// LiveKit voice agent with Supabase integration.
//
// Demonstrates five integration patterns:
//   1. RAG over pgvector                   -> search_knowledge tool (match_knowledge RPC)
//   2. Agentic memory tools                -> remember/recall/forget/search_memories
//   3. Identify + pre-load context         -> preload_user (entrypoint)
//   4. Function-tool CRUD                  -> lookup_order against the orders table
//   5. Session report persistence          -> shutdown callback (see main.ts)
import { llm, voice } from '@livekit/agents';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from './db/client';
import { embedText } from './tools/embeddings';
import { forget, listMemories, recall, remember, searchMemory } from './tools/memory';

// Allow-list for identity fields that `update_profile` can write to the
// `profiles` row. `name` and `email` are first-class columns; the rest are
// merged into the `preferences` jsonb under the given key. Anything outside
// this map belongs in `memories`.
type ProfileTarget =
  | { kind: 'column'; column: 'name' | 'email' }
  | { kind: 'preference'; key: string };

const PROFILE_FIELDS: Record<string, ProfileTarget> = {
  name: { kind: 'column', column: 'name' },
  email: { kind: 'column', column: 'email' },
  preferred_language: { kind: 'preference', key: 'language' },
  timezone: { kind: 'preference', key: 'timezone' },
};

const INSTRUCTIONS =
  'You are a friendly voice assistant with Supabase-backed tools. ' +
  'The user is speaking to you, so reply in plain text without ' +
  'markdown, lists, or emojis. Keep replies short. ' +
  'Use lookup_order to retrieve order details by id. ' +
  'Use search_knowledge for any question about voice agents, ' +
  'Supabase, LiveKit, STT/LLM/TTS providers, session handling, ' +
  'or related topics you are not confident answering from ' +
  'prior context. Call it before answering; the tool itself ' +
  'keeps the user engaged while it runs. ' +
  'When the user tells you their name, email, preferred language, ' +
  'or timezone, call update_profile with the matching field so it ' +
  'persists in their profile. ' +
  'Use remember_detail for any other fact the user volunteers, ' +
  "under a short specific label like 'favorite_color', 'allergy', " +
  "or 'preferred_pronouns'. Each label is a slot and writing a " +
  'new value replaces the old one. Use recall_detail only when ' +
  'you know the exact label; otherwise call search_memories with ' +
  'a natural-language query. Use forget_detail to drop a slot and ' +
  'list_user_memories when the user asks what you remember.';

interface KnowledgeHit {
  title: string;
  content: string;
}

/** Pattern 1: embed the query and run the pgvector RAG RPC. */
export async function vectorSearchKnowledge(
  supabase: SupabaseClient,
  query: string,
  limit = 3,
): Promise<KnowledgeHit[]> {
  const queryEmbedding = await embedText(query);
  const { data, error } = await supabase.rpc('match_knowledge', {
    query_embedding: queryEmbedding,
    match_count: limit,
  });
  if (error) {
    throw new Error(`Knowledge search failed: ${error.message}`);
  }
  return (data ?? []) as KnowledgeHit[];
}

async function updateProfileField(
  supabase: SupabaseClient,
  userId: string,
  field: string,
  value: string,
): Promise<void> {
  const target = PROFILE_FIELDS[field];
  if (!target) {
    const allowed = Object.keys(PROFILE_FIELDS).sort();
    throw new llm.ToolError(
      `Unknown profile field '${field}'. Allowed: ${JSON.stringify(allowed)}`,
    );
  }
  const now = new Date().toISOString();

  if (target.kind === 'column') {
    const { error } = await supabase
      .from('profiles')
      .upsert({ id: userId, [target.column]: value, updated_at: now }, { onConflict: 'id' });
    if (error) {
      throw new llm.ToolError(`Failed to update ${field}: ${error.message}`);
    }
    return;
  }

  // Preference fields require a read-merge-write so we don't clobber sibling
  // keys already stored in the preferences jsonb.
  const { data: existing, error: readErr } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', userId)
    .maybeSingle();
  if (readErr) {
    throw new llm.ToolError(`Failed to read profile: ${readErr.message}`);
  }
  const preferences = {
    ...((existing?.preferences as Record<string, unknown> | null) ?? {}),
    [target.key]: value,
  };
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: userId, preferences, updated_at: now }, { onConflict: 'id' });
  if (error) {
    throw new llm.ToolError(`Failed to update ${field}: ${error.message}`);
  }
}

export interface VoiceAgentOptions {
  chatCtx: llm.ChatContext;
  userId: string;
}

export class VoiceAgent extends voice.Agent {
  constructor(opts: VoiceAgentOptions) {
    const { chatCtx, userId } = opts;
    super({
      chatCtx,
      instructions: INSTRUCTIONS,
      tools: VoiceAgent.buildTools(userId),
    });
  }

  private static buildTools(userId: string) {
    return {
      lookup_order: llm.tool({
        description: 'Look up an order by its ID. Returns items, total, and status.',
        parameters: z.object({
          order_id: z.string().describe('The order ID to look up.'),
        }),
        execute: async ({ order_id }) => {
          const supabase = getSupabase();
          const { data: order, error } = await supabase
            .from('orders')
            .select('order_id, items, total, status')
            .eq('order_id', order_id)
            .maybeSingle();
          if (error) {
            throw new llm.ToolError(`Failed to look up order ${order_id}: ${error.message}`);
          }
          if (!order) {
            throw new llm.ToolError(`Order ${order_id} not found.`);
          }
          return JSON.stringify({
            order_id: order.order_id,
            items: order.items,
            total: order.total,
            status: order.status,
          });
        },
      }),

      search_knowledge: llm.tool({
        description:
          'Search the shared knowledge base for facts the user asks about. ' +
          'Use when the user asks a question about voice agents, Supabase, ' +
          'LiveKit, STT/LLM/TTS providers, session handling, or anything ' +
          'else you are not confident answering from prior context. Returns ' +
          'a JSON object with a `results` array of `{title, content}`.',
        parameters: z.object({
          query: z.string().describe('Natural-language question to search the knowledge base for.'),
        }),
        execute: async ({ query }, { ctx }) => {
          let statusTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
            ctx.session.generateReply({
              instructions:
                `You are searching the knowledge base for '${query}' ` +
                'but it is taking a moment. Give the user a brief, ' +
                'one-sentence update that you are looking it up.',
            });
          }, 500);
          try {
            const supabase = getSupabase();
            const results = await vectorSearchKnowledge(supabase, query, 3);
            return JSON.stringify({ results });
          } finally {
            if (statusTimer) {
              clearTimeout(statusTimer);
              statusTimer = undefined;
            }
          }
        },
      }),

      update_profile: llm.tool({
        description:
          "Update an identity field on the user's profile. Use for name, " +
          'email, preferred_language, or timezone. These are first-class ' +
          'profile fields stored on the `profiles` row and loaded at ' +
          'session start. For anything else, use remember_detail.',
        parameters: z.object({
          field: z.string().describe('One of name, email, preferred_language, timezone.'),
          value: z.string().describe('The value to store.'),
        }),
        execute: async ({ field, value }) => {
          const supabase = getSupabase();
          await updateProfileField(supabase, userId, field, value);
          return `Updated ${field} to ${value}.`;
        },
      }),

      remember_detail: llm.tool({
        description:
          'Store or replace a fact under memory_type. Use for preferences, ' +
          'allergies, pronouns, or anything the user volunteers. Pick a ' +
          "short specific label like 'favorite_color' rather than a generic " +
          "one like 'preferences'.",
        parameters: z.object({
          memory_type: z.string().describe('Short label slot, e.g. favorite_color.'),
          content: z.string().describe('The value to remember.'),
        }),
        execute: async ({ memory_type, content }) => {
          const supabase = getSupabase();
          return remember(supabase, userId, memory_type, content);
        },
      }),

      recall_detail: llm.tool({
        description:
          'Return the value stored under memory_type by exact label. ' +
          "Returns 'No memory found' when the label is not set. Prefer " +
          'search_memories when you are unsure which label stores the fact.',
        parameters: z.object({
          memory_type: z.string().describe('Exact label to recall.'),
        }),
        execute: async ({ memory_type }) => {
          const supabase = getSupabase();
          return recall(supabase, userId, memory_type);
        },
      }),

      forget_detail: llm.tool({
        description: 'Delete the value stored under memory_type.',
        parameters: z.object({
          memory_type: z.string().describe('Exact label to delete.'),
        }),
        execute: async ({ memory_type }) => {
          const supabase = getSupabase();
          return forget(supabase, userId, memory_type);
        },
      }),

      search_memories: llm.tool({
        description:
          'Find memories by meaning using hybrid vector and text search. ' +
          'Use when you do not know the exact label or when pulling ' +
          'background context. Returns a list of {memory_type, content} ' +
          'objects so you can follow up with recall_detail or forget_detail.',
        parameters: z.object({
          query: z.string().describe('Natural-language description.'),
        }),
        execute: async ({ query }) => {
          const supabase = getSupabase();
          const results = await searchMemory(supabase, userId, query, 3);
          return JSON.stringify({ results });
        },
      }),

      list_user_memories: llm.tool({
        description: 'Return every slot stored for this user, newest first.',
        parameters: z.object({}),
        execute: async () => {
          const supabase = getSupabase();
          const results = await listMemories(supabase, userId);
          return JSON.stringify({
            results: results.map((r) => ({
              memory_type: r.memory_type,
              content: r.content,
            })),
          });
        },
      }),
    };
  }
}
