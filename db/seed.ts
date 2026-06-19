// Seed Supabase with shared demo data and a demo auth user.
//
// Run after the migrations are applied and the `embed` function is deployed:
//
//     pnpm db:seed
//
// What it does (all with the secret key SUPABASE_SECRET_KEY, which bypasses RLS):
//   1. Clears sessions, memories, orders, knowledge, and profiles, and removes
//      any pre-existing demo auth user so the seed is idempotent.
//   2. Inserts the shared knowledge corpus, embedding each doc via the `embed`
//      Edge Function (gte-small, 384-dim).
//   3. Inserts the shared demo orders.
//   4. Creates a demo auth user (demo@example.com) via auth.admin.createUser,
//      then upserts its profile and a couple of embedded memories.
//   5. Prints the demo user's uuid as DEMO_USER_ID — copy it into
//      agent-ts/.env.local and agent-py/.env.local for console mode.
//
// Sample data lives in db/data.ts.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DEMO_MEMORIES,
  DEMO_PROFILE,
  DEMO_USER_EMAIL,
  KNOWLEDGE_INPUTS,
  ORDERS,
} from './data';

// --- env -------------------------------------------------------------------
// The starter keeps env in per-runtime files. Probe the db/, agent, and root
// locations and load the first match.
const CANDIDATE_ENV_PATHS = [
  'db/.env.local',
  'agent-ts/.env.local',
  'agent-py/.env.local',
  '.env.local',
];

function loadEnv(): void {
  const cwd = process.cwd();
  for (const candidate of CANDIDATE_ENV_PATHS) {
    const abs = resolve(cwd, candidate);
    if (existsSync(abs)) {
      dotenv.config({ path: abs });
      console.info(`Loaded env from ${candidate}`);
      return;
    }
  }
  console.info('No .env.local found; relying on the ambient environment.');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Required environment variable ${name} is not set. Check your .env.local file.`,
    );
  }
  return value;
}

// --- embeddings ------------------------------------------------------------
// Call the shared `embed` Edge Function. Request { input } -> { embeddings }.
// The function is deployed with verify_jwt = false and authorizes on the
// `apikey` header (modern sb_secret_… keys are not JWTs). We send the secret
// key on `apikey`; Authorization: Bearer is included as a fallback.
async function embedTexts(
  supabaseUrl: string,
  secretKey: string,
  texts: string[],
): Promise<number[][]> {
  const res = await fetch(`${supabaseUrl}/functions/v1/embed`, {
    method: 'POST',
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: texts }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`embed function failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { embeddings: number[][] };
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error(
      `embed function returned ${data.embeddings?.length ?? 0} vectors for ${texts.length} inputs`,
    );
  }
  return data.embeddings;
}

// --- clearing --------------------------------------------------------------
async function clearTables(supabase: SupabaseClient): Promise<void> {
  // bigint-identity tables: delete every row (id >= 0).
  for (const table of ['sessions', 'memories', 'orders', 'knowledge']) {
    const { error } = await supabase.from(table).delete().gte('id', 0);
    if (error) throw new Error(`Failed clearing ${table}: ${error.message}`);
  }
  // profiles has a uuid PK: delete every row.
  {
    const { error } = await supabase
      .from('profiles')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw new Error(`Failed clearing profiles: ${error.message}`);
  }
  console.info('Cleared sessions, memories, orders, knowledge, profiles');
}

async function removeExistingDemoUser(supabase: SupabaseClient): Promise<void> {
  // auth.admin.listUsers is paginated; the demo user is on the first page of a
  // fresh project, which is all this starter needs.
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`Failed listing auth users: ${error.message}`);
  const existing = data.users.find((u) => u.email === DEMO_USER_EMAIL);
  if (existing) {
    const { error: delError } = await supabase.auth.admin.deleteUser(existing.id);
    if (delError) throw new Error(`Failed deleting demo user: ${delError.message}`);
    console.info(`Removed pre-existing demo user ${existing.id}`);
  }
}

// --- seed ------------------------------------------------------------------
async function seed(): Promise<void> {
  loadEnv();

  const supabaseUrl = requireEnv('SUPABASE_URL');
  // Modern Supabase API key (sb_secret_…). Works like the legacy service_role
  // key for createClient — it bypasses RLS.
  const secretKey = requireEnv('SUPABASE_SECRET_KEY');

  const supabase = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  await removeExistingDemoUser(supabase);
  await clearTables(supabase);

  // 1. Knowledge corpus + embeddings.
  const knowledgeEmbeddings = await embedTexts(
    supabaseUrl,
    secretKey,
    KNOWLEDGE_INPUTS.map((doc) => doc.content),
  );
  const knowledgeRows = KNOWLEDGE_INPUTS.map((doc, i) => ({
    title: doc.title,
    content: doc.content,
    category: doc.category,
    embedding: knowledgeEmbeddings[i],
  }));
  {
    const { error } = await supabase.from('knowledge').insert(knowledgeRows);
    if (error) throw new Error(`Failed inserting knowledge: ${error.message}`);
  }
  console.info(`Inserted ${knowledgeRows.length} knowledge documents with embeddings`);

  // 2. Shared demo orders.
  {
    const { error } = await supabase.from('orders').insert(ORDERS);
    if (error) throw new Error(`Failed inserting orders: ${error.message}`);
  }
  console.info(`Inserted ${ORDERS.length} orders`);

  // 3. Demo auth user. createUser fires handle_new_user(), which inserts a
  //    bare profile row; we upsert it below with the full demo profile.
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: DEMO_USER_EMAIL,
    email_confirm: true,
    user_metadata: { name: DEMO_PROFILE.name },
  });
  if (createError || !created.user) {
    throw new Error(`Failed creating demo user: ${createError?.message ?? 'no user returned'}`);
  }
  const demoUserId = created.user.id;
  console.info(`Created demo auth user ${DEMO_USER_EMAIL} (${demoUserId})`);

  // 4. Demo profile (upsert over the trigger-created row).
  {
    const { error } = await supabase.from('profiles').upsert({
      id: demoUserId,
      name: DEMO_PROFILE.name,
      email: DEMO_PROFILE.email,
      preferences: DEMO_PROFILE.preferences,
      last_seen_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Failed upserting demo profile: ${error.message}`);
  }
  console.info('Upserted demo profile');

  // 5. Demo memories + embeddings.
  const memoryEmbeddings = await embedTexts(
    supabaseUrl,
    secretKey,
    DEMO_MEMORIES.map((m) => m.content),
  );
  const memoryRows = DEMO_MEMORIES.map((m, i) => ({
    user_id: demoUserId,
    memory_type: m.memory_type,
    content: m.content,
    embedding: memoryEmbeddings[i],
  }));
  {
    const { error } = await supabase
      .from('memories')
      .upsert(memoryRows, { onConflict: 'user_id,memory_type' });
    if (error) throw new Error(`Failed inserting demo memories: ${error.message}`);
  }
  console.info(`Inserted ${memoryRows.length} demo memories with embeddings`);

  console.info('\nSeed complete.');
  console.info('Copy the following into agent-ts/.env.local and agent-py/.env.local:');
  console.info(`DEMO_USER_ID=${demoUserId}`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
