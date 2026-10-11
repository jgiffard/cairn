#!/usr/bin/env node
/**
 * Moves projects from one Cairn instance to another (CAIRN-385): personal
 * Cairn to croft. Everything that hangs off a project goes with it, ids,
 * numbers, actors and timestamps kept, and the Lab's hand-off mirrors of the
 * moving tasks are merged into them.
 *
 *   node scripts/move-projects.mjs --from <url> --to <url> --keep AT,BB --move CAIRN,TRIG     # dry run
 *   node scripts/move-projects.mjs ... --apply                                               # writes
 *
 * One transaction on each side. The target is written and checked, the source
 * emptied and checked, attachments copied, then the target commits and the
 * source after it. A dry run is the same code, rolled back.
 *
 * The connection strings are arguments on purpose: nothing here knows where
 * production is. docs/move-projects.md is the runbook.
 */
import { open, readFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { checkSource, copyFiles, diskStore, removeFiles } from './import-croft/files.mjs'
import { rawTypes } from './import-croft/read.mjs'
import { compareCatalogs, readCatalog } from './move-projects/catalog.mjs'
import {
  countPerProject,
  crossingLinks,
  preflight,
  readFacts,
  readOrigin,
  snapshots,
  writeSource,
  writeTarget,
} from './move-projects/engine.mjs'
import { chooseProjects, parseKeys, trimBase } from './move-projects/plan.mjs'
import { renderReport } from './move-projects/report.mjs'
import { sourceDigest, totals, verify } from './move-projects/verify.mjs'

const USAGE = `Usage: node scripts/move-projects.mjs --from <url> --to <url> --keep <KEYS> --move <KEYS> [--apply] [options]

  --from <url>              the instance the projects leave (personal)
  --to <url>                the instance they join (croft)
  --keep <KEYS>             projects that stay, comma-separated. Everything else moves.
  --move <KEYS>             the projects you mean to move. An active project in neither list stops the run;
                            an archived one moves and is reported.
  --apply                   write. Without it, everything runs and is rolled back.

  --from-url <url>          the source's public URL (hand-off mirrors point at it)
  --to-url <url>            the target's public URL (links into moved projects are rewritten to it)
  --lab-origin <url>        the Croft database the target's Lab was imported from (read only), and
  --lab-mapping <file>      that import's mapping file: together they tell a mirror's ref from a real one
  --from-files-dir <dir>    the source's attachment directory
  --to-files-dir <dir>      the target's attachment directory (needed with --apply when files move)
  --actor <text>            who the notes the move writes are from (default "move-projects · CAIRN-385")
  --mapping-file <path>     write what moved and every ref that changed (JSON)
  --report-file <path>      write the report as JSON
  --json                    print the report as JSON
`

const shortError = (error) =>
  [error.message, error.detail, error.constraint && `(constraint ${error.constraint})`, error.table && `(table ${error.table})`]
    .filter(Boolean)
    .join(' ')

const readLab = async (file) => {
  const data = JSON.parse(await readFile(file, 'utf8'))
  return { subjects: new Map(Object.entries(data.subjects ?? {})), todos: new Map(Object.entries(data.todos ?? {})) }
}

/**
 * @returns {Promise<{ report: object, text: string, mapping: object | null, exitCode: number }>}
 */
export const moveProjects = async ({
  fromUrl,
  toUrl,
  keep = [],
  move = [],
  apply = false,
  options = {},
  stores = { source: null, target: null },
  mappingFile = null,
  log = () => {},
}) => {
  const report = {
    verdict: 'blocked',
    mode: apply ? 'apply' : 'dry-run',
    source: (fromUrl ?? '').replace(/:[^:@/]*@/, ':***@'),
    target: (toUrl ?? '').replace(/:[^:@/]*@/, ':***@'),
    errors: [],
    warnings: [],
  }
  const finish = (mapping = null) => {
    if (report.errors.length) report.verdict = 'blocked'
    return { report, text: renderReport(report), mapping, exitCode: report.verdict === 'blocked' ? 1 : report.verdict === 'partial' ? 2 : 0 }
  }
  if (!fromUrl || !toUrl) return (report.errors.push('--from and --to are both required'), finish())
  if (fromUrl === toUrl) return (report.errors.push('--from and --to are the same connection string'), finish())
  const opts = {
    sourceBaseUrl: trimBase(options.sourceBaseUrl ?? 'https://tasks.montytorr.com'),
    targetBaseUrl: trimBase(options.targetBaseUrl ?? 'https://croft.montytorr.com'),
    actor: options.actor ?? 'move-projects · CAIRN-385',
    lab: null,
    origin: null,
  }

  let mappingHandle = null
  if (mappingFile) {
    try {
      mappingHandle = await open(mappingFile, 'wx')
    } catch (error) {
      report.errors.push(`--mapping-file ${mappingFile}: ${error.code === 'EEXIST' ? 'already exists' : error.message}`)
      return finish()
    }
  }
  const dropMapping = async () => {
    if (!mappingHandle) return
    await mappingHandle.close().catch(() => {})
    await rm(mappingFile, { force: true })
    mappingHandle = null
  }

  const source = new pg.Client({ connectionString: fromUrl, types: rawTypes })
  const target = new pg.Client({ connectionString: toUrl, types: rawTypes })
  const originClient = options.labOrigin ? new pg.Client({ connectionString: options.labOrigin, types: rawTypes }) : null
  let open_ = { source: false, target: false }
  let copied = []
  const rollback = async () => {
    if (open_.target) await target.query('rollback').catch(() => {})
    if (open_.source) await source.query('rollback').catch(() => {})
    open_ = { source: false, target: false }
  }
  try {
    await source.connect()
    await target.connect()
    if (originClient) {
      await originClient.connect()
      await originClient.query('begin read only')
      opts.origin = await readOrigin(originClient)
      await originClient.query('rollback')
      if (!options.labMapping) report.errors.push('--lab-origin needs --lab-mapping')
      else opts.lab = await readLab(options.labMapping)
    }

    const [sc, tc] = [await readCatalog(source), await readCatalog(target)]
    report.errors.push(...sc.problems.map((p) => `source: ${p}`), ...tc.problems.map((p) => `target: ${p}`))
    if (!report.errors.length) report.errors.push(...compareCatalogs(sc, tc))
    if (report.errors.length) return (await dropMapping(), finish())

    const sourceIs = (await source.query(`select current_database() as db, inet_server_port() as port`)).rows[0]
    const targetIs = (await target.query(`select current_database() as db, inet_server_port() as port`)).rows[0]
    const sameHost = new URL(fromUrl).host === new URL(toUrl).host
    if (sameHost && sourceIs.db === targetIs.db) {
      report.errors.push('--from and --to are the same database')
      return (await dropMapping(), finish())
    }

    for (const [client, side] of [
      [source, 'source'],
      [target, 'target'],
    ]) {
      await client.query('begin isolation level repeatable read')
      open_[side] = true
      await client.query('select pg_advisory_xact_lock(7261693)')
      // The deferred assignee key would leave pending trigger events after every
      // insert, and ALTER TABLE refuses a table that has them.
      await client.query('set constraints all immediate')
      await client.query(`select set_config('cairn.keep_updated_at', 'on', true)`)
    }

    const projects = (await source.query(`select id, key, status, task_counter from projects order by key`)).rows
    const chosen = chooseProjects({ projects, keep: parseKeys(keep), move: parseKeys(move) })
    report.errors.push(...chosen.errors)
    report.warnings.push(...chosen.warnings)
    report.projects = { moving: chosen.moving.map((p) => p.key), staying: chosen.staying.map((p) => p.key) }
    if (report.errors.length) return (await rollback(), await dropMapping(), finish())

    log('reading both sides')
    const facts = await readFacts({ source, target, movingIds: chosen.moving.map((p) => p.id), sourceBaseUrl: opts.sourceBaseUrl })
    const pre = await preflight({ source, target, facts })
    report.errors.push(...pre.errors)
    report.warnings.push(...pre.warnings)
    if (facts.mirrors.length && !opts.lab) {
      report.warnings.push('no --lab-origin: every mirror ref in the target text is rewritten, including ones written as real refs')
    }
    report.perProject = await countPerProject(source)
    report.crossing = await crossingLinks(source)
    report.knowledge = {
      scopes: Object.fromEntries(
        (await source.query(`select scope, count(*)::int as n from kn_scope group by scope order by scope`)).rows.map((r) => [r.scope, r.n]),
      ),
    }
    report.sessions = {
      moving: pre.sessionKeys.length,
      clash: pre.sessionClash.length,
      staying: Number((await source.query(`select count(*) as n from sessions where id not in (select id from mv_sessions)`)).rows[0].n),
    }
    const files = (
      await source.query(
        `select storage_path, size_bytes, sha256 from task_attachments where task_id in (select id from mv_tasks) order by storage_path`,
      )
    ).rows.map((f) => ({ from: f.storage_path, to: f.storage_path, size: Number(f.size_bytes), sha256: f.sha256 }))
    report.files = { count: files.length, bytes: files.reduce((a, f) => a + f.size, 0), checked: false }
    if (files.length) {
      if (!stores.source) report.errors.push(`${files.length} attachment(s) move and no --from-files-dir is given`)
      else {
        const { problems } = await checkSource(stores.source, files)
        report.errors.push(...problems)
        report.files.checked = true
      }
      if (apply && !stores.target) report.errors.push('--apply with attachments needs --to-files-dir')
      if (stores.target) {
        const there = []
        for (const f of files) if (await stores.target.read(f.to).then(() => true, () => false)) there.push(f.to)
        if (there.length) report.warnings.push(`${there.length} attachment path(s) already exist in the target store; identical bytes are accepted`)
      }
    }
    if (report.errors.length) return (await rollback(), await dropMapping(), finish())

    const before = {
      digest: await sourceDigest(source),
      target: await totals(target),
      targetLab: (
        await target.query(
          `select (select count(*) from subjects)::int as subjects, (select count(*) from subject_notes)::int as subject_notes,
                  (select count(*) from subject_human_notes)::int as subject_human_notes, (select count(*) from app_users)::int as app_users`,
        )
      ).rows[0],
      staying: await snapshots.stayingSnapshot(source),
      stayingSnapshot: snapshots.stayingSnapshot,
    }

    let written
    let removed
    try {
      log('writing the target')
      written = await writeTarget({ source, target, catalog: tc, facts, pre, options: { ...opts, crossing: report.crossing }, log })
      log('emptying the source')
      removed = await writeSource({ source, options: opts, crossing: report.crossing, log })
    } catch (error) {
      await rollback()
      await dropMapping()
      report.errors.push(`the move was refused: ${shortError(error)}`)
      return finish()
    }
    report.tables = written.tables
    report.written = { urls: written.urls, mentions: written.mentions, notes: written.notes, lostLinkNotes: written.lostLinkNotes }
    report.removed = removed
    report.rewrites = written.rewrites
    report.mirrors = { merged: written.merged, counts: written.merge, untouched: facts.mirrorsUntouched, renumbered: written.renumbered }

    log('checking')
    report.verification = await verify({ source, target, facts, written, removedFromSource: removed, before, options: opts })
    if (report.verification.some((c) => !c.ok)) {
      await rollback()
      await dropMapping()
      report.errors.push('a check failed after writing; both sides were rolled back')
      return finish()
    }

    if (apply && files.length) {
      copied = await copyFiles({ source: stores.source, target: stores.target, files })
      report.files.copied = copied.length
    }

    const mapping = {
      applied: apply,
      generated_at: new Date().toISOString(),
      source: opts.sourceBaseUrl,
      target: opts.targetBaseUrl,
      projects: Object.fromEntries(facts.movingProjects.map((p) => [p.key, { id: p.id, status: p.status, task_counter: p.task_counter }])),
      kept: report.projects.staying,
      mirrors: Object.fromEntries((written.merged ?? []).map((m) => [m.mirror, m.real])),
      mirror_details: written.merged,
      renumbered: Object.fromEntries(written.renumbered.map((r) => [r.from, r.to])),
      knowledge_moved: (await source.query(`select slug from mv_knowledge where scope = 'move' order by slug`)).rows.map((r) => r.slug),
      knowledge_copied: (await source.query(`select slug from mv_knowledge where scope = 'copy' order by slug`)).rows.map((r) => r.slug),
      sessions_moved: pre.sessionKeys.length,
      files: files.map((f) => f.to),
      crossing: report.crossing,
      rewrites: written.rewrites.fields,
    }

    if (!apply) {
      await rollback()
      report.verdict = 'dry-run'
    } else {
      try {
        await target.query('commit')
        open_.target = false
      } catch (error) {
        await rollback()
        if (copied.length) await removeFiles({ target: stores.target, paths: copied })
        await dropMapping()
        report.errors.push(`the target refused to commit, nothing changed: ${shortError(error)}`)
        return finish()
      }
      copied = []
      try {
        await source.query('commit')
        open_.source = false
        report.verdict = 'applied'
        report.commit = 'target committed, then source committed'
      } catch (error) {
        open_.source = false
        report.verdict = 'partial'
        report.commit = `TARGET COMMITTED, SOURCE NOT (${shortError(error)}). The moved rows are on both sides. Restore the target from its pre-run backup, or finish by hand: see docs/move-projects.md.`
      }
    }
    if (mappingHandle) {
      await mappingHandle.writeFile(`${JSON.stringify(mapping, null, 2)}\n`)
      await mappingHandle.close()
      mappingHandle = null
    }
    return finish(mapping)
  } catch (error) {
    await rollback()
    if (copied.length && stores.target) await removeFiles({ target: stores.target, paths: copied })
    await dropMapping()
    throw error
  } finally {
    await source.end().catch(() => {})
    await target.end().catch(() => {})
    if (originClient) await originClient.end().catch(() => {})
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      keep: { type: 'string' },
      move: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'from-url': { type: 'string' },
      'to-url': { type: 'string' },
      'lab-origin': { type: 'string' },
      'lab-mapping': { type: 'string' },
      'from-files-dir': { type: 'string' },
      'to-files-dir': { type: 'string' },
      actor: { type: 'string' },
      'mapping-file': { type: 'string' },
      'report-file': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help || (!values.from && !values.to)) {
    console.log(USAGE)
    return 0
  }
  const { report, text, exitCode } = await moveProjects({
    fromUrl: values.from,
    toUrl: values.to,
    keep: values.keep,
    move: values.move,
    apply: values.apply,
    mappingFile: values['mapping-file'] ?? null,
    stores: {
      source: values['from-files-dir'] ? diskStore(values['from-files-dir']) : null,
      target: values['to-files-dir'] ? diskStore(values['to-files-dir']) : null,
    },
    log: (m) => console.error(`  ${m}`),
    options: {
      sourceBaseUrl: values['from-url'],
      targetBaseUrl: values['to-url'],
      labOrigin: values['lab-origin'],
      labMapping: values['lab-mapping'],
      actor: values.actor,
    },
  })
  if (values['report-file']) {
    const handle = await open(values['report-file'], 'w')
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`)
    await handle.close()
  }
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
