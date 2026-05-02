-- Initial schema for the Playback backend.
-- One row per registered iOS device. Tokens authenticate API calls.

CREATE TABLE IF NOT EXISTS devices (
  id              UUID PRIMARY KEY,
  install_token   TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  platform        TEXT NOT NULL DEFAULT 'ios',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ
);

-- Profiles live on the device but a denormalised mirror is kept here for
-- watch-state cross-device sync.
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  region          TEXT NOT NULL DEFAULT 'GB',
  age_rating      TEXT NOT NULL DEFAULT 'all',
  is_kids         BOOLEAN NOT NULL DEFAULT FALSE,
  taste_vector    JSONB,
  taste_confidence REAL NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS profiles_device_idx ON profiles(device_id);

-- Stremio addon manifests the user has installed. The backend re-fetches the
-- manifest periodically so the iOS app always sees fresh data.
CREATE TABLE IF NOT EXISTS addons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  manifest_url    TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         TEXT,
  description     TEXT,
  resources       JSONB NOT NULL,        -- ["catalog","stream","meta","subtitles"]
  types           JSONB NOT NULL,        -- ["movie","series","tv"]
  catalogs        JSONB,                  -- raw catalog list from manifest
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_fetched_at TIMESTAMPTZ,
  UNIQUE (device_id, manifest_url)
);
CREATE INDEX IF NOT EXISTS addons_device_enabled_idx ON addons(device_id, enabled);

-- Debrid tokens. Encrypted at rest in a future migration; for now plaintext
-- on a private server is acceptable.
CREATE TABLE IF NOT EXISTS debrid_tokens (
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('RD','AD','PM')),
  token           TEXT NOT NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, provider)
);

-- Watch state per (device, profile, content). Last-write-wins.
CREATE TABLE IF NOT EXISTS watch_events (
  id              BIGSERIAL PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  profile_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
  title_id        TEXT NOT NULL,                    -- imdb id, tmdb id, or addon-prefixed
  kind            TEXT NOT NULL CHECK (kind IN ('start','progress','finish')),
  position_sec    REAL,
  duration_sec    REAL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB
);
CREATE INDEX IF NOT EXISTS watch_events_device_title_idx ON watch_events(device_id, title_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS watch_events_profile_idx ON watch_events(profile_id, occurred_at DESC);

-- Saved/library titles (mirrors iOS SavedTitle).
CREATE TABLE IF NOT EXISTS saved_titles (
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  profile_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  poster_url      TEXT,
  year            INT,
  genre           TEXT,
  match_score     REAL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, title_id)
);
