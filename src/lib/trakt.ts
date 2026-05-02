//
// Trakt API + OAuth helpers. https://trakt.docs.apiary.io/
//

import { request } from 'undici';
import { env } from './env.js';

const BASE = 'https://api.trakt.tv';
const API_VERSION = '2';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
  scope: string;
  token_type: string;
}

export interface TraktTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export function authURL(state: string): string {
  if (!env.TRAKT_CLIENT_ID || !env.TRAKT_REDIRECT_URI) {
    throw new Error('Trakt not configured: set TRAKT_CLIENT_ID and TRAKT_REDIRECT_URI');
  }
  const u = new URL('https://trakt.tv/oauth/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.TRAKT_CLIENT_ID);
  u.searchParams.set('redirect_uri', env.TRAKT_REDIRECT_URI);
  u.searchParams.set('state', state);
  return u.toString();
}

export async function exchangeCode(code: string): Promise<TraktTokens> {
  if (!env.TRAKT_CLIENT_ID || !env.TRAKT_CLIENT_SECRET || !env.TRAKT_REDIRECT_URI) {
    throw new Error('Trakt not configured');
  }
  const { statusCode, body } = await request(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: env.TRAKT_CLIENT_ID,
      client_secret: env.TRAKT_CLIENT_SECRET,
      redirect_uri: env.TRAKT_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const text = await body.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Trakt token exchange ${statusCode}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as TokenResponse;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date((json.created_at + json.expires_in) * 1000),
  };
}

export async function refresh(refreshToken: string): Promise<TraktTokens> {
  if (!env.TRAKT_CLIENT_ID || !env.TRAKT_CLIENT_SECRET || !env.TRAKT_REDIRECT_URI) {
    throw new Error('Trakt not configured');
  }
  const { statusCode, body } = await request(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: env.TRAKT_CLIENT_ID,
      client_secret: env.TRAKT_CLIENT_SECRET,
      redirect_uri: env.TRAKT_REDIRECT_URI,
      grant_type: 'refresh_token',
    }),
  });
  const text = await body.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Trakt refresh ${statusCode}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as TokenResponse;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date((json.created_at + json.expires_in) * 1000),
  };
}

export async function userSettings(accessToken: string): Promise<{ username: string } | null> {
  const { statusCode, body } = await request(`${BASE}/users/settings`, {
    headers: traktHeaders(accessToken),
  });
  if (statusCode < 200 || statusCode >= 300) return null;
  const json = await body.json() as { user: { username: string } };
  return { username: json.user.username };
}

/**
 * Scrobble a play event. action ∈ start | pause | stop.
 * For Stremio addon-derived metadata we send imdb id only.
 */
export async function scrobble(
  accessToken: string,
  action: 'start' | 'pause' | 'stop',
  payload: { imdbID?: string; tmdbID?: number; type: 'movie' | 'episode'; progress: number }
): Promise<void> {
  const ids: Record<string, unknown> = {};
  if (payload.imdbID) ids.imdb = payload.imdbID;
  if (payload.tmdbID) ids.tmdb = payload.tmdbID;
  if (Object.keys(ids).length === 0) return; // need at least one

  const body = payload.type === 'movie'
    ? { movie: { ids }, progress: payload.progress }
    : { episode: { ids }, progress: payload.progress };

  await request(`${BASE}/scrobble/${action}`, {
    method: 'POST',
    headers: traktHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

function traktHeaders(accessToken: string): Record<string, string> {
  if (!env.TRAKT_CLIENT_ID) throw new Error('Trakt not configured');
  return {
    'authorization': `Bearer ${accessToken}`,
    'trakt-api-version': API_VERSION,
    'trakt-api-key': env.TRAKT_CLIENT_ID,
    'content-type': 'application/json',
  };
}
