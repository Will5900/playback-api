# playback-api

Backend for the Playback iOS app. Serves on `https://api.tonebreak.com`.

## Stack

- Node 22 + Fastify (TypeScript, ESM)
- Postgres 16 (shared with tonebreak.com on the same VPS)
- Stremio addon protocol consumer (no SDK dep — direct HTTP)
- Real-Debrid REST bridge (AllDebrid + Premiumize stubs)
- TMDB metadata enrichment (optional)
- OpenSubtitles REST fallback (optional)
- Caddy reverse proxy + auto-TLS (lives in the tonebreak compose stack)

## Routes

All under `/v1`, all require `x-install-token` header (any opaque ≥16 char string the iOS app generates once and stores in keychain).

| Method | Path | Purpose |
|---|---|---|
| GET  | `/healthz` | Liveness probe (no auth). |
| GET  | `/v1/me` | Device info + profile list. |
| POST | `/v1/me/profiles` | Upsert profile. |
| PATCH/DELETE | `/v1/me/profiles/:id` | Modify/remove. |
| GET  | `/v1/me/debrid` | List configured providers. |
| PUT/DELETE | `/v1/me/debrid/:provider` | Set/remove RD/AD/PM token. |
| GET  | `/v1/addons` | List installed Stremio addons. |
| POST | `/v1/addons` | Install by manifest URL. |
| PATCH/DELETE | `/v1/addons/:id` | Enable/disable, remove. |
| GET  | `/v1/search?q=` | Fan out across addons. |
| GET  | `/v1/meta/:type/:id` | Aggregated meta (TMDB-enriched). |
| GET  | `/v1/streams/:type/:id` | Aggregated streams, ranked, RD-cache flagged. |
| POST | `/v1/resolve` | Hoster URL/magnet → direct stream URL via debrid. |
| GET  | `/v1/subtitles/:type/:id` | Addon subs + OpenSubtitles fallback. |
| POST | `/v1/watch/events` | Append watch event (resume sync). |
| GET  | `/v1/watch/resume` | Latest progress per title. |
| GET/PUT/DELETE | `/v1/watch/saved/:titleId` | Library CRUD. |

## Local dev

```bash
npm install
cp .env.example .env             # set DATABASE_URL to a local postgres
npm run db:migrate
npm run dev                      # http://localhost:4000
```

## Deploy

See `deploy/deploy.sh` for the full bootstrap. Day-to-day:

```bash
bash deploy/deploy.sh
```
