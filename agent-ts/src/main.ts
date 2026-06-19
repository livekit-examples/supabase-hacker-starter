// Entry point for the LiveKit + Supabase voice agent.
//
// Mirrors the upstream `agent-starter-node` template scaffold and layers the
// five Supabase integration patterns on top: dispatch metadata -> preload ->
// session -> shutdown report -> greet.
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { VoiceAgent } from './agent';
import { getSupabase } from './db/client';
import { preloadUser } from './preload';

dotenv.config({ path: '.env.local' });

interface DispatchMetadata {
  user_id?: string;
}

function safeParseMetadata(raw: string | undefined | null): DispatchMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as DispatchMetadata;
  } catch {
    console.warn('ctx.job.metadata was not valid JSON; using defaults');
  }
  return {};
}

// Identity resolution: the token route verifies the Supabase session and packs
// the verified user_id into dispatch metadata. When there is no metadata (e.g.
// running locally with `pnpm dev` and connecting through the Agent Console),
// fall back to the seeded demo user so the preload path still has data.
function resolveUserId(raw: string | undefined | null): string {
  const meta = safeParseMetadata(raw);
  const userId = meta.user_id ?? process.env.DEMO_USER_ID;
  if (!userId) {
    throw new Error(
      'No user_id in dispatch metadata and DEMO_USER_ID is not set. ' +
        'Set DEMO_USER_ID in .env.local for local runs, or dispatch the ' +
        'agent with metadata { "user_id": "<auth.uid>" }.',
    );
  }
  return userId;
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    // Pattern 3 setup: identify the user from agent dispatch metadata so the
    // preload Supabase lookup runs in parallel with the room connection.
    const userId = resolveUserId(ctx.job.metadata);
    ctx.proc.userData.user_id = userId;

    const initialChatCtx = await preloadUser(userId);

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'multi',
      }),
      llm: new inference.LLM({
        model: 'openai/gpt-5.3-chat-latest',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      voiceOptions: {
        preemptiveGeneration: true,
      },
    });

    // Pattern 5: persist a session report to Supabase on hangup. The agent uses
    // the secret key, so the INSERT succeeds even though `sessions` has no
    // INSERT policy for end users.
    ctx.addShutdownCallback(async () => {
      try {
        const report = ctx.makeSessionReport(session);
        const supabase = getSupabase();
        const { error } = await supabase.from('sessions').insert({
          session_id: ctx.room.name,
          user_id: ctx.proc.userData.user_id,
          room_name: ctx.room.name,
          report: voice.sessionReportToJSON(report),
        });
        if (error) {
          throw new Error(error.message);
        }
        console.info(`Persisted session report for ${ctx.room.name}`);
      } catch (err) {
        console.error('Failed to persist session report', err);
      }
    });

    await session.start({
      agent: new VoiceAgent({
        chatCtx: initialChatCtx,
        userId,
      }),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: audioEnhancement({ model: 'quailVfL' }),
      },
    });

    await ctx.connect();

    session.generateReply({
      instructions:
        'Greet the user by name if the loaded profile or remembered ' +
        'facts contain one. If no name is on file, briefly introduce ' +
        'yourself as a Supabase-backed voice assistant and ask the ' +
        'user for their name. When they tell you, call update_profile ' +
        "with field='name' so it persists for next time.",
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
  }),
);
