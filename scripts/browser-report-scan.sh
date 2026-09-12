#!/usr/bin/env bash
# Browser scan of every report page (logged-in temp admin) — finds the page
# the user reported erroring. Captures: uncaught page errors, console errors,
# and error-state text in the rendered UI.
set -u
SLUGS="sales product-sales categories payments gst profit current-stock valuation movements movers purchases suppliers customers expenses returns cash audit"
for slug in $SLUGS; do
  agent-browser open "http://localhost:3000/reports/$slug" >/dev/null 2>&1
  agent-browser wait --load networkidle >/dev/null 2>&1
  sleep 2.5
  errs=$(agent-browser errors --json 2>/dev/null | head -c 400)
  cerr=$(agent-browser console --json 2>/dev/null | tr ',' '\n' | grep -iE '"type":"error"|"level":"error"|error' | head -c 400)
  badtext=$(agent-browser snapshot -c 2>/dev/null | grep -iE 'went wrong|failed to load|error|denied|not have permission' | head -3)
  echo "=== /reports/$slug"
  echo "  page-errors: ${errs:-none}"
  echo "  console-err: ${cerr:-none}"
  echo "  ui-error   : ${badtext:-none}"
  agent-browser errors --clear >/dev/null 2>&1
  agent-browser console --clear >/dev/null 2>&1
done
echo "=== scan done"
