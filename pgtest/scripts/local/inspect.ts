import { Client } from 'pg'
const c = new Client({ host: 'localhost', port: 5433, user: 'postgres', database: 'postgres' })
await c.connect()
const users = await c.query('select id, email, created_at from auth.users order by created_at')
console.log('auth.users:', users.rows)
const profiles = await c.query('select id, email, role from public.profiles')
console.log('profiles:', profiles.rows)
await c.end()
