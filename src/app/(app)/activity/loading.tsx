/** The trail's own rhythm — a day band, then time, stone, tile and two lines
 *  per event — on the real header and filter heights so nothing jumps. */
export default function Loading() {
  return (
    <div className="flex h-dvh flex-col">
      <div className="page-header border-border h-[2.75rem] shrink-0 border-b" />
      <div className="border-border h-[2.625rem] shrink-0 border-b" />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="border-border flex h-[2.125rem] items-center gap-2.5 border-b px-4">
          <span className="w-[2.375rem] shrink-0" />
          <span className="skeleton size-2 shrink-0 rounded-full" />
          <span className="skeleton h-2 w-40 rounded-full" />
        </div>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex items-start gap-2.5 px-4 py-2">
            <span className="skeleton mt-1 h-2 w-[2.375rem] shrink-0 rounded-full" />
            <span className="flex w-2 shrink-0 justify-center pt-2">
              <span className="skeleton h-1.5 w-2 rounded-full" />
            </span>
            <span className="skeleton mt-[1px] size-[1.25rem] shrink-0 rounded-md" />
            <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <span className="skeleton h-2.5 rounded-full" style={{ width: `${68 - (i % 5) * 9}%` }} />
              <span className="skeleton h-2 w-1/4 rounded-full opacity-70" />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
