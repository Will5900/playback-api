-- Trakt OAuth tokens. One per device.
CREATE TABLE IF NOT EXISTS trakt_tokens (
  device_id      UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  username       TEXT,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One-time auth-state row per device while the OAuth dance is in flight.
-- The device starts a flow → we store nonce → user redirects via Trakt →
-- mobile callback hits /v1/me/trakt/exchange with code + nonce.
CREATE TABLE IF NOT EXISTS trakt_pending (
  nonce          TEXT PRIMARY KEY,
  device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS trakt_pending_device_idx ON trakt_pending(device_id);
