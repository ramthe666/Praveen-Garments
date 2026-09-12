#!/bin/bash
# Phase 6 page tour: visit every route, capture page errors + console errors.
# Prereq: logged in as pg6-admin (browser session persists).
OUT=/home/z/my-project/Praveen-Garments/pgtest/page-tour.log
: > "$OUT"

ROUTES=(
  "/dashboard"
  "/pos"
  "/sales"
  "/customers"
  "/suppliers"
  "/purchases"
  "/expenses"
  "/payments"
  "/products"
  "/inventory"
  "/reports"
  "/users"
  "/settings"
  "/labels"
  "/products/attributes"
  "/reports/sales"
  "/reports/product-sales"
  "/reports/categories"
  "/reports/payments"
  "/reports/gst"
  "/reports/profit"
  "/reports/current-stock"
  "/reports/valuation"
  "/reports/movements"
  "/reports/movers"
  "/reports/purchases"
  "/reports/suppliers"
  "/reports/customers"
  "/reports/expenses"
  "/reports/returns"
  "/reports/cash"
  "/reports/audit"
)

for r in "${ROUTES[@]}"; do
  echo "=== $r ===" >> "$OUT"
  agent-browser open "http://localhost:3000$r" >/dev/null 2>&1
  sleep 4
  agent-browser wait --load networkidle >/dev/null 2>&1
  echo "URL: $(agent-browser get url 2>/dev/null)" >> "$OUT"
  echo "TITLE: $(agent-browser get title 2>/dev/null)" >> "$OUT"
  # horizontal overflow check
  agent-browser eval "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth" 2>/dev/null >> "$OUT"
  echo "" >> "$OUT"
  ERRS=$(agent-browser errors 2>/dev/null)
  if [ -n "$ERRS" ] && [ "$ERRS" != "No page errors" ] && [ "$ERRS" != "[]" ]; then
    echo "PAGE ERRORS:" >> "$OUT"
    echo "$ERRS" >> "$OUT"
  else
    echo "PAGE ERRORS: none" >> "$OUT"
  fi
  CONS=$(agent-browser console 2>/dev/null | grep -iE "error|warn" | grep -v "DevTools\|Download the React" | head -8)
  if [ -n "$CONS" ]; then
    echo "CONSOLE (error/warn):" >> "$OUT"
    echo "$CONS" >> "$OUT"
  else
    echo "CONSOLE: clean" >> "$OUT"
  fi
  # main content sanity: count visible main headings/text length
  agent-browser eval "document.querySelector('main') ? document.querySelector('main').innerText.length : -1" 2>/dev/null >> "$OUT"
  echo "" >> "$OUT"
  echo "---" >> "$OUT"
  agent-browser errors --clear >/dev/null 2>&1
  agent-browser console --clear >/dev/null 2>&1
done
echo "TOUR COMPLETE" >> "$OUT"
tail -5 "$OUT"
