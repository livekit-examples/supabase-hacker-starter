// Pattern 3: load user data into the chat context before the session.
//
// Stamps `last_seen_at` on the user's `profiles` row (auto-created on signup by
// the handle_new_user trigger, so this is normally an update), reads back the
// stored identity fields, then appends any memory slots the agent has learned
// for this user in prior sessions. All writes land as assistant messages so the
// LLM sees them before the first reply.
import { llm } from '@livekit/agents';
import { getSupabase } from './db/client';
import { listMemories } from './tools/memory';

interface ProfileRow {
  id: string;
  name: string | null;
  email: string | null;
  preferences: Record<string, unknown> | null;
}

export async function preloadUser(userId: string): Promise<llm.ChatContext> {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  // Upsert keeps console/demo runs working even if the trigger-created row is
  // absent; for real visitors it simply refreshes last_seen_at.
  const { data: profile, error } = await supabase
    .from('profiles')
    .upsert({ id: userId, last_seen_at: now }, { onConflict: 'id' })
    .select('id, name, email, preferences')
    .maybeSingle();
  if (error) {
    console.error(`preloadUser: failed to load profile: ${error.message}`);
  }

  const row = (profile ?? null) as ProfileRow | null;
  const name = row?.name ?? undefined;
  const email = row?.email ?? undefined;
  const prefs = row?.preferences ?? {};
  const hasProfile = Boolean(name) || Boolean(email) || Object.keys(prefs).length > 0;

  const chatCtx = new llm.ChatContext();
  if (hasProfile) {
    chatCtx.addMessage({
      role: 'assistant',
      content:
        `User profile: name=${name ?? 'unknown'}, ` +
        `email=${email ?? 'unknown'}, preferences=${JSON.stringify(prefs)}.`,
    });
  } else {
    chatCtx.addMessage({
      role: 'assistant',
      content:
        `No stored profile fields yet for user_id ${userId}. ` +
        'Greet them as a new user, then ask for their name and ' +
        "call update_profile with field='name' so it persists.",
    });
  }
  if (!name) {
    chatCtx.addMessage({
      role: 'assistant',
      content:
        'No name on file for this user. Ask them for their name ' +
        "and call update_profile with field='name' to save it.",
    });
  }

  const memories = await listMemories(supabase, userId);
  if (memories.length > 0) {
    const lines = memories.map((m) => `- ${m.memory_type}: ${m.content}`).join('\n');
    chatCtx.addMessage({
      role: 'assistant',
      content: `Remembered facts from prior sessions:\n${lines}`,
    });
  }

  return chatCtx;
}
