#!/usr/bin/env bash
# Phase 11 canonical regression battery on the 0017 state.
# Part A: one fresh chain (reset-full now includes 0017), canonical order.
set -u
cd /home/z/my-project
mkdir -p /tmp/p11logs

run_suite() {
  local name="$1"; shift
  bash scripts/run-with-db.sh "$@" > "/tmp/p11logs/${name}.log" 2>&1
  local rc=$?
  local summary
  summary=$(grep -E "^== RESULT|RESULT:|SUITE SUMMARY" "/tmp/p11logs/${name}.log" | tail -1)
  echo "[$name] exit=$rc :: ${summary:-<no summary>}"
  if [ $rc -ne 0 ]; then grep -E "FAIL " "/tmp/p11logs/${name}.log" | head -8; fi
  FAILED_TOTAL=$((FAILED_TOTAL + (rc > 0 ? 1 : 0)))
}

FAILED_TOTAL=0
echo "== fresh chain 0001 -> 0017 =="
bash scripts/run-with-db.sh scripts/local/reset-full.ts > /tmp/p11logs/reset.log 2>&1
echo "reset exit=$? :: $(grep -c '^APPLIED' /tmp/p11logs/reset.log) migrations applied"

run_suite audit1   scripts/local/test-audit1.ts
run_suite audit2   scripts/local/test-audit2.ts
run_suite audit3   scripts/local/test-audit3.ts
run_suite t0014    scripts/local/test-0014.ts
run_suite t0011    scripts/local/test-0011.ts
run_suite t0012    scripts/local/test-0012.ts
run_suite t0013    scripts/local/test-0013.ts

echo "PART_A_DONE failed=$FAILED_TOTAL"
exit $FAILED_TOTAL
