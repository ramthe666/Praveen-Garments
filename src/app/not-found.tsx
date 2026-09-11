import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true">
        <FileQuestion className="size-7" />
      </span>
      <div>
        <h1 className="text-lg font-semibold text-foreground">Page not found</h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          The page you were looking for doesn&apos;t exist or may have moved.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    </div>
  )
}
