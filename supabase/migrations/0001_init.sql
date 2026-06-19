-- 0001_init.sql
-- Schema, RLS, indexes, triggers, and RPC functions for the LiveKit voice-agent
-- starter backed by Supabase (Postgres + pgvector + Auth + Edge Functions).
--
-- Embeddings are 384-dim (gte-small, via the `embed` Edge Function).
-- Identity is scoped purely by user_id = auth.uid(); the agent uses the service
-- role key (which bypasses RLS) and passes a server-verified user_id explicitly.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user, auto-created on signup. Owner-only.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  name         text,
  email        text,
  preferences  jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles_delete_own"
  on public.profiles for delete
  to authenticated
  using (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- knowledge — shared RAG corpus. Readable by any authenticated visitor.
-- ---------------------------------------------------------------------------
create table public.knowledge (
  id         bigint generated always as identity primary key,
  title      text,
  content    text not null,
  category   text,
  embedding  vector(384),
  created_at timestamptz not null default now()
);

alter table public.knowledge enable row level security;

create policy "knowledge_select_authenticated"
  on public.knowledge for select
  to authenticated
  using (true);

-- Approximate nearest-neighbour index for cosine distance (<=>).
create index knowledge_embedding_hnsw
  on public.knowledge
  using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- memories — per-user agentic memory slots. Owner-only.
-- One slot per (user_id, memory_type); upserts via ON CONFLICT.
-- ---------------------------------------------------------------------------
create table public.memories (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  memory_type text not null,
  content     text not null,
  embedding   vector(384),
  fts         tsvector generated always as (
                to_tsvector(
                  'english',
                  coalesce(memory_type, '') || ' ' || coalesce(content, '')
                )
              ) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, memory_type)
);

alter table public.memories enable row level security;

create policy "memories_select_own"
  on public.memories for select
  to authenticated
  using (auth.uid() = user_id);

create policy "memories_insert_own"
  on public.memories for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "memories_update_own"
  on public.memories for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "memories_delete_own"
  on public.memories for delete
  to authenticated
  using (auth.uid() = user_id);

create index memories_embedding_hnsw
  on public.memories
  using hnsw (embedding vector_cosine_ops);

create index memories_fts_gin
  on public.memories
  using gin (fts);

-- ---------------------------------------------------------------------------
-- orders — shared demo data, looked up by order_id. Readable by authenticated.
-- ---------------------------------------------------------------------------
create table public.orders (
  id         bigint generated always as identity primary key,
  order_id   text not null unique,
  user_id    uuid,
  items      text[]       not null default '{}',
  total      numeric(10, 2),
  status     text,
  created_at timestamptz  not null default now()
);

alter table public.orders enable row level security;

create policy "orders_select_authenticated"
  on public.orders for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- sessions — per-user session reports, written by the agent on shutdown.
-- Owner-only SELECT; INSERT only happens via the service role (no insert
-- policy, so RLS denies inserts for the anon/authenticated roles).
-- ---------------------------------------------------------------------------
create table public.sessions (
  id         bigint generated always as identity primary key,
  session_id text not null unique,
  user_id    uuid,
  room_name  text,
  report     jsonb,
  created_at timestamptz not null default now()
);

alter table public.sessions enable row level security;

create policy "sessions_select_own"
  on public.sessions for select
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- handle_new_user — auto-create a profile row whenever an auth user is created
-- (including anonymous sign-ins). SECURITY DEFINER so it can write profiles
-- regardless of the inserting role.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- match_knowledge — RAG retrieval over the shared knowledge corpus by cosine
-- distance. No user scoping (knowledge is shared demo data).
-- ---------------------------------------------------------------------------
create or replace function public.match_knowledge(
  query_embedding vector(384),
  match_count     int default 3
)
returns table (title text, content text)
language sql
security invoker
set search_path = public
as $$
  select k.title, k.content
  from public.knowledge k
  where k.embedding is not null
  order by k.embedding <=> query_embedding asc
  limit greatest(match_count, 1);
$$;

-- ---------------------------------------------------------------------------
-- match_memories_hybrid — hybrid retrieval over a user's memories via
-- Reciprocal Rank Fusion (RRF, k=60) of a vector branch (cosine distance) and
-- a full-text branch (websearch_to_tsquery over the generated fts column),
-- weighted 0.7 vector / 0.3 text. Both branches are filtered to the supplied
-- p_user_id. SECURITY INVOKER — the agent supplies a server-verified user_id
-- and connects with the service role (which bypasses RLS).
-- ---------------------------------------------------------------------------
create or replace function public.match_memories_hybrid(
  query_embedding vector(384),
  query_text      text,
  p_user_id       uuid,
  match_count     int default 5
)
returns table (memory_type text, content text)
language sql
security invoker
set search_path = public
as $$
  with vector_ranked as (
    select
      m.id,
      row_number() over (order by m.embedding <=> query_embedding asc) as rank
    from public.memories m
    where m.user_id = p_user_id
      and m.embedding is not null
    order by m.embedding <=> query_embedding asc
    limit least(greatest(match_count, 1) * 4, 50)
  ),
  text_ranked as (
    select
      m.id,
      row_number() over (
        order by ts_rank_cd(m.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank
    from public.memories m
    where m.user_id = p_user_id
      and query_text is not null
      and query_text <> ''
      and m.fts @@ websearch_to_tsquery('english', query_text)
    order by ts_rank_cd(m.fts, websearch_to_tsquery('english', query_text)) desc
    limit least(greatest(match_count, 1) * 4, 50)
  ),
  fused as (
    select
      coalesce(v.id, t.id) as id,
      coalesce(0.7 / (60 + v.rank), 0.0)
        + coalesce(0.3 / (60 + t.rank), 0.0) as score
    from vector_ranked v
    full outer join text_ranked t on v.id = t.id
  )
  select m.memory_type, m.content
  from fused f
  join public.memories m on m.id = f.id
  order by f.score desc
  limit greatest(match_count, 1);
$$;
