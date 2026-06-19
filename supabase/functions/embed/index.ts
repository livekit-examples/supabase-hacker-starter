// Supabase Edge Function: embed
//
// Wraps the built-in Supabase.ai `gte-small` model to produce 384-dimensional
// embeddings. This is the single shared embedding endpoint for the whole
// starter — the seed script, both agent runtimes, and any future caller hit
// this function so the model and dimensions are defined in exactly one place.
//
// Request  JSON: { "input": string | string[] }
// Response JSON: { "embeddings": number[][] }  // one vector per input, in order
//
// This function is called server-side only (the seed script and both agent
// runtimes), each of which holds the project's secret API key. Callers send
// `Authorization: Bearer <SUPABASE_SECRET_KEY>`.
//
// It is deployed with `verify_jwt = false` because Supabase's modern API keys
// (sb_publishable_… / sb_secret_…) are NOT JWTs, so the gateway's verify_jwt
// check would reject them. We instead require a bearer token to be present in
// the Authorization header (callers pass the secret key).
//
//   supabase functions deploy embed --no-verify-jwt
//
// PRODUCTION NOTE: requiring a bearer token keeps the endpoint from being
// trivially open, but for production you should harden further — e.g. set a
// dedicated function secret and compare against it (`supabase secrets set
// EMBED_TOKEN=…`), and/or add network/rate-limit policies.
//
// Local invoke:
//   curl -i --request POST 'http://localhost:54321/functions/v1/embed' \
//     --header 'Authorization: Bearer <SUPABASE_SECRET_KEY>' \
//     --header 'Content-Type: application/json' \
//     --data '{"input":"hello world"}'

// The `Supabase` global is provided by the Edge Functions runtime.
declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run(
        input: string,
        opts: { mean_pool: boolean; normalize: boolean },
      ): Promise<number[]>;
    };
  };
};

const session = new Supabase.ai.Session('gte-small');

interface EmbedRequest {
  input: string | string[];
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // verify_jwt is disabled (modern API keys are not JWTs, so the platform's
  // gateway check can't validate them — see Supabase docs). Per the docs we
  // implement our own apikey authorization here. Callers (the seed script and
  // both agents) present the project's secret key on the `apikey` header
  // (with `Authorization: Bearer` as a fallback for clients that set it).
  const presented =
    req.headers.get('apikey') ??
    (req.headers.get('Authorization') ?? '').replace(/^[Bb]earer\s+/, '');
  const expected = Deno.env.get('EMBED_SECRET');
  if (expected) {
    // Hardened mode: a dedicated secret was provisioned (`supabase secrets set
    // EMBED_SECRET=…`); require an exact match.
    if (presented !== expected) {
      return json({ error: 'Unauthorized' }, 401);
    }
  } else if (!presented || presented.trim().length === 0) {
    // Starter mode: no dedicated secret set — require a non-empty key so the
    // endpoint is not trivially open. See the PRODUCTION NOTE above.
    return json({ error: 'Missing apikey / Authorization' }, 401);
  }

  let body: EmbedRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { input } = body;
  if (input === undefined || input === null) {
    return json({ error: 'Missing "input" (string | string[])' }, 400);
  }

  // Normalize to an array so the response is always array-of-arrays.
  const inputs = Array.isArray(input) ? input : [input];
  if (inputs.some((t) => typeof t !== 'string')) {
    return json({ error: '"input" must be a string or array of strings' }, 400);
  }

  try {
    // gte-small returns a 384-dim vector per input. mean_pool + normalize
    // yields unit-length vectors suitable for cosine distance (<=>).
    const embeddings: number[][] = [];
    for (const text of inputs) {
      const embedding = (await session.run(text, {
        mean_pool: true,
        normalize: true,
      })) as number[];
      embeddings.push(embedding);
    }
    return json({ embeddings }, 200);
  } catch (err) {
    return json(
      { error: `Embedding failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
