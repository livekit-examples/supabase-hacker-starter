// Text-embedding helper backed by the shared Supabase Edge Function.
//
// Embeddings are produced by the `embed` Edge Function, which runs the
// gte-small model (384 dimensions) via Supabase's built-in inference API. The
// pgvector columns (`knowledge.embedding`, `memories.embedding`) and the
// vector RPCs (`match_knowledge`, `match_memories_hybrid`) all expect 384-dim
// vectors, so EMBEDDING_DIMENSIONS must stay in sync with the model.
//
// The function lives at `${SUPABASE_URL}/functions/v1/embed` and is deployed
// with verify_jwt = false, authorizing the `apikey` header; callers send the
// Supabase secret key (sb_secret_...) there.
// Request:  { input: string | string[] }
// Response: { embeddings: number[][] }  (always one row per input)

export const EMBEDDING_MODEL = 'gte-small';
export const EMBEDDING_DIMENSIONS = 384;

interface EmbedResponse {
  embeddings: number[][];
}

function functionUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error('SUPABASE_URL environment variable is not set.');
  }
  return `${url.replace(/\/$/, '')}/functions/v1/embed`;
}

function authKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) {
    throw new Error('SUPABASE_SECRET_KEY environment variable is not set.');
  }
  return key;
}

async function callEmbed(input: string | string[]): Promise<number[][]> {
  const key = authKey();
  const response = await fetch(functionUrl(), {
    method: 'POST',
    headers: {
      // The embed function is deployed verify_jwt=false and authorizes the
      // `apikey` header; we send the secret key there. Authorization: Bearer is
      // kept for compatibility — both are accepted.
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `embed function request failed (${response.status} ${response.statusText}): ${errBody}`,
    );
  }

  const json = (await response.json()) as EmbedResponse;
  if (!json || !Array.isArray(json.embeddings)) {
    throw new Error('embed function response did not contain `embeddings`.');
  }
  return json.embeddings;
}

/** Return a 384-dimensional embedding for a single text. */
export async function embedText(text: string): Promise<number[]> {
  const embeddings = await callEmbed(text);
  const first = embeddings[0];
  if (!first) {
    throw new Error('embed function response did not contain any embeddings.');
  }
  return first;
}

/** Batch-embed a list of texts (one HTTP round-trip). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  return callEmbed(texts);
}
