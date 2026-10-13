import { linearRef, parseFooter } from './parse.mjs'

/**
 * Decides, from rows alone, what the backfill does with each task. Pure: the
 * database is read before and written after, never in here.
 *
 * @typedef {{ id: string, ref: string, description: string | null, external_ref: string | null, external_url: string | null }} TaskRow
 * @param {{ tasks: TaskRow[], heldRefs?: Iterable<string> }} input
 *   `heldRefs`: every external_ref already in the table, so a Linear id that a
 *   task already holds is refused here and not by the unique index.
 */
export const buildPlan = ({ tasks, heldRefs = [] }) => {
  const held = new Set([...heldRefs].map((r) => r.toLowerCase()))
  const skipped = []
  const multiple = []
  const candidates = []

  for (const task of tasks) {
    const footer = parseFooter(task.description)
    if (!footer) {
      skipped.push({ ref: task.ref, why: 'no-footer' })
      continue
    }
    if (footer.footers.length > 1) {
      multiple.push({ ref: task.ref, used: footer.key, found: footer.footers.map((f) => f.key) })
    }
    if (footer.urlKey && footer.urlKey !== footer.key) {
      skipped.push({ ref: task.ref, why: 'url-disagrees', detail: `${footer.key} in the text, ${footer.urlKey} in ${footer.url}` })
      continue
    }
    const wanted = linearRef(footer.key)
    if (task.external_ref) {
      skipped.push({
        ref: task.ref,
        why: task.external_ref === wanted ? 'already-set' : 'has-external-ref',
        detail: task.external_ref,
      })
      continue
    }
    candidates.push({ task, footer, external_ref: wanted })
  }

  const byRef = new Map()
  for (const c of candidates) byRef.set(c.external_ref, [...(byRef.get(c.external_ref) ?? []), c])

  const collisions = []
  const updates = []
  for (const [externalRef, group] of byRef) {
    if (group.length > 1) {
      collisions.push({ external_ref: externalRef, refs: group.map((c) => c.task.ref), held: false })
      for (const c of group) skipped.push({ ref: c.task.ref, why: 'collision', detail: externalRef })
    } else if (held.has(externalRef.toLowerCase())) {
      collisions.push({ external_ref: externalRef, refs: group.map((c) => c.task.ref), held: true })
      skipped.push({ ref: group[0].task.ref, why: 'held-elsewhere', detail: externalRef })
    } else {
      const [{ task, footer }] = group
      updates.push({
        id: task.id,
        ref: task.ref,
        external_ref: externalRef,
        external_url: task.external_url ? null : footer.url,
      })
    }
  }

  return { updates, skipped, collisions, multiple }
}
