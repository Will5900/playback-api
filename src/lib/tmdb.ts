//
// TMDB v3 API wrapper. Powers v2 content discovery (home, trending, search,
// genres, title detail). Also used by v1 meta enrichment via findByImdbID.
//

import { request } from 'undici';
import { env } from './env.js';
import { TTLCache } from './cache.js';

const cache = new TTLCache<unknown>(60 * 60 * 1000); // 1h
const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

// --- Image helpers ---

export function posterURL(path: string | null | undefined, size = 'w500'): string | undefined {
  if (!path) return undefined;
  return `${IMG}/${size}${path}`;
}

export function backdropURL(path: string | null | undefined, size = 'w1280'): string | undefined {
  if (!path) return undefined;
  return `${IMG}/${size}${path}`;
}

export function profileURL(path: string | null | undefined, size = 'w185'): string | undefined {
  if (!path) return undefined;
  return `${IMG}/${size}${path}`;
}

export function stillURL(path: string | null | undefined, size = 'w300'): string | undefined {
  if (!path) return undefined;
  return `${IMG}/${size}${path}`;
}

export function isConfigured(): boolean {
  return !!env.TMDB_API_KEY;
}

// --- Raw TMDB fetch ---

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

// --- V2 response types (match iOS DTOs — camelCase keys) ---

export interface V2Title {
  id: string;
  type: string;
  name: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  genres: string[] | null;
  rating: number | null;
  runtime: number | null;
  overview: string | null;
  imdbId: string | null;
  tmdbId: number;
}

export interface V2CastMember {
  id: number;
  name: string;
  character: string | null;
  profilePath: string | null;
}

export interface V2Video {
  id: string;
  title: string;
  season: number | null;
  episode: number | null;
  aired: string | null;
  overview: string | null;
  still: string | null;
  runtime: number | null;
}

export interface V2TitleDetail extends V2Title {
  tagline: string | null;
  cast: V2CastMember[] | null;
  similar: V2Title[] | null;
  videos: V2Video[] | null;
  certification: string | null;
  numberOfSeasons: number | null;
}

// --- TMDB raw types ---

interface TMDBMovie {
  id: number;
  title: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  release_date: string;
  vote_average: number;
  genre_ids?: number[];
  genres?: Array<{ id: number; name: string }>;
  runtime?: number;
  tagline?: string;
  imdb_id?: string;
}

interface TMDBTVShow {
  id: number;
  name: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  first_air_date: string;
  vote_average: number;
  genre_ids?: number[];
  genres?: Array<{ id: number; name: string }>;
  episode_run_time?: number[];
  tagline?: string;
  number_of_seasons?: number;
}

type TMDBResult = TMDBMovie & TMDBTVShow & { media_type?: string };

interface TMDBPagedResponse<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

interface TMDBGenre {
  id: number;
  name: string;
}

interface TMDBCastEntry {
  id: number;
  name: string;
  character?: string;
  profile_path?: string | null;
}

interface TMDBEpisode {
  id: number;
  name: string;
  season_number: number;
  episode_number: number;
  air_date: string | null;
  overview: string;
  still_path: string | null;
  runtime: number | null;
}

// --- Genre name cache (resolves genre_ids → names for list endpoints) ---

let genreMapMovie: Map<number, string> | null = null;
let genreMapTV: Map<number, string> | null = null;

async function loadGenreMap(type: 'movie' | 'tv'): Promise<Map<number, string>> {
  const cached = type === 'movie' ? genreMapMovie : genreMapTV;
  if (cached) return cached;
  const resp = await get<{ genres: TMDBGenre[] }>(`/genre/${type}/list`);
  const map = new Map((resp?.genres ?? []).map(g => [g.id, g.name]));
  if (type === 'movie') genreMapMovie = map;
  else genreMapTV = map;
  return map;
}

// --- Mappers ---

function yearFromDate(d: string | undefined | null): number | null {
  if (!d) return null;
  const y = parseInt(d.substring(0, 4), 10);
  return isNaN(y) ? null : y;
}

function mapDetail(r: TMDBResult, forceType?: 'movie' | 'series'): V2Title {
  const type = forceType ?? (r.media_type === 'tv' || (r.name && !r.title) ? 'series' : 'movie');
  const name = type === 'series' ? (r.name || r.title) : (r.title || r.name);
  const date = type === 'series' ? r.first_air_date : r.release_date;
  return {
    id: String(r.id),
    type,
    name: name || 'Untitled',
    year: yearFromDate(date),
    poster: posterURL(r.poster_path) ?? null,
    backdrop: backdropURL(r.backdrop_path) ?? null,
    genres: r.genres?.map(g => g.name) ?? null,
    rating: r.vote_average > 0 ? Math.round(r.vote_average * 10) / 10 : null,
    runtime: (type === 'movie' ? r.runtime : r.episode_run_time?.[0]) ?? null,
    overview: r.overview || null,
    imdbId: r.imdb_id ?? null,
    tmdbId: r.id,
  };
}

