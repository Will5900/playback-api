#!/usr/bin/env bash
# Push and (re)deploy playback-api on the VPS.
#
# Prereqs (one-time):
#   1. ssh root@77.68.124.169 'mkdir -p /opt/playback-api'
#   2. Push this repo to GitHub, then on the VPS:
#        ssh root@77.68.124.169
#        cd /opt
#        git clone git@github.com:Will5900/playback-api.git
#        # or with HTTPS + PAT
#   3. Copy .env to /opt/playback-api/.env (POSTGRES_PASSWORD must match the
#      tonebreak-prod .env so we can share the Postgres container).
#   4. Add the api A record on Cloudflare (DNS only):
#        api.tonebreak.com → 77.68.124.169
#   5. Append deploy/Caddyfile.snippet to /opt/tonebreak-site/deploy/Caddyfile
#      and reload Caddy.
#   6. Bootstrap the database: bash /opt/playback-api/deploy/bootstrap-db.sh
#
# After that, this script just pulls and rebuilds.

set -euo pipefail
HOST="${PLAYBACK_API_HOST:-root@77.68.124.169}"

ssh "$HOST" "set -euo pipefail
cd /opt/playback-api
git pull --ff-only
docker compose -f docker-compose.prod.yml pull || true
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs --tail=40 api"
