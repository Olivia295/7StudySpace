#!/bin/sh
# Run on the host; the timestamp never includes user input or credentials.
set -eu
cd "$(dirname "$0")"
docker compose exec -T app node scripts/backup-server.mjs \
  --data-dir /app/data \
  --output "/app/backups/$(date -u +%Y%m%dT%H%M%SZ)"
