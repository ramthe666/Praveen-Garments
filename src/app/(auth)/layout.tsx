/**
 * Public auth layout — a calm, focused canvas for the private sign-in flow.
 * No marketing, no signup: this is a staff-only application.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      {/* subtle Zoho-style canvas texture */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-80 w-[42rem] -translate-x-1/2 rounded-full bg-primary/[0.05] blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-primary/[0.03] to-transparent" />
      </div>
      <main className="relative z-10 w-full max-w-sm">{children}</main>
    </div>
  )
}
