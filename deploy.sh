#!/bin/bash
set -e

echo "==> Staging & committing..."
git add -A
git commit -m "${1:-deploy}" --allow-empty 2>/dev/null || echo "(nothing new to commit)"

echo "==> Pushing to origin/main..."
git push origin main

echo "==> Deploying on VPS..."
ssh root@api.tonebreak.com "cd /opt/playback-api && git pull origin main && docker compose -f docker-compose.prod.yml build --no-cache && docker compose -f docker-compose.prod.yml up -d"

echo "==> Done!"
