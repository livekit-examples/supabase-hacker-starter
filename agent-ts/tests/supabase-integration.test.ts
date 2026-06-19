// Offline integration tests for the Supabase plumbing.
//
// The agent codes against the Canonical Contract; these tests run it against an
// in-memory fake Supabase client (see fakeSupabase.ts) so the full suite passes
// without a live database. Embeddings are stubbed with deterministic vectors.
// Live, end-to-end runs against a real project happen separately.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeSupabase, fakeVector, makeFakeSupabase, seededStore } from './fakeSupabase';

const holder = vi.hoisted(() => ({ client: null as FakeSupabase | null }));

vi.mock('../src/db/client', () => ({
  getSupabase: () => holder.client,
}));

vi.mock('../src/tools/embeddings', async () => {
  const actual =
    await vi.importActual<typeof import('../src/tools/embeddings')>('../src/tools/embeddings');
  return {
    ...actual,
    embedText: vi.fn(async (text: string) => fakeVector(text)),
    embedTexts: vi.fn(async (texts: string[]) => texts.map((t) => fakeVector(t))),
  };
});

function client(): FakeSupabase {
  if (!holder.client) throw new Error('fake client not initialized');
  return holder.client;
}

function rendered(items: ReadonlyArray<{ content?: unknown }>): string {
  return items
    .map((i) => (typeof i.content === 'string' ? i.content : JSON.stringify(i.content)))
    .join(' ');
}

describe('Supabase integration', () => {
  beforeEach(() => {
    holder.client = makeFakeSupabase(seededStore());
  });

  it('pattern_3_preload_finds_known_user', async () => {
    const { preloadUser } = await import('../src/preload');
    const chatCtx = await preloadUser('user-1');
    const text = rendered(chatCtx.items as ReadonlyArray<{ content?: unknown }>);
    expect(text).toContain('Jordan');
    expect(text).toContain('jordan@example.com');
  });

  it('pattern_3_preload_handles_missing_user', async () => {
    const { preloadUser } = await import('../src/preload');
    const chatCtx = await preloadUser('user-unknown');
    const text = rendered(chatCtx.items as ReadonlyArray<{ content?: unknown }>);
    expect(text).toContain('No stored profile fields');
  });

  it('pattern_3_preload_prompts_for_name_when_missing', async () => {
    // With no profile name on file, the preloaded context must instruct the
    // agent to ASK for the user's name and persist it via update_profile.
    const { preloadUser } = await import('../src/preload');
    const chatCtx = await preloadUser('user-unknown');
    const text = rendered(chatCtx.items as ReadonlyArray<{ content?: unknown }>).toLowerCase();
    expect(text).toContain('ask');
    expect(text).toContain('name');
    expect(text).toContain('update_profile');
  });

  it('pattern_3_preload_stamps_last_seen', async () => {
    const { preloadUser } = await import('../src/preload');
    await preloadUser('user-1');
    const profile = client().store.profiles.find((p) => p.id === 'user-1');
    expect(profile?.last_seen_at).toBeTruthy();
  });

  it('pattern_1_search_knowledge_returns_docs', async () => {
    const { vectorSearchKnowledge } = await import('../src/agent');
    const results = await vectorSearchKnowledge(client() as never, 'voice agent retrieval', 3);
    expect(Array.isArray(results)).toBe(true);
    for (const doc of results) {
      expect(doc).toHaveProperty('title');
      expect(doc).toHaveProperty('content');
    }
  });

  it('pattern_4_lookup_order', async () => {
    const { data: order } = await client()
      .from('orders')
      .select('order_id, items, total, status')
      .eq('order_id', 'order_1001')
      .maybeSingle();
    expect(order).not.toBeNull();
    expect((order as { items: string[] }).items).toEqual(['Widget A', 'Widget B']);
    expect((order as { status: string }).status).toBe('delivered');
  });

  it('pattern_5_session_report_insert', async () => {
    await client()
      .from('sessions')
      .insert({
        session_id: 'test-room-1',
        user_id: 'user-1',
        room_name: 'test-room-1',
        report: { chat_history: [] },
      });
    const { data: found } = await client()
      .from('sessions')
      .select('session_id, user_id')
      .eq('session_id', 'test-room-1')
      .maybeSingle();
    expect(found).not.toBeNull();
    expect((found as { user_id: string }).user_id).toBe('user-1');
  });

  it('pattern_2_memory_remember_recall_forget', async () => {
    const { remember, recall, forget } = await import('../src/tools/memory');
    const msg = await remember(client() as never, 'user-1', 'preference', 'likes coffee');
    expect(msg).toContain('Remembered');

    expect(await recall(client() as never, 'user-1', 'preference')).toBe('likes coffee');

    expect(await forget(client() as never, 'user-1', 'preference')).toBe('Memory forgotten.');
    expect(await recall(client() as never, 'user-1', 'preference')).toBe('No memory found.');
  });

  it('pattern_2_memory_isolation_across_users', async () => {
    const { remember, recall } = await import('../src/tools/memory');
    await remember(client() as never, 'user-a', 'fact', 'lives in Paris');
    await remember(client() as never, 'user-b', 'fact', 'lives in Tokyo');
    expect(await recall(client() as never, 'user-a', 'fact')).toBe('lives in Paris');
    expect(await recall(client() as never, 'user-b', 'fact')).toBe('lives in Tokyo');
  });

  it('pattern_2_memory_overwrite', async () => {
    const { remember, recall, listMemories } = await import('../src/tools/memory');
    await remember(client() as never, 'user-1', 'favorite_color', 'blue');
    await remember(client() as never, 'user-1', 'favorite_color', 'green');
    expect(await recall(client() as never, 'user-1', 'favorite_color')).toBe('green');
    const slots = (await listMemories(client() as never, 'user-1')).filter(
      (m) => m.memory_type === 'favorite_color',
    );
    expect(slots).toHaveLength(1);
  });

  it('pattern_2_list_memories_returns_all_slots', async () => {
    const { remember, listMemories } = await import('../src/tools/memory');
    await remember(client() as never, 'user-1', 'favorite_color', 'blue');
    await remember(client() as never, 'user-1', 'allergy', 'peanuts');
    const results = await listMemories(client() as never, 'user-1');
    const types = new Set(results.map((r) => r.memory_type));
    expect(types).toEqual(new Set(['favorite_color', 'allergy']));
  });

  it('pattern_2_search_memory_returns_list', async () => {
    const { remember, searchMemory } = await import('../src/tools/memory');
    await remember(client() as never, 'user-1', 'color_preference', 'blue');
    const results = await searchMemory(client() as never, 'user-1', 'anything', 5);
    expect(Array.isArray(results)).toBe(true);
    for (const item of results) {
      expect(item).toHaveProperty('memory_type');
      expect(item).toHaveProperty('content');
    }
  });
});
