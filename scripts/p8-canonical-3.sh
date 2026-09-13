#!/usr/bin/env bash
# Phase 8: run each Phase-8 suite on a FRESH chain (they assume a clean store).
set -u
cd /home/z/my-project
mkdir -p /tmp/p8logs

FAILED_TOTAL=0
fresh_suite() {
  local name="$1"; shift
  bash scripts/run-with-db.sh scripts/local/reset-full.ts > /tmp/p8logs/reset-${name}.log 2>&1
  local rrc=$?
  bash scripts/run-with-db.sh "$@" > "/tmp/p8logs/${name}.log" 2>&1
  local rc=$?
  local summary
  summary=$(grep -E "== RESULT|RESULT:" "/tmp/p8logs/${name}.log" | tail -1)
  echo "[$name] reset=$rrc suite_exit=$rc :: ${summary:-<no summary>}"
  if [ $rc -ne 0 ]; then grep -E "FAIL |CRASH|BUG-CONFIRMED" "/tmp/p8logs/${name}.log" | head -6; fi
  FAILED_TOTAL=$((FAILED_TOTAL + (rc > 0 ? 1 : 0)))
}

fresh_suite t0015    scripts/local/test-0015.ts
fresh_suite t0016    scripts/local/test-0016.ts
fresh_suite searchp3 scripts/local/test-search-p3.ts

echo "PHASE8_SUITES failed=$FAILED_TOTAL"
exit $FAILED_TOTAL
