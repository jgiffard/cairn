import Link from 'next/link'

const NotFound = () => (
  <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
    <div className="flex flex-col gap-1.5">
      <h1 className="text-fg text-[0.9375rem] font-medium">Nothing here.</h1>
      <p className="text-fg-muted max-w-[42ch] text-[0.8125rem] leading-relaxed">
        That task or project does not exist, or it was deleted.
      </p>
    </div>
    <Link
      href="/"
      className="border-border text-fg-muted hover:bg-surface-hover hover:text-fg h-[1.875rem] rounded-md border px-3.5 text-[0.8125rem] leading-[1.75rem] transition-colors"
    >
      Back to all tasks
    </Link>
  </div>
)

export default NotFound
