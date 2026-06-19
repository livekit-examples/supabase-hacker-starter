// Shared sample data for db/seed.ts.
//
// Pure data — no client code, no I/O. Edit here to customize the starter's
// demo data; `pnpm db:seed` picks it up.
//
//   - knowledge + orders are SHARED demo data (RLS allows any authenticated
//     visitor to read them), so search_knowledge and lookup_order work for
//     every visitor out of the box.
//   - the demo profile + memories belong to a seeded demo auth user
//     (demo@example.com) so console mode shows the pre-loaded context path.

export interface KnowledgeSeed {
  title: string;
  content: string;
  category: string;
}

export interface OrderSeed {
  order_id: string;
  items: string[];
  total: number;
  status: 'delivered' | 'pending' | 'shipped' | 'cancelled';
}

export interface ProfileSeed {
  name: string;
  email: string;
  preferences: { language: string; timezone: string };
}

export interface MemorySeed {
  memory_type: string;
  content: string;
}

// Shared RAG corpus: voice-agent, Supabase, and LiveKit facts.
export const KNOWLEDGE_INPUTS: KnowledgeSeed[] = [
  {
    title: 'Handling interruptions',
    content:
      'Voice agents detect speech during a reply and pause playback. ' +
      'Use disallow_interruptions inside function tools that mutate state.',
    category: 'voice-agents',
  },
  {
    title: 'Voice agent RAG pattern',
    content:
      'Run vector search inside on_user_turn_completed and inject the ' +
      'results into the chat context before the LLM replies.',
    category: 'patterns',
  },
  {
    title: 'Agentic memory pattern',
    content:
      'Expose remember, recall, forget, and search_memories as tools so ' +
      'the LLM decides what persists across sessions.',
    category: 'patterns',
  },
  {
    title: 'Embeddings with gte-small',
    content:
      'The embed Edge Function wraps the built-in Supabase.ai gte-small ' +
      'model and returns 384-dimensional vectors. Use the same function ' +
      'everywhere so the model and dimensions are defined in one place.',
    category: 'supabase',
  },
  {
    title: 'pgvector similarity search',
    content:
      'Store embeddings in a vector(384) column and rank with the cosine ' +
      'distance operator <=>. An HNSW index keeps approximate nearest- ' +
      'neighbour queries fast as the corpus grows.',
    category: 'supabase',
  },
  {
    title: 'Hybrid memory with RRF',
    content:
      'match_memories_hybrid fuses a pgvector branch and a tsvector ' +
      'full-text branch with Reciprocal Rank Fusion (k=60), weighting ' +
      'vector results 0.7 and text results 0.3.',
    category: 'supabase',
  },
  {
    title: 'Row Level Security for agents',
    content:
      'Enable RLS on every table. The browser uses the anon key and is ' +
      'restricted to auth.uid(); the agent uses the service role key, which ' +
      'bypasses RLS, and scopes every query by a server-verified user_id.',
    category: 'supabase',
  },
  {
    title: 'Choosing an STT provider',
    content:
      'LiveKit Inference supports Deepgram Nova-3, AssemblyAI, and others. ' +
      'Prefer models with built-in endpointing for realtime conversations.',
    category: 'livekit',
  },
  {
    title: 'Agent dispatch metadata',
    content:
      'The token route packs the verified user_id into RoomAgentDispatch ' +
      'metadata as JSON. The agent parses ctx.job.metadata to scope data ' +
      'access, falling back to DEMO_USER_ID in console mode.',
    category: 'livekit',
  },
  {
    title: 'Session telemetry and reports',
    content:
      'Collect per-model usage with session.usage and write a session ' +
      'report to the sessions table on shutdown using the service role.',
    category: 'livekit',
  },
];

// Shared demo orders, looked up by order_id (no owner — work for everyone).
export const ORDERS: OrderSeed[] = [
  {
    order_id: 'order_1001',
    items: ['Widget A', 'Widget B'],
    total: 49.99,
    status: 'delivered',
  },
  {
    order_id: 'order_1002',
    items: ['Gadget X'],
    total: 29.99,
    status: 'pending',
  },
];

// Demo auth user, created by the seed via auth.admin.createUser.
export const DEMO_USER_EMAIL = 'demo@example.com';

export const DEMO_PROFILE: ProfileSeed = {
  name: 'Jordan',
  email: DEMO_USER_EMAIL,
  preferences: { language: 'en', timezone: 'America/New_York' },
};

// A couple of pre-existing memories for the demo user so the preload path
// (Pattern 3) has something to surface before the first turn.
export const DEMO_MEMORIES: MemorySeed[] = [
  {
    memory_type: 'preference',
    content: 'Prefers concise, direct answers and a friendly tone.',
  },
  {
    memory_type: 'fact',
    content: 'Is building a LiveKit voice agent backed by Supabase.',
  },
];
