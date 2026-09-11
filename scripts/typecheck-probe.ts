/* Type-level probe: does Database satisfy supabase-js GenericSchema? */
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'

const c = createClient<Database>('http://localhost:54321', 'anon')
const profiles = c.from('profiles')
const rpcArgs = c.rpc('has_app_permission', { p: 'manage_users' })

export type ProbeProfiles = typeof profiles
export type ProbeRpc = typeof rpcArgs
