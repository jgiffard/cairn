/** Holds the 44px header and 42px filter bar so the frame does not jump. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="page-header border-border h-[2.75rem] shrink-0 border-b" />
    <div className="border-border h-[2.625rem] shrink-0 border-b" />
    <div className="flex-1 overflow-hidden">
      <div className="border-border flex h-[1.875rem] items-center border-b px-3 sm:px-4">
        <span className="skeleton h-2 w-16 rounded-full" />
      </div>
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="border-border/70 flex items-center gap-2.5 border-b px-3 py-2.5 sm:px-4">
          <span className="w-[0.8125rem] shrink-0" />
          <span className="skeleton h-2 w-[2.625rem] shrink-0 rounded-full" />
          <span className="skeleton size-[1.125rem] shrink-0 rounded-full" />
          <span className="skeleton h-2.5 rounded-full" style={{ width: `${64 - i * 5}%` }} />
          <span className="skeleton ml-auto h-[1.125rem] w-8 shrink-0 rounded-full opacity-70" />
        </div>
      ))}
    </div>
  </div>
)

export default Loading
