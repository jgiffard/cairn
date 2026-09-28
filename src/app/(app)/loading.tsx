/**
 * Shown while a server component streams. Skeleton rows sit on the same 36px
 * rhythm as the real list, and the header block matches the 44px breadcrumb
 * bar, so nothing shifts when content lands. The shapes shimmer rather than
 * pulse: a slow band of light across them, the way the rows will arrive.
 */
const Row = ({ i }: { i: number }) => (
  <div className="border-border flex h-[2.25rem] items-center gap-2 border-b px-3">
    <span className="skeleton size-3 shrink-0 rounded-sm" />
    <span className="skeleton h-2 w-[3.75rem] shrink-0 rounded-full opacity-70" />
    <span className="skeleton size-3 shrink-0 rounded-full" />
    <span
      className="skeleton h-2 rounded-full opacity-60"
      style={{ width: `${28 + ((i * 13) % 42)}%` }}
    />
  </div>
)

const Loading = () => (
  <div aria-busy="true">
    <div className="page-header border-border flex h-[2.75rem] items-center gap-2 border-b px-4">
      <span className="skeleton h-2.5 w-24 rounded-full" />
      <span className="skeleton h-2 w-16 rounded-full opacity-50" />
    </div>
    <div className="group-band border-border flex h-[2.125rem] items-center gap-2 border-b px-3">
      <span className="skeleton size-3 rounded-full" />
      <span className="skeleton h-2 w-20 rounded-full opacity-70" />
    </div>
    {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
      <Row key={i} i={i} />
    ))}
  </div>
)

export default Loading
