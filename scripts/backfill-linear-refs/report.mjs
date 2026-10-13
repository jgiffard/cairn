const WHY = {
  'has-external-ref': 'already has a different external_ref (left alone)',
  'already-set': 'already carries this external_ref',
  collision: 'another task carries the same Linear id (neither set)',
  'held-elsewhere': 'a task outside this scan already holds this external_ref',
  'url-disagrees': 'the footer text and its URL name different issues',
}

/** `postgresql://user:pass@host:5432/db` without the password. */
export const maskUrl = (url) => {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '(not a URL)'
  }
}

const countBy = (items, get) => {
  const out = {}
  for (const item of items) out[get(item)] = (out[get(item)] ?? 0) + 1
  return out
}

export const buildReport = ({ mode, target, scope, scanned, plan, verification = null, errors = [] }) => {
  const withFooter = plan.skipped.filter((s) => s.why !== 'no-footer')
  return {
    mode,
    verdict: errors.length ? 'blocked' : mode === 'apply' ? 'applied' : 'ready',
    target: maskUrl(target),
    scope,
    errors,
    scanned,
    matched: withFooter.length + plan.updates.length,
    set: plan.updates.length,
    external_url_set: plan.updates.filter((u) => u.external_url).length,
    skipped: countBy(withFooter, (s) => s.why),
    skippedRows: withFooter,
    collisions: plan.collisions,
    multiple: plan.multiple,
    updates: plan.updates,
    verification,
  }
}

export const renderReport = (r) => {
  const verb = r.mode === 'apply' ? 'external_ref set' : 'external_ref would be set'
  const lines = [
    `backfill-linear-refs: ${r.mode}  ->  ${r.verdict}`,
    `  target   ${r.target}`,
    `  scope    ${r.scope.length ? `projects ${r.scope.join(', ')}` : 'every project'}`,
    '',
    `  ${'tasks scanned'.padEnd(26)}${r.scanned}`,
    `  ${'with an import footer'.padEnd(26)}${r.matched}`,
    `  ${verb.padEnd(26)}${r.set}   (external_url filled on ${r.external_url_set})`,
    `  ${'skipped'.padEnd(26)}${r.skippedRows.length}`,
  ]
  for (const [why, n] of Object.entries(r.skipped)) lines.push(`    ${String(n).padStart(5)}  ${WHY[why] ?? why}`)

  if (r.collisions.length) {
    lines.push('', 'Needs a human: one Linear id on more than one task, or already held. Nothing was set for these.')
    for (const c of r.collisions) {
      lines.push(`  ${c.external_ref}  ${c.refs.join(', ')}${c.held ? '  (already held by another task)' : ''}`)
    }
  }
  const existing = r.skippedRows.filter((s) => s.why === 'has-external-ref')
  if (existing.length) {
    lines.push('', 'Left alone, external_ref already set:')
    for (const s of existing) lines.push(`  ${s.ref}  ${s.detail}`)
  }
  const odd = r.skippedRows.filter((s) => s.why === 'url-disagrees')
  if (odd.length) {
    lines.push('', 'Footer text and URL disagree:')
    for (const s of odd) lines.push(`  ${s.ref}  ${s.detail}`)
  }
  if (r.multiple.length) {
    lines.push('', 'More than one footer; the last was used:')
    for (const m of r.multiple) lines.push(`  ${m.ref}  used ${m.used}, found ${m.found.join(', ')}`)
  }
  if (r.updates.length) {
    lines.push('', r.mode === 'apply' ? 'Set:' : 'Would set:')
    for (const u of r.updates) lines.push(`  ${u.ref.padEnd(14)} ${u.external_ref}`)
  }
  if (r.verification) {
    lines.push('', `updated_at unchanged on ${r.verification.checked} row(s): ${r.verification.ok ? 'yes' : 'NO'}`)
  }
  if (r.errors.length) {
    lines.push('', 'Blocked:')
    for (const e of r.errors) lines.push(`  ${e}`)
  }
  if (r.mode === 'dry-run' && !r.errors.length) lines.push('', 'Dry run: rolled back, nothing changed. Re-run with --apply to write.')
  return lines.join('\n')
}
