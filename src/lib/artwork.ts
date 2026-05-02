//
// Artwork normalizer. Different sources speak different dialects:
//   - Stremio meta:        poster / background
//   - TMDB:                poster_path / backdrop_path (relative)
//   - RD library response: poster / backdrop
//   - Saved-titles row:    poster_url
//
// iOS expects a single Codable shape, so every homepage-y endpoint runs its
// items through `normalizeArtwork`. URLs are forced to HTTPS (iOS ATS blocks
// plain HTTP), and when both poster and backdrop are missing for an
// IMDB-id-shaped titleId we try a single cached TMDB /find call to backfill.
//

import { findByImdbID } from './tmdb.js';

export interface NormalizedArtwork {
  posterURL?: string;
  backdropURL?: string;
  // Legacy aliases kept so older Codable structs that decoded `poster` /
  // `backdrop` / `background` continue to bind. All four fields point at the
  // same URL when present.
  poster?: string;
  backdrop?: string;
  background?: string;
}

/** Force an absolute http:// URL to https://. Pass through https/relative/empty. */
export function httpsify(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('http://')) return 'https://' + trimmed.slice(7);
  return trimmed;
}

interface EnrichInput {
  titleId?: string;
  poster?: string | null;
  backdrop?: string | null;
  background?: string | null;
  posterURL?: string | null;
  backdropURL?: string | null;
}

/**
 * Pick the best poster + backdrop URL we have, in priority order:
 *   posterURL → poster
 *   backdropURL → backdrop → background
 * Backfill from TMDB (cached) only when both are missing AND titleId looks
 * like an IMDB id. Returns the iOS-shaped object with all alias fields set.
 */
export async function normalizeArtwork(input: EnrichInput): Promise<NormalizedArtwork> {
  let posterURL = httpsify(input.posterURL ?? input.poster);
  let backdropURL = httpsify(input.backdropURL ?? input.backdrop ?? input.background);

  if ((!posterURL || !backdropURL) && input.titleId && /^tt\d+/.test(input.titleId)) {
    // Strip episode suffix (tt1234567:1:5 → tt1234567).
    const imdb = input.titleId.split(':')[0]!;
    try {
      const hit = await findByImdbID(imdb);
      if (hit) {
        posterURL = posterURL ?? httpsify(hit.poster);
        backdropURL = backdropURL ?? httpsify(hit.backdrop);
      }
    } catch {
      // Don't let TMDB hiccups break the response.
    }
  }

  return {
    posterURL,
    backdropURL,
    poster: posterURL,
    backdrop: backdropURL,
    background: backdropURL,
  };
}

/** Sync variant — no TMDB lookup. Use when title id won't help (e.g. RD downloads). */
export function normalizeArtworkSync(input: EnrichInput): NormalizedArtwork {
  const posterURL = httpsify(input.posterURL ?? input.poster);
  const backdropURL = httpsify(input.backdropURL ?? input.backdrop ?? input.background);
  return {
    posterURL,
    backdropURL,
    poster: posterURL,
    backdrop: backdropURL,
    background: backdropURL,
  };
}
