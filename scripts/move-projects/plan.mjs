/**
 * The rules of a project move (CAIRN-385), as pure functions of what the two
 * instances hold. No database here: read.mjs gathers the facts, write.mjs
 * carries the decisions out, and the unit tests drive these directly.
 */
import { scanRefs } from '../import-croft/refs.mjs'

const KEY = /^[A-Z][A-Z0-9]{1,9}$/
const TASK_REF = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/

export const parseKeys = (value) =>
  (Array.isArray(value) ? value.join(',') : (value ?? ''))
    .split(/[\s,]+/)
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean)

export const trimBase = (url) => (url ?? '').trim().replace(/\/+$/, '')

/**
 * Which source projects move. Everything not kept moves; an active project
 * that is neither kept nor named in `move` stops the run, because it is most
 * likely one somebody made today and nobody decided about.
 */
export const chooseProjects = ({ projects, keep, move }) => {
  const errors = []
  const warnings = []
  const keepSet = new Set(keep)
  const moveSet = new Set(move)
  for (const k of [...keep, ...move]) if (!KEY.test(k)) errors.push(`"${k}" is not a project key`)
  for (const k of keep) if (moveSet.has(k)) errors.push(`${k} is both kept and moved`)
  const byKey = new Map(projects.map((p) => [p.key, p]))
  for (const k of keep) if (!byKey.has(k)) errors.push(`--keep names ${k}, which the source does not have`)
  for (const k of move) if (!byKey.has(k)) errors.push(`--move names ${k}, which the source does not have`)

  const moving = []
  const staying = []
  const unnamed = []
  for (const p of [...projects].sort((a, b) => a.key.localeCompare(b.key))) {
    if (keepSet.has(p.key)) staying.push(p)
    else {
      moving.push(p)
      if (!moveSet.has(p.key)) unnamed.push(p)
    }
  }
  for (const p of unnamed) {
    if (p.status === 'archived') warnings.push(`${p.key} is archived and not kept, so it moves too`)
    else errors.push(`${p.key} (${p.status}) is neither kept nor named in --move: decide about it first`)
  }
  if (!moving.length) errors.push('nothing would move')
  return { moving, staying, unnamed, errors, warnings }
}

/**
 * Source users matched to target users by email. Only a person the moving rows
 * name needs an account on the target: the source can be a shared instance
 * whose other members never had one there, and nothing of theirs moves.
 * `referenced` maps a source user id to how many moving rows name it.
 */
export const matchUsers = ({ sourceUsers, targetUsers, referenced }) => {
  const errors = []
  const warnings = []
  const byEmail = new Map(targetUsers.map((u) => [u.email, u.id]))
  const users = sourceUsers.map((u) => ({ ...u, target_id: byEmail.get(u.email) ?? null }))
  for (const u of users) {
    if (u.target_id) continue
    const rows = referenced.get(u.id) ?? 0
    if (rows) errors.push(`${u.email} has no account on the target and ${rows} moving row(s) name them: users are matched by email`)
    else warnings.push(`${u.email} has no account on the target; nothing that moves names them`)
  }
  return { users: users.filter((u) => u.target_id), errors, warnings }
}

/**
 * A hand-off mirror: a target task that stands for a source task (`cairn`
 * tracker, its URL on the source instance). Mirrors of moving tasks are
 * merged into the real task; the rest are reported and left alone.
 */
export const findMirrors = ({ targetTasks, sourceBaseUrl, movingKeys, sourceTasksByRef }) => {
  const base = trimBase(sourceBaseUrl)
  const moving = new Set(movingKeys)
  const mirrors = []
  const untouched = []
  const errors = []
  for (const t of targetTasks) {
    if (t.handoff_tracker !== 'cairn' || !t.handoff_ref) continue
    const url = t.handoff_url ?? ''
    const onSource = url.startsWith(`${base}/`)
    if (!onSource) continue
    const m = TASK_REF.exec(t.handoff_ref)
    if (!m) {
      untouched.push({ ref: t.ref, points_at: t.handoff_ref, why: 'its hand-off ref is not KEY-n' })
      continue
    }
    const target = `${m[1]}-${Number(m[2])}`
    if (!moving.has(m[1])) {
      untouched.push({ ref: t.ref, points_at: target, why: 'it points at a project that stays' })
      continue
    }
    const real = sourceTasksByRef.get(target)
    if (!real) {
      errors.push(`${t.ref} mirrors ${target}, which the source does not have`)
      continue
    }
    mirrors.push({
      id: t.id,
      ref: t.ref,
      project_id: t.project_id,
      subject_id: t.subject_id ?? null,
      subject_number: t.subject_number ?? null,
      external_ref: t.external_ref ?? null,
      real_ref: target,
      real_id: real.id,
      real_project_id: real.project_id,
    })
  }
  const byReal = new Map()
  for (const m of mirrors) {
    const seen = byReal.get(m.real_id)
    if (seen && seen.subject_id && m.subject_id && seen.subject_id !== m.subject_id) {
      errors.push(`${seen.ref} and ${m.ref} both mirror ${m.real_ref} but sit under different subjects`)
    }
    if (!seen) byReal.set(m.real_id, m)
  }
  return { mirrors, untouched, errors }
}

