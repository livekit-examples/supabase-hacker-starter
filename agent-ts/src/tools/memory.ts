// Agentic memory tools.
//
// Each function takes a Supabase client plus the verified user_id so memories
// stay isolated per user. Memories are stored as slots keyed by
// (user_id, memory_type) so writing the same label twice replaces the previous
// value (UNIQUE(user_id, memory_type) + upsert ON CONFLICT). Retrieval combines
// pgvector cosine similarity with Postgres full-text search via the
// `match_memories_hybrid` RPC, which fuses both branches with Reciprocal Rank
// Fusion in the database.
import type { SupabaseClient } from '@supabase/supabase-js';
import { embedText } from './embeddings';

interface MemoryResult {
  memory_type: string;
  content: string;
}

interface MemoryListItem extends MemoryResult {
  updated_at: string;
}

// A transient embedding failure should not drop the user's data, so on error
// we fall back to writing the memory without a vector. Recall/list/forget still
// work, and the generated `fts` column keeps the slot findable by text until
// the next write refreshes the embedding.
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Store or replace the value stored under (user_id, memory_type).
 *
 * The embedding joins the label and the content so short-value slots
 * ("name": "Pavel") stay semantically findable from natural-language queries
 * ("what's the user's name?").
 */
export async function remember(
  supabase: SupabaseClient,
  userId: string,
  memoryType: string,
  content: string,
): Promise<string> {
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(`${memoryType}: ${content}`);
  } catch (err) {
    console.warn(`embedText failed; storing ${memoryType} without vector: ${describeError(err)}`);
  }

  const row: Record<string, unknown> = {
    user_id: userId,
    memory_type: memoryType,
    content,
    updated_at: new Date().toISOString(),
  };
  // Only touch the embedding column when we have a fresh vector; otherwise
  // leave any prior embedding in place (or null on first insert).
  if (embedding) {
    row.embedding = embedding;
  }

  const { error } = await supabase
    .from('memories')
    .upsert(row, { onConflict: 'user_id,memory_type' });
  if (error) {
    throw new Error(`Failed to remember ${memoryType}: ${error.message}`);
  }
  return `Remembered (${memoryType}): ${content}`;
}

/** Return the value stored under memory_type, or a 'no memory' message. */
export async function recall(
  supabase: SupabaseClient,
  userId: string,
  memoryType: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('memories')
    .select('content')
    .eq('user_id', userId)
    .eq('memory_type', memoryType)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to recall ${memoryType}: ${error.message}`);
  }
  return data ? (data.content as string) : 'No memory found.';
}

/** Delete the value stored under memory_type. */
export async function forget(
  supabase: SupabaseClient,
  userId: string,
  memoryType: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('memories')
    .delete()
    .eq('user_id', userId)
    .eq('memory_type', memoryType)
    .select('memory_type');
  if (error) {
    throw new Error(`Failed to forget ${memoryType}: ${error.message}`);
  }
  if (!data || data.length === 0) {
    return 'No memory to forget.';
  }
  return 'Memory forgotten.';
}

/**
 * Hybrid vector + text search over the user's memories.
 *
 * Delegates to the `match_memories_hybrid` RPC, which runs a pgvector cosine
 * branch and a full-text branch (both scoped to the user) and fuses them with
 * Reciprocal Rank Fusion. The vector branch carries semantic intent; the text
 * branch catches literal label hits like "what's my user_name?" that pure
 * vector search can miss on short values. If embedding the query fails, we
 * degrade to a text-only scan over the generated `fts` column.
 */
export async function searchMemory(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  limit = 5,
): Promise<MemoryResult[]> {
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embedText(query);
  } catch (err) {
    console.warn(`embedText failed; falling back to text-only search: ${describeError(err)}`);
  }

  if (!queryEmbedding) {
    const { data, error } = await supabase
      .from('memories')
      .select('memory_type, content')
      .eq('user_id', userId)
      .textSearch('fts', query, { type: 'websearch' })
      .limit(limit);
    if (error) {
      throw new Error(`Memory text search failed: ${error.message}`);
    }
    return (data ?? []) as MemoryResult[];
  }

  const { data, error } = await supabase.rpc('match_memories_hybrid', {
    query_embedding: queryEmbedding,
    query_text: query,
    p_user_id: userId,
    match_count: limit,
  });
  if (error) {
    throw new Error(`Memory hybrid search failed: ${error.message}`);
  }
  return (data ?? []) as MemoryResult[];
}

/** Return every slot stored for this user, newest first. */
export async function listMemories(
  supabase: SupabaseClient,
  userId: string,
): Promise<MemoryListItem[]> {
  const { data, error } = await supabase
    .from('memories')
    .select('memory_type, content, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) {
    throw new Error(`Failed to list memories: ${error.message}`);
  }
  return (data ?? []) as MemoryListItem[];
}
