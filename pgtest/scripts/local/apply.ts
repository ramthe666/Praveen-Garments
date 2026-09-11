/**
 * Applies a migration .sql file to the local harness, statement-by-statement
 * where needed. Simple-protocol style: sends the whole file in one string
 * (mirrors how the Supabase SQL Editor executes a script).
 *
 * Run: bun run scripts/local/apply.ts <file.sql>
 */
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const file = process.argv[2]
if (!file) {
  console.error('usage: bun run scripts/local/apply.ts <file.sql>')
  process.exit(1)
}

const sql = readFileSync(file, 'utf8')
const c = new Client({ host: 'localhost', port: 5433, user: 'postgres', database: 'postgres' })
await c.connect()
try {
  await c.query(sql)
  console.log(`APPLIED OK: ${file}`)
} catch (e) {
  console.error(`FAILED: ${file}`)
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await c.end()
}
