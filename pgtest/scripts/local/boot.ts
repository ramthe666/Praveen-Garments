/**
 * Boots the embedded PostgreSQL server for the local harness on
 * localhost:5433 and keeps it running until killed.
 * Data lives in pgtest/data/ (gitignored). Run from pgtest/:
 *
 *   bun run scripts/local/boot.ts &
 */
import EmbeddedPostgres from 'embedded-postgres'

const pg = new EmbeddedPostgres({
  databaseDir: './data',
  user: 'postgres',
  password: 'postgres',
  port: 5433,
  persistent: true,
})

try {
  await pg.initialise()
  console.log('boot: initialised fresh cluster')
} catch {
  console.log('boot: reusing existing data dir')
}
await pg.start()
console.log('boot: embedded postgres listening on localhost:5433 (user postgres)')

// keep the process alive so the server stays up
setInterval(() => {}, 1 << 30)