export async function mapListResult(r: TMDBResult, forceType?: 'movie' | 'series'): Promise<V2Title> {
  const type = forceType ?? (r.media_type === 'tv' || (r.name && !r.title) ? 'series' : 'movie');
  const name = type === 'series' ? (r.name || r.title) : (r.title || r.name);
  const date = type === 'series' ? r.first_air_date : r.release_date;

  let genreNames: string[] | null = null;
  if (r.genre_ids && r.genre_ids.length > 0) {
    const map = await loadGenreMap(type === 'series' ? 'tv' : 'movie');
    genreNames = r.genre_ids.map(id => map.get(id)).filter((n): n is string => !!n);
  } else if (r.genres) {
    genreNames = r.genres.map(g => g.name);
  }

  return {
    id: String(r.id),
    type,
    name: name || 'Untitled',
    year: yearFromDate(date),
    poster: posterURL(r.poster_path) ?? null,
    backdrop: backdropURL(r.backdrop_path) ?? null,
    genres: genreNames,
    rating: r.vote_average > 0 ? Math.round(r.vote_average * 10) / 10 : null,
    runtime: null,
    overview: r.overview || null,
    imdbId: null,
    tmdbId: r.id,
  };
}

// --- API methods ---

export async function trending(
  mediaType: 'movie' | 'tv' | 'all' = 'all',
  window: 'day' | 'week' = 'week',
): Promise<V2Title[]> {
  const resp = await get<TMDBPagedResponse<TMDBResult>>(`/trending/${mediaType}/${window}`);
  if (!resp) return [];
  return Promise.all(resp.results.map(r => mapListResult(r)));
}

export async function popular(type: 'movie' | 'tv'): Promise<V2Title[]> {
  const resp = await get<TMDBPagedResponse<TMDBResult>>(`/${type}/popular`);
  if (!resp) return [];
  const forceType = type === 'tv' ? 'series' : 'movie';
  return Promise.all(resp.results.map(r => mapListResult(r, forceType)));
}

export async function search(query: string, type?: 'movie' | 'tv'): Promise<V2Title[]> {
  const endpoint = type ? `/search/${type}` : '/search/multi';
  const resp = await get<TMDBPagedResponse<TMDBResult>>(endpoint, { query });
  if (!resp) return [];
  const filtered = resp.results.filter(r => {
    const mt = r.media_type ?? type;
    return mt === 'movie' || mt === 'tv';
  });
  const forceType = type === 'tv' ? 'series' : type === 'movie' ? 'movie' : undefined;
  return Promise.all(filtered.slice(0, 40).map(r => mapListResult(r, forceType)));
}

export async function genreList(type: 'movie' | 'tv'): Promise<TMDBGenre[]> {
  const resp = await get<{ genres: TMDBGenre[] }>(`/genre/${type}/list`);
  return resp?.genres ?? [];
}

export async function discover(
  type: 'movie' | 'tv',
  genreId: number,
  page: number = 1,
): Promise<{ titles: V2Title[]; page: number; totalPages: number }> {
  const resp = await get<TMDBPagedResponse<TMDBResult>>(`/discover/${type}`, {
    with_genres: String(genreId),
    sort_by: 'popularity.desc',
    page: String(page),
  });
  if (!resp) return { titles: [], page: 1, totalPages: 1 };
  const forceType = type === 'tv' ? 'series' : 'movie';
  const titles = await Promise.all(resp.results.map(r => mapListResult(r, forceType)));
  return { titles, page: resp.page, totalPages: Math.min(resp.total_pages, 500) };
}

