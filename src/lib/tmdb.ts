//
// Small TMDB v3 API wrapper. Used to enrich Stremio metadata with high-res
// posters/backdrops. No-op if TMDB_API_KEY is unset.
//

import { request } from 'undici';
import { env } from './env.js';
import { TTLCache } from './cache.js';

const cache = new TTLCache<unknown>(60 * 60 * 1000); // 1h

const BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

export interface TMDBSearchResult {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  genre_ids?: number[];
}

export function isConfigured(): boolean {
  return !!env.TMDB_API_KEY;
}

export function posterURL(path: string | null | undefined, size = 'w500'): string | undefined {
  if (!path) return undefined;
  return `${IMG_BASE}/${size}${path}`;
}

export function backdropURL(path: string | null | undefined, size = 'w1280'): string | undefined {
  if (!path) return undefined;
  return `${IMG_BASE}/${size}${path}`;
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  if (!env.TMDB_API_KEY) return null;
  const qs = new URLSearchParams({ api_key: env.TMDB_API_KEY, ...params }).toString();
  const url = `${BASE}${path}?${qs}`;
  const cached = cache.get(url);
  if (cached) return cached as T;
  const { statusCode, body } = await request(url, { method: 'GET' });
  if (statusCode < 200 || statusCode >= 300) return null;
  const json = await body.json() as T;
  cache.set(url, json);
  return json;
}

export async function findByImdbID(imdbID: string): Promise<{ poster?: string; backdrop?: string; overview?: string } | null> {
  type Resp = {
    movie_results: Array<{ poster_path?: string; backdrop_path?: string; overview?: string }>;
    tv_results:    Array<{ poster_path?: string; backdrop_path?: string; overview?: string }>;
  };
  const r = await get<Resp>(`/find/${imdbID}`, { external_source: 'imdb_id' });
  if (!r) return null;
  const hit = r.movie_results[0] ?? r.tv_results[0];
  if (!hit) return null;
  return {
    poster: posterURL(hit.poster_path ?? null),
    backdrop: backdropURL(hit.backdrop_path ?? null),
    overview: hit.overview,
  };
}
