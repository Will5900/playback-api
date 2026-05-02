#!/usr/bin/env bash
# Install Cinemeta — the standard Stremio catalog provider — for the most
# recently active device. Run on the VPS:
#   bash /opt/playback-api/deploy/install-cinemeta.sh
#
# Idempotent: POST /v1/addons upserts on (device_id, manifest_url).

set -euo pipefail

PG=$(docker ps --filter 'ancestor=postgres:16-alpine' --format '{{.Names}}' | head -n1)
if [ -z "${PG}" ]; then
  PG=$(docker ps --format '{{.Names}}' | grep -i postgres | head -n1)
fi
[ -n "${PG}" ] || { echo 'no postgres container'; exit 1; }

TOKEN=$(docker exec "${PG}" psql -U playback -d playback -tAc \
  "SELECT install_token FROM devices ORDER BY last_seen_at DESC NULLS LAST LIMIT 1;" \
  | tr -d '[:space:]')
[ -n "${TOKEN}" ] || { echo 'no devices in DB'; exit 1; }
echo "[install-cinemeta] using token prefix: ${TOKEN:0:8}..."

BASE='https://api.tonebreak.com'
MANIFEST='https://v3-cinemeta.strem.io/manifest.json'

echo "[install-cinemeta] POST ${BASE}/v1/addons"
RESP=$(curl -fsS -X POST \
  -H "x-install-token: ${TOKEN}" \
  -H 'content-type: application/json' \
  --data "{\"manifestUrl\":\"${MANIFEST}\"}" \
  "${BASE}/v1/addons")

echo
echo '=== install response ==='
echo "${RESP}" | jq '{id, name: .manifest.name, version: .manifest.version, catalogCount: (.manifest.catalogs | length), catalogs: (.manifest.catalogs | map({type, id, name}))}'

echo
echo '=== /v1/catalogs after install ==='
curl -fsS -H "x-install-token: ${TOKEN}" "${BASE}/v1/catalogs" | jq '.catalogs'
