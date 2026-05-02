//
// Stremio addon protocol consumer.
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/README.md
//
// Manifests live at <addon-base>/manifest.json. Resources are reached via
// <addon-base>/<resource>/<type>/<id>[.json] with optional query string for
// catalog filters.
//

import { request } from 'undici';

export interface AddonManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  resources: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
  types: string[];
  idPrefixes?: string[];
  catalogs?: Array<{ id: string; type: string; name: string; extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }> }>;
  background?: string;
  logo?: string;
}

export interface StremioMetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: string[];
}

export interface StremioMeta extends StremioMetaPreview {
  videos?: Array<{
    id: string;
    title: string;
    season?: number;
    episode?: number;
    released?: string;
    overview?: string;
    thumbnail?: string;
  }>;
  runtime?: string;
  cast?: string[];
  director?: string[];
  writer?: string[];
  trailers?: Array<{ source: string; type: string }>;
}

export interface StremioStream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  behaviorHints?: {
    bingeGroup?: string;
    notWebReady?: boolean;
    proxyHeaders?: Record<string, Record<string, string>>;
  };
  // Common third-party annotations:
  size?: number;
  seeders?: number;
  qualityLabel?: string;
}

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
}

const TIMEOUT_MS = 8_000;

async function getJSON<T>(url: string): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const { statusCode, body } = await request(url, {
      method: 'GET',
      signal: ac.signal,
      headers: { 'user-agent': 'Playback/0.1' },
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`addon ${url}: HTTP ${statusCode}`);
    }
    return await body.json() as T;
  } finally {
    clearTimeout(t);
  }
}

/** Normalise a manifest URL — accept either bare base or full /manifest.json. */
export function manifestURL(input: string): string {
  const cleaned = input.trim().replace(/\/+$/, '');
  return cleaned.endsWith('/manifest.json') ? cleaned : `${cleaned}/manifest.json`;
}

export function baseURL(manifest: string): string {
  return manifest.replace(/\/manifest\.json$/, '');
}

export async function fetchManifest(input: string): Promise<{ url: string; manifest: AddonManifest }> {
  const url = manifestURL(input);
  const manifest = await getJSON<AddonManifest>(url);
  return { url, manifest };
}

export async function fetchCatalog(addonBase: string, type: string, id: string, extra: Record<string, string> = {}): Promise<{ metas: StremioMetaPreview[] }> {
  const qs = Object.entries(extra)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const tail = qs ? `/${qs}` : '';
  const url = `${addonBase}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}${tail}.json`;
  return getJSON(url);
}

export async function fetchMeta(addonBase: string, type: string, id: string): Promise<{ meta: StremioMeta }> {
  const url = `${addonBase}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  return getJSON(url);
}

export async function fetchStreams(addonBase: string, type: string, id: string): Promise<{ streams: StremioStream[] }> {
  const url = `${addonBase}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  return getJSON(url);
}

export async function fetchSubtitles(addonBase: string, type: string, id: string): Promise<{ subtitles: StremioSubtitle[] }> {
  const url = `${addonBase}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  return getJSON(url);
}

/** Whether this addon advertises the given resource. */
export function supportsResource(manifest: AddonManifest, resource: 'catalog' | 'stream' | 'meta' | 'subtitles', type?: string): boolean {
  const r = manifest.resources;
  for (const entry of r) {
    if (typeof entry === 'string') {
      if (entry === resource) return type ? manifest.types.includes(type) : true;
    } else if (entry.name === resource) {
      if (!type) return true;
      return entry.types ? entry.types.includes(type) : manifest.types.includes(type);
    }
  }
  return false;
}
