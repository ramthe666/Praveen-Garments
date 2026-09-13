#!/usr/bin/env bash
# Phase 8 canonical regression battery on the 0016 state.
# Fresh chain 0001 -> 0016, then every suite exactly ONCE, in canonical order.
# Prints per-suite summaries; exits non-zero if any suite fails.
set -u
cd /home/z/my-project
mkdir -p /tmp/p8logs

run_suite() {
  local name="$1"; shift
  bash scripts/run-with-db.sh "$@" > "/tmp/p8logs/${name}.log" 2>&1
  local rc=$?
  local summary
  summary=$(grep -E "^== RESULT" "/tmp/p8logs/${name}.log" | tail -1)
  echo "[$name] exit=$rc :: ${summary:-<no summary>}"
  if [ $rc -ne 0 ]; then
    grep -E "FAIL " "/tmp/p8logs/${name}.log" | head -8
  fi
  FAILED_TOTAL=$((FAILED_TOTAL + (rc > 0 ? 1 : 0)))
}

FAILED_TOTAL=0

echo "== fresh chain 0001 -> 0016 =="
bash scripts/run-with-db.sh scripts/local/reset-full.ts > /tmp/p8logs/reset.log 2>&1
echo "reset exit=$? :: $(grep -c '^APPLIED' /tmp/p8logs/reset.log) migrations applied"
tail -2 /tmp/p8logs/reset.log

run_suite audit1   scripts/local/test-audit1.ts
run_suite audit2   scripts/local/test-audit2.ts
run_suite audit3   scripts/local/test-audit3.ts
run_suite t0014    scripts/local/test-0014.ts
run_suite t0011    scripts/local/test-0011.ts

echo "SUITES_DONE_PART1 failed=$FAILED_TOTAL"
exit $FAILED_TOTAL
