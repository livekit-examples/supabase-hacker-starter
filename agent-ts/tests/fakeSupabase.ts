// In-memory fake Supabase client for offline unit tests.
//
// The agent codes against the Canonical Contract (PostgREST table ops +
// `match_knowledge` / `match_memories_hybrid` RPCs). These tests exercise that
// code without a live database by emulating the small slice of the supabase-js
// query builder the agent actually uses: select/eq/order/limit/textSearch/
// maybeSingle/single, upsert (with onConflict), insert, delete().select(), and
// rpc(). Live integration runs happen separately against a real project.
import { createHash } from 'node:crypto';

export interface FakeStore {
  profiles: Record<string, unknown>[];
  memories: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  knowledge: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
}

type Row = Record<string, unknown>;
interface Result {
  data: unknown;
  error: { message: string } | null;
}

const EMBED_DIMENSIONS = 384;

/** Deterministic unit-norm vector, mirroring the embed Edge Function shape. */
export function fakeVector(text: string, dimensions = EMBED_DIMENSIONS): number[] {
  const digest = createHash('sha256').update(text, 'utf8').digest();
  const raw = Array.from({ length: dimensions }, (_, i) => {
    const b = digest[i % digest.length]!;
    return (b - 128) / 128.0;
  });
  const norm = Math.sqrt(raw.reduce((acc, x) => acc + x * x, 0)) || 1;
  return raw.map((x) => x / norm);
}

class QueryBuilder {
  private op: 'select' | 'upsert' | 'insert' | 'delete' = 'select';
  private filters: Array<[string, unknown]> = [];
  private selectRequested = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;
  private text: { q: string } | null = null;
  private payload: Row | Row[] | null = null;
  private onConflict: string[] = [];
  private cols?: string;

  constructor(
    private rows: Row[],
    private table: string,
  ) {}

  select(cols?: string): this {
    this.selectRequested = true;
    this.cols = cols;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, asc: opts?.ascending ?? true };
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  textSearch(_col: string, query: string): this {
    this.text = { q: query };
    return this;
  }

  upsert(payload: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = 'upsert';
    this.payload = payload;
    this.onConflict = (opts?.onConflict ?? 'id').split(',').map((s) => s.trim());
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  maybeSingle(): Promise<Result> {
    return this.run('maybeSingle');
  }

  single(): Promise<Result> {
    return this.run('single');
  }

  then<T>(resolve: (r: Result) => T, reject?: (e: unknown) => T): Promise<T> {
    return this.run('many').then(resolve, reject);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([col, val]) => row[col] === val);
  }

  private conflictMatch(a: Row, b: Row): boolean {
    return this.onConflict.every((k) => a[k] === b[k]);
  }

  private async run(shape: 'many' | 'maybeSingle' | 'single'): Promise<Result> {
    let data: unknown = null;

    if (this.op === 'upsert' || this.op === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const written: Row[] = [];
      for (const next of incoming) {
        if (this.op === 'upsert') {
          const existing = this.rows.find((r) => this.conflictMatch(r, next));
          if (existing) {
            Object.assign(existing, next);
            written.push(existing);
            continue;
          }
        }
        const created = { ...next };
        this.rows.push(created);
        written.push(created);
      }
      data = this.selectRequested ? written : null;
    } else if (this.op === 'delete') {
      const removed: Row[] = [];
      for (let i = this.rows.length - 1; i >= 0; i--) {
        if (this.matches(this.rows[i]!)) {
          removed.unshift(this.rows.splice(i, 1)[0]!);
        }
      }
      data = this.selectRequested ? removed : null;
    } else {
      let result = this.rows.filter((r) => this.matches(r));
      if (this.text) {
        const tokens = this.text.q.toLowerCase().split(/\s+/).filter(Boolean);
        result = result.filter((r) => {
          const hay = `${r.memory_type ?? ''} ${r.content ?? ''}`.toLowerCase();
          return tokens.some((t) => hay.includes(t));
        });
      }
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        result = [...result].sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (this.limitN != null) {
        result = result.slice(0, this.limitN);
      }
      data = result;
    }

    if (shape === 'maybeSingle' || shape === 'single') {
      const arr = (data as Row[] | null) ?? [];
      if (shape === 'single' && arr.length === 0) {
        return { data: null, error: { message: 'No rows found' } };
      }
      return { data: arr[0] ?? null, error: null };
    }
    return { data, error: null };
  }
}

export interface FakeSupabase {
  from(table: keyof FakeStore): QueryBuilder;
  rpc(name: string, params: Record<string, unknown>): Promise<Result>;
  store: FakeStore;
}

export function makeFakeSupabase(store: FakeStore): FakeSupabase {
  return {
    store,
    from(table) {
      return new QueryBuilder(store[table], table);
    },
    async rpc(name, params) {
      if (name === 'match_knowledge') {
        const limit = (params.match_count as number) ?? 3;
        const data = store.knowledge
          .slice(0, limit)
          .map((k) => ({ title: k.title, content: k.content }));
        return { data, error: null };
      }
      if (name === 'match_memories_hybrid') {
        const userId = params.p_user_id;
        const limit = (params.match_count as number) ?? 5;
        const data = store.memories
          .filter((m) => m.user_id === userId)
          .slice(0, limit)
          .map((m) => ({ memory_type: m.memory_type, content: m.content }));
        return { data, error: null };
      }
      return { data: null, error: { message: `Unknown RPC ${name}` } };
    },
  };
}

/** Fresh store seeded with a known profile, order, and knowledge docs. */
export function seededStore(): FakeStore {
  const now = new Date().toISOString();
  return {
    profiles: [
      {
        id: 'user-1',
        name: 'Jordan',
        email: 'jordan@example.com',
        preferences: { language: 'en' },
        created_at: now,
      },
    ],
    memories: [],
    orders: [
      {
        order_id: 'order_1001',
        user_id: 'user-1',
        items: ['Widget A', 'Widget B'],
        total: 49.99,
        status: 'delivered',
        created_at: now,
      },
    ],
    knowledge: [
      {
        id: 1,
        title: 'RAG pattern',
        content: 'Inject vector search results into the chat context.',
      },
      {
        id: 2,
        title: 'Memory pattern',
        content: 'Use tools to remember and recall details.',
      },
    ],
    sessions: [],
  };
}