/**
 * Target projects whose key a moving project needs. Each is replaced by the
 * real one: its mirrors merge, any other task is renumbered after the real
 * project's last number, and its subjects and events follow.
 */
export const planCollisions = ({ targetProjects, targetTasks, mirrors, movingProjects, formerKeys = [] }) => {
  const errors = []
  const byKey = new Map(movingProjects.map((p) => [p.key, p]))
  const mirrorIds = new Set(mirrors.map((m) => m.id))
  const collisions = []
  for (const tp of targetProjects) {
    const real = byKey.get(tp.key)
    if (!real) continue
    const others = targetTasks
      .filter((t) => t.project_id === tp.id && !mirrorIds.has(t.id))
      .sort((a, b) => a.number - b.number)
    let next = real.task_counter
    const renumber = others.map((t) => {
      next += 1
      return { id: t.id, from: `${tp.key}-${t.number}`, to: `${tp.key}-${next}`, number: next }
    })
    collisions.push({
      id: tp.id,
      key: tp.key,
      real_id: real.id,
      temp_key: null,
      renumber,
      counter_after: next,
    })
  }
  // Keys the moving projects retired (former keys) must be free on the target too.
  const targetKeys = new Set(targetProjects.map((p) => p.key))
  for (const f of formerKeys) {
    if (targetKeys.has(f.key)) errors.push(`former key ${f.key} of ${f.project_key} is a live project key on the target`)
  }
  return { collisions, errors }
}

/** A free key for parking a target project while its replacement goes in. */
export const tempKey = (key, taken) => {
  for (let i = 1; i < 1000; i++) {
    const k = `ZZ${i}${key}`.slice(0, 10)
    if (KEY.test(k) && !taken.has(k)) {
      taken.add(k)
      return k
    }
  }
  throw new Error(`no free temporary key for ${key}`)
}

/** Old ref on the target -> the ref it has after the move. */
export const refMap = ({ mirrors, collisions }) => {
  const map = new Map()
  for (const m of mirrors) map.set(m.ref, m.real_ref)
  for (const c of collisions) for (const r of c.renumber) map.set(r.from, r.to)
  return map
}

const keyOf = (ref) => ref.slice(0, ref.lastIndexOf('-'))

/**
 * The new text of one target field.
 *
 * With the Lab's origin (the Croft row and the import's mapping), a field the
 * import wrote and nobody has edited since is rebuilt from the origin: `T-n`
 * goes straight to its final ref, and a `TRIG-6` that was written as such stays
 * as written. That is the only way to tell a mirror's `TRIG-6` from the real
 * one. Any other field has its mirror refs rewritten and is flagged ambiguous.
 */
export const rewriteField = ({ current, origin, refs, lab }) => {
  if (typeof current !== 'string' || current === '') return { text: current, mode: 'empty', changes: [] }
  if (lab && typeof origin === 'string') {
    const asImported = scanRefs(origin, lab.subjects, lab.todos).text
    if (asImported === current) {
      const finalTodos = new Map([...lab.todos].map(([t, mirror]) => [t, refs.get(mirror) ?? mirror]))
      const scan = scanRefs(origin, lab.subjects, finalTodos)
      const changes = scan.rewritten
        .filter((r) => lab.todos.has(r.from) && refs.has(lab.todos.get(r.from)))
        .map((r) => ({ from: lab.todos.get(r.from), to: r.to }))
      return { text: changes.length ? scan.text : current, mode: 'origin', changes }
    }
  }
  const scan = scanRefs(current, new Map(), refs)
  const changes = scan.rewritten.map((r) => ({ from: r.from, to: r.to }))
  return { text: scan.text, mode: changes.length ? 'ambiguous' : 'none', changes, left: scan.left }
}

/** The keys a ref map can rewrite, so a caller can skip text that names none of them. */
export const refKeys = (refs) => new Set([...refs.keys()].map(keyOf))

/**
 * Rewrites a URL that points into a moving project on the source instance so
 * it points at the same place on the target. Anything else is returned as is.
 */
export const moveUrl = (url, { fromBase, toBase, movingKeys }) => {
  if (typeof url !== 'string' || !url) return url
  const from = trimBase(fromBase)
  const m = /^\/projects\/([A-Z][A-Z0-9]{1,9})(\/|$|\?|#)/.exec(url.startsWith(from) ? url.slice(from.length) : '')
  if (!m || !movingKeys.has(m[1])) return url
  return `${trimBase(toBase)}${url.slice(from.length)}`
}

/** Knowledge by scope: `move` (only moving projects), `copy` (both), `stay` (only staying), `global` (none). */
export const knowledgeScope = (projectIds, movingIds) => {
  if (!projectIds.length) return 'global'
  const moving = projectIds.filter((id) => movingIds.has(id)).length
  if (moving === projectIds.length) return 'move'
  return moving ? 'copy' : 'stay'
}

export const summariseRewrites = (fields) => {
  const byMode = {}
  const samples = []
  for (const f of fields) {
    if (!f.changes.length) continue
    const m = (byMode[f.mode] ??= { fields: 0, refs: 0 })
    m.fields += 1
    m.refs += f.changes.length
    samples.push(f)
  }
  return { byMode, samples }
}
