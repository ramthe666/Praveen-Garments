#!/bin/bash
# Phase 6 PRODUCTION-build console audit. Runs while prod server is up.
BASE=${1:-http://localhost:3001}
OUT=/home/z/my-project/Praveen-Garments/pgtest/prod-console.log
: > "$OUT"

echo "=== login ===" >> "$OUT"
agent-browser open "$BASE/login" >/dev/null 2>&1
sleep 3
agent-browser snapshot -i -c >/dev/null 2>&1
# refs change per page — use semantic locators for the login form
agent-browser find label "Email" fill "pg6-admin@praveengarments.com" >/dev/null 2>&1
agent-browser find label "Password" fill "Phase6Audit!2026" >/dev/null 2>&1
agent-browser find role button click --name "Sign in" >/dev/null 2>&1
sleep 5
echo "URL after login: $(agent-browser get url)" >> "$OUT"
agent-browser console --clear >/dev/null 2>&1
agent-browser errors --clear >/dev/null 2>&1

PAGES=(
  "/dashboard" "/pos" "/purchases" "/expenses" "/reports/payments"
  "/reports/current-stock" "/reports/movements" "/reports/sales" "/sales" "/settings"
  "/users" "/customers" "/payments" "/reports/gst" "/inventory"
)
for r in "${PAGES[@]}"; do
  for round in 1 2; do
    agent-browser open "$BASE$r" >/dev/null 2>&1
    sleep 4
    agent-browser wait --load networkidle >/dev/null 2>&1
    H=$(agent-browser console 2>/dev/null | grep -c "hydrated but some attributes")
    C=$(agent-browser console 2>/dev/null | grep -iE "^\[error\]|error:" | grep -vc "hydrated but some attributes" || true)
    E=$(agent-browser errors 2>/dev/null | head -1)
    TITLE=$(agent-browser get title 2>/dev/null)
    echo "$r (load $round): hydration=$H other_errors=$C page_errors='$E' title='$TITLE'" >> "$OUT"
    agent-browser console --clear >/dev/null 2>&1
    agent-browser errors --clear >/dev/null 2>&1
  done
done
echo "PROD TOUR COMPLETE" >> "$OUT"
cat "$OUT"