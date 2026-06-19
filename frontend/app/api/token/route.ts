import { NextRequest, NextResponse } from 'next/server';
import { AccessToken, type AccessTokenOptions, type VideoGrant } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { type CookieOptions, createServerClient } from '@supabase/ssr';

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

// NOTE: you are expected to define the following environment variables in `.env.local`:
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const AGENT_NAME = process.env.AGENT_NAME;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// don't cache the results
export const revalidate = 0;

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error(
      'THIS API ROUTE IS INSECURE. DO NOT USE THIS ROUTE IN PRODUCTION WITHOUT AN AUTHENTICATION LAYER.'
    );
  }

  try {
    if (LIVEKIT_URL === undefined) {
      throw new Error('LIVEKIT_URL is not defined');
    }
    if (API_KEY === undefined) {
      throw new Error('LIVEKIT_API_KEY is not defined');
    }
    if (API_SECRET === undefined) {
      throw new Error('LIVEKIT_API_SECRET is not defined');
    }
    if (SUPABASE_URL === undefined) {
      throw new Error('NEXT_PUBLIC_SUPABASE_URL is not defined');
    }
    if (SUPABASE_PUBLISHABLE_KEY === undefined) {
      throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not defined');
    }

    // Verify the visitor server-side via their Supabase auth cookie. The
    // browser signs in anonymously on load, so a real `auth.users` row + JWT
    // already exists by the time the call starts. We collect any rotated auth
    // cookies and re-attach them to the JSON response below.
    const refreshedCookies: { name: string; value: string; options: CookieOptions }[] = [];
    const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          refreshedCookies.push(...cookiesToSet);
        },
      },
    });

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return new NextResponse('Unauthorized: no valid Supabase session', { status: 401 });
    }

    // The verified Supabase user id (= auth.uid()) is the sole identity. The
    // server is the only authority here — we never trust a user id from the
    // request body. It rides along to the agent in the dispatch metadata, where
    // `preload_user` reads it before the first turn.
    const userId = user.id;

    const metadata = JSON.stringify({ user_id: userId });
    const roomConfig = AGENT_NAME
      ? new RoomConfiguration({
          agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata })],
        })
      : new RoomConfiguration();

    // Generate participant token
    const participantName = 'user';
    const participantIdentity = `voice_assistant_user_${Math.floor(Math.random() * 10_000)}`;
    const roomName = `voice_assistant_room_${Math.floor(Math.random() * 10_000)}`;

    const participantToken = await createParticipantToken(
      { identity: participantIdentity, name: participantName },
      roomName,
      roomConfig
    );

    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL,
      roomName,
      participantName,
      participantToken,
    };
    const res = NextResponse.json(data);
    res.headers.set('Cache-Control', 'no-store');
    // Persist any auth cookies Supabase rotated while verifying the session.
    refreshedCookies.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    return res;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  roomConfig: RoomConfiguration | undefined
): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    ...userInfo,
    ttl: '15m',
  });
  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };
  at.addGrant(grant);

  if (roomConfig) {
    at.roomConfig = roomConfig;
  }

  return at.toJwt();
}
