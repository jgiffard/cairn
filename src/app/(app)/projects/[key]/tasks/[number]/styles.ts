import type { CSSProperties } from 'react'

/**
 * The one label style down the task page: every panel heading and every
 * sidebar section. Six panels and eight sections had drifted between two sizes
 * and two greys, which read as eight different kinds of thing.
 */
export const LABEL = 'text-fg-subtle text-[0.625rem] font-medium tracking-[0.08em] uppercase'

/** The count beside a label: a small stone of its own, not a trailing digit. */
export const COUNT =
  'bg-surface-raised text-fg-muted rounded-full px-1.5 py-px text-[0.625rem] leading-[1.4] font-medium tracking-normal normal-case tabular-nums'

/** A composer's shell: a card whose rim lights, with a halo, while typing. */
export const COMPOSER =
  'surface-card overflow-hidden transition-[border-color,box-shadow] duration-[var(--dur-2)] ease-[var(--ease-out)] ' +
  'focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_22%,transparent),var(--shadow-sm)]'

/**
 * The properties column: a pane of the canvas rather than a slab over it — a
 * shade lifted, lit faintly from the top corner as the sidebar is, with a
 * hairline down its inner edge that fades out at both ends like the header's.
 *
 * Deliberately no backdrop-filter: it would make this column the containing
 * block of the resolution dialog that opens from inside it.
 */
export const GLASS: CSSProperties = {
  background: [
    'linear-gradient(180deg, transparent, var(--border-strong) 10%, var(--border-strong) 90%, transparent) left / 1px 100% no-repeat',
    'radial-gradient(140% 200px at 0% 0%, var(--aurora-far), transparent 70%)',
    'color-mix(in oklab, var(--bg-elevated) 50%, transparent)',
  ].join(', '),
}
