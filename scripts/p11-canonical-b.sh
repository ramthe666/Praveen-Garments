#!/usr/bin/env bash
# Phase 11 canonical regression battery — Part B: suites that need a FRESH
# chain each (0015, 0016, search-p3), then 0017 and the phase 9 workflow
# suite (both self-resetting).
set -u
cd /home/z/my-project
mkdir -p /tmp/p11logs

FAILED_TOTAL=0
fresh_suite() {
  local name="$1"; shift
  bash scripts/run-with-db.sh scripts/local/reset-full.ts > "/tmp/p11logs/reset-${name}.log" 2>&1
  local rrc=$?
  bash scripts/run-with-db.sh "$@" > "/tmp/p11logs/${name}.log" 2>&1
  local rc=$?
  local summary
  summary=$(grep -E "^== RESULT|RESULT:" "/tmp/p11logs/${name}.log" | tail -1)
  echo "[$name] reset=$rrc suite_exit=$rc :: ${summary:-<no summary>}"
  if [ $rc -ne 0 ]; then grep -E "FAIL " "/tmp/p11logs/${name}.log" | head -6; fi
  FAILED_TOTAL=$((FAILED_TOTAL + (rc > 0 ? 1 : 0)))
}
self_suite() {
  local name="$1"; shift
  bash scripts/run-with-db.sh "$@" > "/tmp/p11logs/${name}.log" 2>&1
  local rc=$?
  local summary
  summary=$(grep -E "^== RESULT|SUITE SUMMARY" "/tmp/p11logs/${name}.log" | tail -2 | tr '\n' ' ')
  echo "[$name] suite_exit=$rc :: ${summary:-<no summary>}"
  if [ $rc -ne 0 ]; then grep -E "FAIL " "/tmp/p11logs/${name}.log" | head -6; fi
  FAILED_TOTAL=$((FAILED_TOTAL + (rc > 0 ? 1 : 0)))
}

fresh_suite t0015    scripts/local/test-0015.ts
fresh_suite t0016    scripts/local/test-0016.ts
fresh_suite searchp3 scripts/local/test-search-p3.ts
self_suite  t0017    scripts/local/test-0017.ts
self_suite  phase9   scripts/local/test-phase9-workflow.ts

echo "PART_B_DONE failed=$FAILED_TOTAL"
exit $FAILED_TOTAL
