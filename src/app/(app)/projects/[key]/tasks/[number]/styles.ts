/**
 * The one label style down the task page: every panel heading and every
 * sidebar section. Six panels and eight sections had drifted between two sizes
 * and two greys, which read as eight different kinds of thing.
 */
export const LABEL = 'text-fg-subtle text-[0.625rem] font-medium tracking-[0.08em] uppercase'

/** The count beside a label: a small stone of its own, not a trailing digit. */
export const COUNT =
  'bg-surface-raised text-fg-muted rounded-full px-1.5 py-px text-[0.625rem] leading-[1.4] font-medium tracking-normal normal-case tabular-nums'

/** A composer's shell: a flat card whose rim turns to the accent, doubled to 2px, while typing. */
export const COMPOSER =
  'surface-card overflow-hidden transition-[border-color,box-shadow] duration-[var(--dur-2)] ease-[var(--ease-out)] ' +
  'focus-within:border-accent focus-within:ring-1 focus-within:ring-accent'

/**
 * The properties column: a solid pane beside the canvas, set off by one
 * hairline down its inner edge.
 *
 * Deliberately no backdrop filter or transform: either would make this column
 * the containing block of the resolution dialog that opens from inside it.
 */
export const PANE = 'bg-bg-elevated border-border border-l'
