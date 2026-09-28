'use client'

import { useDroppable } from '@dnd-kit/core'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'

/** One width for every board column, the drag overlay included. */
export const COLUMN_WIDTH = 'w-[17rem]'

/**
 * A lane: glass rather than a slab, so the canvas's light reaches the board.
 * A translucent face with a lit top edge, and — when the column has a colour
 * of its own, set as `--lane` — a hairline of it across the top that fades out
 * at both ends, with a little of its glow, and a wash of it that falls off
 * within the first cards. A column without `--lane` is just the glass.
 */
export const COLUMN_PANEL = cn(
  'relative flex shrink-0 snap-start flex-col rounded-lg border border-border',
  'bg-bg-elevated/55 shadow-[var(--highlight)]',
  'bg-[linear-gradient(180deg,color-mix(in_oklab,var(--lane,transparent)_7%,transparent),transparent_7rem)]',
  'before:pointer-events-none before:absolute before:inset-x-3 before:-top-px before:h-px before:rounded-full',
  'before:bg-[linear-gradient(90deg,transparent,var(--lane,transparent)_22%,var(--lane,transparent)_78%,transparent)]',
  'before:shadow-[0_0_10px_color-mix(in_oklab,var(--lane,transparent)_45%,transparent)]',
)

/** Sets a column's colour for COLUMN_PANEL's hairline and wash. */
export const laneTone = (color: string | undefined) =>
  color ? ({ '--lane': color } as React.CSSProperties) : undefined

export const ColumnCount = ({ count }: { count: number }) => (
  <span className="text-fg-subtle tabular ml-auto rounded-full bg-[color-mix(in_oklab,var(--fg)_6%,transparent)] px-1.5 text-[0.6875rem] leading-[1.125rem]">
    {count}
  </span>
)

/**
 * The drop target and its scroll box are the same element. dnd-kit measures
 * the visible rect of that node, so a list scrolled halfway still takes a
 * drop anywhere it is on screen, and cards scroll inside it rather than
 * stretching the page. Only a full-height column should contain its
 * overscroll (pass `overscroll-contain`): a capped lane cell has to hand the
 * wheel back so the board scrolls on to the next lane.
 *
 * `overflow-y-auto` makes overflow-x compute to `auto` too (the
 * overflow-auto-forces-both-axes trap), so this box clips anything a card
 * positions outside itself. A menu or popover on a card must render in a
 * portal, or it disappears here the way the bulk bar's menus once did.
 *
 * Under a dragged card the target lights: a dashed rim of the accent drawn as
 * an outline, so it costs no layout, over a faint accent wash.
 */
export const DropList = ({
  dropId,
  count,
  className,
  children,
}: {
  dropId: string
  count: number
  className?: string
  children: React.ReactNode
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col gap-1.5 overflow-y-auto rounded-md p-1.5',
        'outline-1 -outline-offset-1 outline-dashed',
        'transition-[background-color,outline-color] duration-[var(--dur-2)] ease-[var(--ease-out)]',
        isOver ? 'bg-accent-subtle/60 outline-accent/70' : 'outline-transparent',
        className,
      )}
    >
      {count === 0 ? (
        <EmptyState
          compact
          title={isOver ? 'Drop here' : 'Nothing here'}
          className={cn('min-h-14 flex-1', isOver && '[&>p]:text-accent')}
        />
      ) : (
        children
      )}
    </div>
  )
}

/**
 * The card in the hand: lifted off the board — a longer shadow, a degree and
 * a half of tilt, a little larger — with the accent catching its rim.
 */
export const DragPreview = ({ title }: { title: string }) => (
  <div
    className={cn(
      'border-accent/50 rounded-lg border bg-surface p-2.5',
      'bg-[linear-gradient(180deg,var(--card-top),var(--surface)_70%)]',
      'shadow-[var(--shadow-lg),var(--highlight),0_0_0_3px_color-mix(in_oklab,var(--accent)_12%,transparent)]',
      'rotate-[1.5deg] scale-[1.03] cursor-grabbing',
      COLUMN_WIDTH,
    )}
  >
    <p className="text-[0.8125rem] font-medium">{title}</p>
  </div>
)
