#!/usr/bin/env bash
# Quick diagnostic dump for playback-api.
# Run on the VPS:
#   bash /opt/playback-api/deploy/debug.sh
#
# Pulls the most-recently-seen device's install token out of Postgres and
# hits the in-memory request log + addon-state debug endpoints. Useful when
# the iOS app is misbehaving and you want to know what it's actually
# requesting without rebuilding the container or scraping pino logs.

set -euo pipefail

PG=$(docker ps --filter 'ancestor=postgres:16-alpine' --format '{{.Names}}' | head -n1)
if [ -z "${PG}" ]; then
  PG=$(docker ps --format '{{.Names}}' | grep -i postgres | head -n1)
fi
if [ -z "${PG}" ]; then
  echo "[debug] could not find a postgres container; running:"
  docker ps --format 'table {{.Names}}\t{{.Image}}'
  exit 1
fi
echo "[debug] postgres container: ${PG}"

TOKEN=$(docker exec "${PG}" psql -U playback -d playback -tAc \
  "SELECT install_token FROM devices ORDER BY last_seen_at DESC NULLS LAST LIMIT 1;" \
  | tr -d '[:space:]')
if [ -z "${TOKEN}" ]; then
  echo "[debug] no devices registered yet — open the iOS app first so it auto-registers."
  exit 1
fi
echo "[debug] using token prefix: ${TOKEN:0:8}..."

BASE='https://api.tonebreak.com'
H="x-install-token: ${TOKEN}"

echo
echo '=== healthz ==='
curl -fsS "${BASE}/healthz" || echo '(healthz failed)'
echo

echo
echo '=== 404s only (last 50) ==='
curl -fsS -H "${H}" "${BASE}/v1/_debug/recent?status=404&limit=50" \
  | jq '.requests[] | {method, path, durationMs}'

echo
echo '=== all recent (last 50) ==='
curl -fsS -H "${H}" "${BASE}/v1/_debug/recent?limit=50" \
  | jq '.requests[] | {method, path, status, durationMs}'

echo
echo '=== addons in DB ==='
curl -fsS -H "${H}" "${BASE}/v1/_debug/addons" \
  | jq '.addons[] | {name, manifestUrl, enabled, catalogCount: (.catalogs|length), firstCatalog: (.catalogs[0] // null)}'

echo
echo '=== /v1/catalogs (what the homepage should be querying) ==='
curl -fsS -H "${H}" "${BASE}/v1/catalogs" | jq '.catalogs'
