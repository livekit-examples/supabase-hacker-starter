// Live smoke test for the shared `embed` Edge Function.
//
// All other tests stub embeddings; this is the one place we hit the real
// function to verify it is reachable and returns gte-small's 384-dim vectors.
// It skips automatically unless both SUPABASE_URL and SUPABASE_SECRET_KEY
// are set, so the suite stays green offline.
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, embedText } from '../src/tools/embeddings';

const hasEnv = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

describe('embed Edge Function (live)', () => {
  it.skipIf(!hasEnv)('embed_returns_correct_dimensions', async () => {
    const vector = await embedText('livekit supabase starter dimension check');
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    for (const v of vector) {
      expect(typeof v).toBe('number');
    }
  });
});