export async function movieDetail(id: number): Promise<V2TitleDetail | null> {
  interface Resp extends TMDBMovie {
    credits?: { cast?: TMDBCastEntry[] };
    similar?: { results?: TMDBResult[] };
    release_dates?: {
      results?: Array<{
        iso_3166_1: string;
        release_dates: Array<{ certification: string }>;
      }>;
    };
  }
  const r = await get<Resp>(`/movie/${id}`, {
    append_to_response: 'credits,similar,release_dates',
  });
  if (!r) return null;

  const base = mapDetail(r as TMDBResult, 'movie');
  const cast = (r.credits?.cast ?? []).slice(0, 20).map(c => ({
    id: c.id,
    name: c.name,
    character: c.character ?? null,
    profilePath: profileURL(c.profile_path) ?? null,
  }));
  const similar = r.similar?.results
    ? await Promise.all(r.similar.results.slice(0, 12).map(s => mapListResult(s as TMDBResult, 'movie')))
    : null;
  const usRelease = r.release_dates?.results?.find(x => x.iso_3166_1 === 'US');
  const cert = usRelease?.release_dates?.find(rd => rd.certification)?.certification ?? null;

  return {
    ...base,
    tagline: r.tagline || null,
    cast: cast.length > 0 ? cast : null,
    similar: similar && similar.length > 0 ? similar : null,
    videos: null,
    certification: cert,
    numberOfSeasons: null,
  };
}

export async function tvDetail(id: number): Promise<V2TitleDetail | null> {
  interface Resp extends TMDBTVShow {
    credits?: { cast?: TMDBCastEntry[] };
    similar?: { results?: TMDBResult[] };
    content_ratings?: {
      results?: Array<{ iso_3166_1: string; rating: string }>;
    };
    external_ids?: { imdb_id?: string };
  }
  const r = await get<Resp>(`/tv/${id}`, {
    append_to_response: 'credits,similar,content_ratings,external_ids',
  });
  if (!r) return null;

  const base = mapDetail(r as unknown as TMDBResult, 'series');
  base.imdbId = r.external_ids?.imdb_id ?? null;

  const cast = (r.credits?.cast ?? []).slice(0, 20).map(c => ({
    id: c.id,
    name: c.name,
    character: c.character ?? null,
    profilePath: profileURL(c.profile_path) ?? null,
  }));
  const similar = r.similar?.results
    ? await Promise.all(r.similar.results.slice(0, 12).map(s => mapListResult(s as TMDBResult, 'series')))
    : null;
  const cert = r.content_ratings?.results?.find(x => x.iso_3166_1 === 'US')?.rating ?? null;

  let videos: V2Video[] | null = null;
  if (r.number_of_seasons && r.number_of_seasons > 0) {
    videos = await tvSeasonEpisodes(id, 1);
  }

  return {
    ...base,
    tagline: r.tagline || null,
    cast: cast.length > 0 ? cast : null,
    similar: similar && similar.length > 0 ? similar : null,
    videos,
    certification: cert,
    numberOfSeasons: r.number_of_seasons ?? null,
  };
}

export async function tvSeasonEpisodes(tvId: number, season: number): Promise<V2Video[] | null> {
  const resp = await get<{ episodes?: TMDBEpisode[] }>(`/tv/${tvId}/season/${season}`);
  if (!resp?.episodes) return null;
  return resp.episodes.map(ep => ({
    id: `${tvId}:${ep.season_number}:${ep.episode_number}`,
    title: ep.name,
    season: ep.season_number,
    episode: ep.episode_number,
    aired: ep.air_date,
    overview: ep.overview || null,
    still: stillURL(ep.still_path) ?? null,
    runtime: ep.runtime,
  }));
}

export async function externalIds(type: 'movie' | 'tv', id: number): Promise<{ imdbId?: string } | null> {
  const resp = await get<{ imdb_id?: string }>(`/${type}/${id}/external_ids`);
  if (!resp) return null;
  return { imdbId: resp.imdb_id };
}

export async function findByImdbID(
  imdbID: string,
): Promise<{ id?: number; type?: 'movie' | 'tv'; poster?: string; backdrop?: string; overview?: string } | null> {
  type Resp = {
    movie_results: Array<{ id: number; poster_path?: string; backdrop_path?: string; overview?: string }>;
    tv_results: Array<{ id: number; poster_path?: string; backdrop_path?: string; overview?: string }>;
  };
  const r = await get<Resp>(`/find/${imdbID}`, { external_source: 'imdb_id' });
  if (!r) return null;
  const movie = r.movie_results[0];
  if (movie) {
    return {
      id: movie.id,
      type: 'movie',
      poster: posterURL(movie.poster_path),
      backdrop: backdropURL(movie.backdrop_path),
      overview: movie.overview,
    };
  }
  const tv = r.tv_results[0];
  if (tv) {
    return {
      id: tv.id,
      type: 'tv',
      poster: posterURL(tv.poster_path),
      backdrop: backdropURL(tv.backdrop_path),
      overview: tv.overview,
    };
  }
  return null;
}
