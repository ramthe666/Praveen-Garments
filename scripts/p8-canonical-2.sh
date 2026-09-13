#!/usr/bin/env bash
# Phase 8 canonical regression battery — part 2 (continues on part 1 state).
set -u
cd /home/z/my-project
mkdir -p /tmp/p8logs

run_suite() {
  local name="$1"; shift
  bash scripts/run-with-db.sh "$@" > "/tmp/p8logs/${name}.log" 2>&1
  local rc=$?
  local summary
  summary=$(grep -E "== RESULT|RESULT:" "/tmp/p8logs/${name}.log" | tail -1)
  echo "[$name] exit=$rc :: ${summary:-<no summary>}"
  if [ $rc -ne 0 ]; then
    grep -E "FAIL " "/tmp/p8logs/${name}.log" | head -8
  fi
  FAILED_TOTAL=$((FAILED_TOTAL + (rc > 0 ? 1 : 0)))
}

FAILED_TOTAL=0
run_suite t0012 scripts/local/test-0012.ts
run_suite t0013 scripts/local/test-0013.ts
run_suite t0015 scripts/local/test-0015.ts
run_suite t0016 scripts/local/test-0016.ts
run_suite searchp3 scripts/local/test-search-p3.ts

echo "SUITES_DONE_PART2 failed=$FAILED_TOTAL"
exit $FAILED_TOTAL
