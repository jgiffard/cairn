/**
 * The report a person reads before saying yes: plain text, or the same as JSON.
 */
import { LEFT_ALONE } from './catalog.mjs'

const pad = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)))
  return rows.map((r) => `  ${r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')}`.trimEnd())
}

export const renderReport = (r) => {
  const out = []
  const line = (s = '') => out.push(s)
  const verdict = { blocked: 'BLOCKED', 'dry-run': 'DRY RUN (rolled back)', applied: 'APPLIED' }[r.verdict] ?? r.verdict
  line(`Project move: ${verdict}`)
  line(`  source  ${r.source}`)
  line(`  target  ${r.target}`)
  if (r.errors.length) {
    line()
    line('Blocked:')
    for (const e of r.errors) line(`  - ${e}`)
  }
  if (r.warnings.length) {
    line()
    line('Warnings:')
    for (const w of r.warnings) line(`  - ${w}`)
  }
  if (r.projects && r.perProject) {
    line()
    line(`Moving ${r.projects.moving.length} project(s), keeping ${r.projects.staying.join(', ')}:`)
    const cols = ['key', 'status', 'counter', 'tasks', 'notes', 'comments', 'attachments', 'events', 'deps', 'subtasks', 'task_projects', 'mentions', 'sessions', 'file_touches', 'knowledge_moved', 'knowledge_copied', 'repos', 'former_keys', 'entity_links']
    const head = ['key', 'status', 'ctr', 'tasks', 'notes', 'cmts', 'files', 'events', 'deps', 'subs', 'also', 'ment', 'sess', 'touches', 'kn', 'kn+', 'repos', 'fkeys', 'ents']
    const total = Object.fromEntries(cols.map((c) => [c, 0]))
    for (const p of r.perProject) for (const c of cols.slice(2)) total[c] += p[c]
    out.push(...pad([head, ...r.perProject.map((p) => cols.map((c) => p[c])), ['total', '', ...cols.slice(2).map((c) => total[c])]]))
  }
  if (r.tables) {
    line()
    line('Rows per table (read from the source, written to the target):')
    out.push(...pad([['table', 'read', 'written', 'detail'], ...Object.entries(r.tables).map(([t, v]) => [t, v.read, v.written, [v.matched != null ? `${v.matched} matched by key` : '', v.merged ? `${v.merged} merged into the target's row` : '', v.links ? `${v.links} sub-task/duplicate links` : '', v.superseded_links ? `${v.superseded_links} superseded links` : ''].filter(Boolean).join('; ')])]))
    line('  not copied: ' + LEFT_ALONE.map(([t, why]) => `${t} (${why})`).join('; '))
  }
  if (r.mirrors) {
    line()
    line(`Lab mirrors merged into the real task (${r.mirrors.merged.length}):`)
    const byProject = {}
    for (const m of r.mirrors.merged) (byProject[m.mirror.split('-')[0]] ??= []).push(`${m.mirror}->${m.real}`)
    for (const [k, list] of Object.entries(byProject)) line(`  ${k}: ${list.join(', ')}`)
    if (r.mirrors.counts) line(`  carried: ${Object.entries(r.mirrors.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    if (r.mirrors.untouched.length) {
      line('  left alone:')
      for (const u of r.mirrors.untouched) line(`    ${u.ref} -> ${u.points_at}: ${u.why}`)
    } else line('  none point at a project that stays')
    if (r.mirrors.renumbered.length) line(`  renumbered: ${r.mirrors.renumbered.map((x) => `${x.from}->${x.to}`).join(', ')}`)
  }
  if (r.rewrites) {
    line()
    line('Mirror refs in the target text:')
    const modes = r.rewrites.summary.byMode
    if (!Object.keys(modes).length) line('  none')
    for (const [mode, v] of Object.entries(modes)) {
      const why = { origin: 'rebuilt from the Croft origin (exact)', ambiguous: 'no unedited origin: every mirror ref rewritten, check by eye' }[mode] ?? mode
      line(`  ${mode}: ${v.refs} ref(s) in ${v.fields} field(s), ${why}`)
    }
    for (const f of r.rewrites.fields.filter((x) => x.mode === 'ambiguous')) {
      line(`    ${f.owner} ${f.table}.${f.field}: ${f.changes.map((c) => `${c.from}->${c.to}`).join(', ')}`)
    }
    const sample = r.rewrites.fields.filter((x) => x.mode === 'origin').slice(0, 12)
    if (sample.length) {
      line('  sample of exact rewrites:')
      for (const f of sample) line(`    ${f.owner} ${f.table}.${f.field}: ${f.changes.map((c) => `${c.from}->${c.to}`).join(', ')}`)
    }
  }
  if (r.knowledge) {
    line()
    line(`Knowledge: ${Object.entries(r.knowledge.scopes).map(([k, v]) => `${k} ${v}`).join(', ')} (move and copy go to the target; global and stay remain)`)
  }
  if (r.sessions) line(`Sessions: ${r.sessions.moving} move (${r.sessions.clash} also on the target), ${r.sessions.staying} stay`)
  if (r.crossing) {
    const c = r.crossing
    line()
    line('Links across the line (cannot survive on either side):')
    for (const p of c.parents) line(`  sub-task ${p.child} of ${p.parent}: link dropped, note on the child`)
    for (const d of c.duplicates) line(`  ${d.task} duplicate of ${d.duplicate_of}: link dropped`)
    for (const a of c.alsoIn) line(`  ${a.task} also in ${a.also}: link dropped, note on the task`)
    for (const d of c.deps) line(`  ${d.blocked} blocked by ${d.blocking}: dependency dropped`)
    line(`  mentions: ${c.mentions.within} within the move (rebuilt on the target), ${c.mentions.move_to_stay} from moving to staying tasks, ${c.mentions.stay_to_move} from staying to moving (both lost)`)
    line(`  global or staying knowledge sourced from moving work: ${c.knowledgeSourcedFromMoving.tasks} by task (link lost), ${c.knowledgeSourcedFromMoving.sessions} by session (kept by name)`)
    line(`  moving knowledge sourced from a staying session: ${c.movedKnowledgeFromStayingSession} (kept by name)`)
    for (const s of c.supersededAcross) line(`  knowledge ${s.slug} (${s.scope}) superseded by ${s.successor} (${s.successor_scope})`)
  }
  if (r.files) {
    line()
    line(`Attachments: ${r.files.count} file(s), ${r.files.bytes} bytes, same storage paths; ${r.files.checked ? 'read and checked against size and sha256' : 'NOT checked (no source store given)'}${r.files.copied != null ? `; ${r.files.copied} copied` : ''}`)
  }
  if (r.written) {
    line()
    line(`Other changes: target ${r.written.urls} link(s) moved to the target host, mentions rebuilt (${r.written.mentions?.task_mentions} task, ${r.written.mentions?.subject_mentions} subject)`)
    for (const note of r.written.notes ?? []) line(`  ${note}`)
  }
  if (r.removed) {
    line(`Source: deleted ${Object.entries(r.removed.deleted).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    line(`        updated ${Object.entries(r.removed.updated).map(([k, v]) => `${k} ${v}`).join(', ')}; ${r.removed.notes} note(s) on staying tasks`)
  }
  if (r.verification) {
    line()
    line('Checked before commit:')
    for (const c of r.verification) line(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
  }
  if (r.commit) {
    line()
    line(`Commit: ${r.commit}`)
  }
  return out.join('\n')
}
