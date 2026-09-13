#!/usr/bin/env bash
# Phase 8 helper: boot the embedded pg harness (if not already up), wait for
# readiness, run the given pgtest script, then stop the server cleanly.
# Data dir is persistent, so migrations/tests accumulate across invocations.
# Usage: bash scripts/run-with-db.sh scripts/local/test-0015.ts
set -u
cd /home/z/my-project/pgtest

TARGET="${1:-}"
shift || true

if ! (ss -ltn 2>/dev/null | grep -q ':5433'); then
  echo "[runner] starting embedded postgres..."
  PGPASSWORD=postgres bun run scripts/local/boot.ts > /tmp/pgboot.log 2>&1 &
  BOOT_PID=$!
  for i in $(seq 1 40); do
    if (ss -ltn 2>/dev/null | grep -q ':5433'); then break; fi
    sleep 0.5
  done
  if ! (ss -ltn 2>/dev/null | grep -q ':5433'); then
    echo "[runner] FAILED to start postgres; log:"
    tail -20 /tmp/pgboot.log
    kill $BOOT_PID 2>/dev/null
    exit 1
  fi
  echo "[runner] postgres up"
else
  echo "[runner] postgres already up"
fi

export PGPASSWORD=postgres
if [ -n "$TARGET" ]; then
  bun run "$TARGET" "$@"
  RC=$?
else
  RC=0
fi

# stop the server cleanly so the next runner starts fresh (data persists)
PGPASSWORD=postgres bun -e "
import { Client } from 'pg'
const c = new Client({ host: 'localhost', port: 5433, user: 'postgres', password: 'postgres' })
try { await c.connect(); await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()') ; await c.query('checkpoint'); } catch {} finally { await c.end().catch(()=>{}) }
" 2>/dev/null
pkill -f "embedded-postgres" 2>/dev/null
pkill -f "pgtest.*boot.ts" 2>/dev/null
sleep 0.5
exit $RC
