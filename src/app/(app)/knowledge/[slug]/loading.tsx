/** Mirrors the reader's own rhythm — headline, meta card, prose — on the real
 *  44px header height so the frame does not jump when the page lands. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="page-header border-border h-[2.75rem] shrink-0 border-b" />
    <div className="mx-auto w-full max-w-[45rem] px-4 py-6 sm:px-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="skeleton h-[1.375rem] w-3/5 rounded-md" />
        <div className="skeleton h-7 w-12 rounded-md" />
      </div>
      <div className="surface-card mb-6">
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="skeleton h-[1.125rem] w-16 rounded-full" />
          <div className="skeleton h-2 w-20 rounded-full" />
          <div className="skeleton h-[1.125rem] w-14 rounded-full" />
        </div>
        <div className="border-border/70 flex items-center gap-4 border-t px-3 py-2.5">
          <div className="skeleton h-2 w-24 rounded-full" />
          <div className="skeleton h-2 w-20 rounded-full" />
          <div className="skeleton h-2 w-28 rounded-full" />
        </div>
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="skeleton mb-3 h-2.5 rounded-full"
          style={{ width: `${90 - i * 12}%` }}
        />
      ))}
    </div>
  </div>
)

export default Loading
