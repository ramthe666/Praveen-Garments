import { NextResponse } from 'next/server'

/** Liveness probe: app process + Supabase reachability. */
export async function GET() {
  let supabaseReachable = false
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`,
      { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! }, cache: 'no-store' }
    )
    supabaseReachable = res.ok
  } catch {
    supabaseReachable = false
  }

  return NextResponse.json(
    { status: 'ok', supabaseReachable, timestamp: new Date().toISOString() },
    { status: supabaseReachable ? 200 : 503 }
  )
}
