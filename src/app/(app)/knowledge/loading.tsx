/** Holds the 44px header and filter bar so the frame does not jump. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="border-border h-[2.75rem] shrink-0 border-b" />
    <div className="border-border h-[2.625rem] shrink-0 border-b sm:h-[2.625rem]" />
    <div className="flex-1 animate-pulse">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="border-border border-b px-4 py-2.5">
          <div className="bg-surface-hover h-[0.8125rem] rounded" style={{ width: `${70 - i * 4}%` }} />
          <div className="bg-surface-hover mt-2 h-[0.6875rem] w-[30%] rounded opacity-60" />
        </div>
      ))}
    </div>
  </div>
)

export default Loading
