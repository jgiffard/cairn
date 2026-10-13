#!/usr/bin/env node
/**
 * Gives every task imported from Linear its Linear id as an external_ref
 * (CAIRN-414, part of CAIRN-412).
 *
 *   node scripts/backfill-linear-refs.mjs --target <url>                     # dry run
 *   node scripts/backfill-linear-refs.mjs --target <url> --apply             # writes
 *   node scripts/backfill-linear-refs.mjs --target <url> --project DISPOF    # one project, repeatable
 *
 * The importer left the id only in a footer at the end of the description,
 *
 *   *Imported from Linear [DIS-2237](https://linear.app/dispofi/issue/DIS-2237/slug) · ...
 *
 * and left external_ref null, so searching DIS-2237 cannot find the task that
 * is DIS-2237. This reads that footer and sets
 *
 *   external_ref = 'linear.app/DIS-2237'      (key upper-cased: the `${host}/${ref}`
 *                                              shape `cairn handoff` writes, and what
 *                                              the search's trailing KEY-n lookup reads)
 *   external_url = the footer URL             (only when it is null)
 *
 * Which tasks: those whose description holds `Imported from Linear [KEY-n](https://linear.app/...)`
 * and whose external_ref is null. A task that only mentions DIS-2237 in prose is
 * not matched. With two footers the last is used and the task is listed. An
 * existing external_ref is never overwritten; those tasks are listed. If two
 * tasks carry the same Linear id, or a task outside the scan already holds that
 * external_ref (tasks_external_ref_key is unique), neither is set and both refs
 * are listed for a human.
 *
 * A dry run is the same code in one transaction, rolled back. Both print the
 * report. Before it commits, --apply checks that updated_at did not move on any
 * row it wrote, and rolls back if one did.
 *
 * What the update triggers do (migrations/):
 *   tasks_touch (001, 063)       sets updated_at = now(). A backfill is not new
 *                                work and updated_at orders the board, so the
 *                                transaction sets cairn.keep_updated_at = 'on',
 *                                the switch 063 added for bookkeeping writes. No
 *                                trigger is disabled.
 *   task_mentions_task (059)     fires on description/resolution only. Not
 *                                listed in this UPDATE, so it does not run.
 *   history                      there is no history/audit trigger on tasks:
 *                                task_activity_events rows are written by the
 *                                API, not by triggers. This script writes none,
 *                                so the backfill leaves no trace in a task's
 *                                feed. The only derived change is the generated
 *                                search_vector, which now carries the ref (A).
 *
 * The connection string is an argument on purpose. Nothing here knows where
 * production is, so nothing here can reach it by accident.
 *
 * Runbook:
 *   1. Dry run against the target, read the report: set, skipped, collisions.
 *   2. Deal with what needs a human (collisions, mismatched footers).
 *   3. Take a backup (scripts/backup.sh), then run again with --apply.
 *   4. Re-run without --apply: it should report nothing left to set.
 *   It is idempotent: a second --apply sets nothing (rows now count as
 *   "already carries this external_ref").
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { buildPlan } from './backfill-linear-refs/plan.mjs'
import { buildReport, renderReport } from './backfill-linear-refs/report.mjs'

const USAGE = `Usage: node scripts/backfill-linear-refs.mjs --target <url> [--apply] [--project <KEY>]... [--json]

  --target <url>     the Cairn database to read and, with --apply, write
  --apply            commit. Without it, the whole run happens and is rolled back.
  --project <KEY>    only tasks of this project, repeatable (default: every project)
  --json             print the report as JSON
`

const shortError = (error) => {
  const parts = [error.message]
  if (error.detail) parts.push(error.detail)
  if (error.constraint) parts.push(`(constraint ${error.constraint})`)
  return parts.join(' ')
}

/**
 * @returns {Promise<{ report: object, text: string, exitCode: number }>}
 */
export const backfillLinearRefs = async ({ targetUrl, apply = false, projects = [], log = () => {} }) => {
  const mode = apply ? 'apply' : 'dry-run'
  const scope = projects.map((k) => k.toUpperCase())
  const finish = (report) => ({ report, text: renderReport(report), exitCode: report.verdict === 'blocked' ? 1 : 0 })
  const blocked = (errors) =>
    finish(buildReport({ mode, target: targetUrl ?? '', scope, scanned: 0, plan: buildPlan({ tasks: [] }), errors }))

  if (!targetUrl) return blocked(['--target is required'])

  const client = new pg.Client({ connectionString: targetUrl })
  let open = false
  try {
    await client.connect()
    await client.query('begin')
    open = true
    await client.query(`select set_config('cairn.keep_updated_at', 'on', true)`)

    const scopeSql = scope.length ? 'and p.key = any($1::text[])' : ''
    const scopeArgs = scope.length ? [scope] : []

    if (scope.length) {
      const known = (await client.query(`select distinct key from projects where key = any($1::text[])`, [scope])).rows.map((r) => r.key)
      const missing = scope.filter((k) => !known.includes(k))
      if (missing.length) {
        await client.query('rollback')
        open = false
        return blocked([`no such project: ${missing.join(', ')}`])
      }
    }

    log('reading tasks')
    const scanned = (
      await client.query(`select count(*)::int as n from tasks t join projects p on p.id = t.project_id where true ${scopeSql}`, scopeArgs)
    ).rows[0].n
    const tasks = (
      await client.query(
        `select t.id, p.key || '-' || t.number as ref, t.description, t.external_ref, t.external_url, t.updated_at::text as updated_at
           from tasks t join projects p on p.id = t.project_id
          where t.description ilike '%Imported from Linear [%' ${scopeSql}
          order by p.key, t.number
            for update of t`,
        scopeArgs,
      )
    ).rows
    const heldRefs = (await client.query(`select external_ref from tasks where external_ref is not null`)).rows.map((r) => r.external_ref)

    const plan = buildPlan({ tasks, heldRefs })

    let verification = null
    log(`${plan.updates.length} task(s) to set`)
    for (const u of plan.updates) {
      const { rowCount } = await client.query(
        `update tasks set external_ref = $2, external_url = coalesce(external_url, $3) where id = $1 and external_ref is null`,
        [u.id, u.external_ref, u.external_url],
      )
      if (rowCount !== 1) throw new Error(`${u.ref} changed under the script; nothing was written`)
    }
    if (plan.updates.length) {
      const before = new Map(tasks.map((t) => [t.id, t.updated_at]))
      const after = (
        await client.query(`select id, updated_at::text as updated_at from tasks where id = any($1::uuid[])`, [plan.updates.map((u) => u.id)])
      ).rows
      const moved = after.filter((row) => before.get(row.id) !== row.updated_at)
      verification = { checked: after.length, ok: moved.length === 0 }
    }

    const errors = verification && !verification.ok ? ['updated_at moved on a task; rolled back'] : []
    if (apply && !errors.length) await client.query('commit')
    else await client.query('rollback')
    open = false

    return finish(buildReport({ mode, target: targetUrl, scope, scanned, plan, verification, errors }))
  } catch (error) {
    if (open) await client.query('rollback').catch(() => {})
    return blocked([shortError(error)])
  } finally {
    await client.end().catch(() => {})
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      apply: { type: 'boolean', default: false },
      project: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help || !values.target) {
    console.log(USAGE)
    return values.help ? 0 : 1
  }

  const { report, text, exitCode } = await backfillLinearRefs({
    targetUrl: values.target,
    apply: values.apply,
    projects: values.project ?? [],
    log: (m) => console.error(`  ${m}`),
  })
  console.log(values.json ? JSON.stringify(report, null, 2) : text)
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
