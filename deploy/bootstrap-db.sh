#!/usr/bin/env bash
# Create the `playback` database + role on the existing tonebreak-prod
# Postgres container. Idempotent — safe to re-run.
#
# Run on the VPS:
#   bash /opt/playback-api/deploy/bootstrap-db.sh "$POSTGRES_PASSWORD"
# Where POSTGRES_PASSWORD is the same one in /opt/tonebreak-site/.env.

set -euo pipefail

PASS="${1:-${POSTGRES_PASSWORD:-}}"
if [[ -z "$PASS" ]]; then
  echo "Usage: $0 <postgres-password>"
  exit 1
fi

CTR="$(docker ps --filter 'name=tonebreak-prod-postgres' --format '{{.Names}}' | head -n1)"
if [[ -z "$CTR" ]]; then
  CTR="$(docker ps --filter 'ancestor=postgres:16-alpine' --format '{{.Names}}' | head -n1)"
fi
if [[ -z "$CTR" ]]; then
  echo "Could not locate the tonebreak postgres container."
  exit 1
fi
echo "Using container: $CTR"

docker exec -e PGPASSWORD="$PASS" "$CTR" psql -U tonebreak -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'playback') THEN
    CREATE ROLE playback LOGIN PASSWORD '${PASS}';
  END IF;
END
\$\$;
SELECT 'create database playback owner playback'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'playback')\\gexec
SQL

# pgcrypto for gen_random_uuid()
docker exec -e PGPASSWORD="$PASS" "$CTR" psql -U playback -d playback -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'

echo "playback database ready."
