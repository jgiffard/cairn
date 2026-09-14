export default function Loading() {
  return (
    <div className="flex h-dvh flex-col">
      <div className="border-border h-[2.75rem] shrink-0 border-b" />
      <div className="border-border h-[2.625rem] shrink-0 border-b" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex items-start gap-2.5 py-2.5">
            <div className="bg-surface h-3 w-[2.375rem] shrink-0 animate-pulse rounded" />
            <div className="bg-surface h-3 w-3 shrink-0 animate-pulse rounded" />
            <div className="bg-surface h-3 flex-1 animate-pulse rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
