/**
 * Syntax-validate Phase 2 migration SQL files with the real Postgres parser
 * (libpg_query) so the user's manual application in the Supabase SQL Editor
 * cannot fail on a syntax error.
 */
import { readFileSync } from 'node:fs'
import { parse } from 'pgsql-parser'

const files = [
  'supabase/migrations/0004_products_catalog.sql',
  'supabase/migrations/0005_inventory_stock.sql',
  'supabase/migrations/0006_product_images_storage.sql',
]

let failed = false
for (const f of files) {
  const sql = readFileSync(f, 'utf8')
  try {
    const stmts = parse(sql)
    console.log(`OK   ${f} — ${Array.isArray(stmts) ? stmts.length : '?'} statements parsed`)
  } catch (e: any) {
    failed = true
    console.log(`FAIL ${f}`)
    console.log('     ', String(e.message ?? e).slice(0, 500))
  }
}
process.exit(failed ? 1 : 0)
