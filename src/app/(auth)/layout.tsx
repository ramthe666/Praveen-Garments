/**
 * Public auth layout — a calm, focused canvas for the private sign-in flow.
 * No marketing, no signup: this is a staff-only application.
 * Retail theme: soft mint gradients echo the dashboard's emerald identity.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      {/* gentle emerald canvas glow */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-20 -left-24 h-64 w-64 rounded-full bg-teal-400/10 blur-3xl" />
        <div className="absolute -right-24 top-16 h-56 w-56 rounded-full bg-violet-400/10 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-accent/60 to-transparent" />
      </div>
      <main className="relative z-10 w-full max-w-sm">{children}</main>
    </div>
  )
}
