import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

/**
 * The project move's rules (CAIRN-385), without a database: which projects
 * move, which target tasks are mirrors, how a colliding project is replaced,
 * and how a mirror's ref in the target's text becomes the real one. The write
 * path is tests/integration/move-projects.test.ts.
 */

type Row = Record<string, unknown>
type Plan = {
  parseKeys: (v: string | string[] | undefined) => string[]
  chooseProjects: (i: { projects: Row[]; keep: string[]; move: string[] }) => {
    moving: Row[]
    staying: Row[]
    errors: string[]
    warnings: string[]
  }
  findMirrors: (i: {
    targetTasks: Row[]
    sourceBaseUrl: string
    movingKeys: string[]
    sourceTasksByRef: Map<string, Row>
  }) => { mirrors: Row[]; untouched: Row[]; errors: string[] }
  planCollisions: (i: {
    targetProjects: Row[]
    targetTasks: Row[]
    mirrors: Row[]
    movingProjects: Row[]
    formerKeys?: Row[]
  }) => { collisions: { key: string; renumber: { from: string; to: string; number: number }[]; counter_after: number }[]; errors: string[] }
  tempKey: (key: string, taken: Set<string>) => string
  refMap: (i: { mirrors: Row[]; collisions: Row[] }) => Map<string, string>
  rewriteField: (i: {
    current: string | null
    origin?: string | null
    refs: Map<string, string>
    lab: { subjects: Map<string, string>; todos: Map<string, string> } | null
  }) => { text: string | null; mode: string; changes: { from: string; to: string }[] }
  moveUrl: (url: string | null, o: { fromBase: string; toBase: string; movingKeys: Set<string> }) => string | null
  knowledgeScope: (ids: string[], moving: Set<string>) => string
  matchUsers: (i: { sourceUsers: Row[]; targetUsers: Row[]; referenced: Map<string, number> }) => {
    users: Row[]
    errors: string[]
    warnings: string[]
  }
}

const load = <T>(path: string) => import(/* @vite-ignore */ join(process.cwd(), path)) as Promise<T>
const plan = await load<Plan>('scripts/move-projects/plan.mjs')

const project = (key: string, status = 'active', task_counter = 10) => ({ id: `p-${key}`, key, status, task_counter })

describe('choosing what moves', () => {
  const projects = [project('AT'), project('CAIRN'), project('TRIG'), project('OLD', 'archived')]

  it('moves everything that is not kept, and reports archived projects nobody named', () => {
    const r = plan.chooseProjects({ projects, keep: ['AT'], move: ['CAIRN', 'TRIG'] })
    expect(r.errors).toEqual([])
    expect(r.moving.map((p) => p.key)).toEqual(['CAIRN', 'OLD', 'TRIG'])
    expect(r.staying.map((p) => p.key)).toEqual(['AT'])
    expect(r.warnings).toEqual(['OLD is archived and not kept, so it moves too'])
  })

  it('stops on an active project in neither list, a key in both, or a key the source lacks', () => {
    expect(plan.chooseProjects({ projects, keep: ['AT'], move: ['CAIRN'] }).errors).toEqual([
      'TRIG (active) is neither kept nor named in --move: decide about it first',
    ])
    expect(plan.chooseProjects({ projects, keep: ['AT', 'CAIRN'], move: ['CAIRN', 'TRIG'] }).errors).toContain(
      'CAIRN is both kept and moved',
    )
    expect(plan.chooseProjects({ projects, keep: ['AT', 'NOPE'], move: ['CAIRN', 'TRIG'] }).errors).toContain(
      '--keep names NOPE, which the source does not have',
    )
  })

  it('parses keys however they are written', () => {
    expect(plan.parseKeys(' at, bb  ccs,')).toEqual(['AT', 'BB', 'CCS'])
    expect(plan.parseKeys(undefined)).toEqual([])
  })
})

describe('people', () => {
  const sourceUsers = [
    { id: 's-cal', email: 'cal@example.com' },
    { id: 's-mael', email: 'mael@example.com' },
  ]
  const targetUsers = [{ id: 't-cal', email: 'cal@example.com' }]

  it('maps by email, and lets a person the target lacks stay behind when nothing that moves names them', () => {
    const r = plan.matchUsers({ sourceUsers, targetUsers, referenced: new Map() })
    expect(r.errors).toEqual([])
    expect(r.users).toEqual([{ id: 's-cal', email: 'cal@example.com', target_id: 't-cal' }])
    expect(r.warnings).toEqual(['mael@example.com has no account on the target; nothing that moves names them'])
  })

  it('stops when a moving row names a person the target lacks', () => {
    const r = plan.matchUsers({ sourceUsers, targetUsers, referenced: new Map([['s-mael', 3]]) })
    expect(r.errors).toEqual(['mael@example.com has no account on the target and 3 moving row(s) name them: users are matched by email'])
  })
})

describe('mirrors', () => {
  const base = 'https://tasks.example.com'
  const real = new Map<string, Row>([
    ['TRIG-6', { id: 'real-6', project_id: 'p-TRIG' }],
    ['KDP-1', { id: 'real-k1', project_id: 'p-KDP' }],
  ])
  const mirror = (ref: string, handoff_ref: string, url = `${base}/projects/x/tasks/1`, extra: Row = {}) => ({
    id: `m-${ref}`,
    ref,
    project_id: `t-${ref.split('-')[0]}`,
    handoff_tracker: 'cairn',
    handoff_ref,
    handoff_url: url,
    subject_id: 's1',
    ...extra,
  })

  it('finds the target tasks that stand for moving source tasks', () => {
    const r = plan.findMirrors({
      targetTasks: [
        mirror('TRIG-1', 'TRIG-6'),
        mirror('LT-7', 'KDP-1'),
        mirror('LT-8', 'AT-3'),
        mirror('LT-9', 'TRIG-6', 'https://elsewhere.example/projects/TRIG/tasks/6'),
        { id: 'plain', ref: 'LT-1', handoff_tracker: null },
      ],
      sourceBaseUrl: `${base}/`,
      movingKeys: ['TRIG', 'KDP'],
      sourceTasksByRef: real,
    })
    expect(r.errors).toEqual([])
    expect(r.mirrors.map((m) => [m.ref, m.real_ref, m.real_id])).toEqual([
      ['TRIG-1', 'TRIG-6', 'real-6'],
      ['LT-7', 'KDP-1', 'real-k1'],
    ])
    expect(r.untouched).toEqual([{ ref: 'LT-8', points_at: 'AT-3', why: 'it points at a project that stays' }])
  })

  it('stops when a mirror names a task the source does not have', () => {
    const r = plan.findMirrors({
      targetTasks: [mirror('TRIG-2', 'TRIG-99')],
      sourceBaseUrl: base,
      movingKeys: ['TRIG'],
      sourceTasksByRef: real,
    })
    expect(r.errors).toEqual(['TRIG-2 mirrors TRIG-99, which the source does not have'])
  })
})

describe('a target project whose key a moving project needs', () => {
  it('renumbers the tasks that are not mirrors after the real project, in order', () => {
    const r = plan.planCollisions({
      targetProjects: [{ id: 't-TRIG', key: 'TRIG' }, { id: 't-LT', key: 'LT' }],
      targetTasks: [
        { id: 'a', project_id: 't-TRIG', number: 1 },
        { id: 'b', project_id: 't-TRIG', number: 3 },
        { id: 'c', project_id: 't-TRIG', number: 2 },
        { id: 'd', project_id: 't-LT', number: 1 },
      ],
      mirrors: [{ id: 'a' }],
      movingProjects: [{ id: 'p-TRIG', key: 'TRIG', task_counter: 234 }],
    })
    expect(r.collisions).toHaveLength(1)
    expect(r.collisions[0]?.renumber.map((x) => [x.from, x.to])).toEqual([
      ['TRIG-2', 'TRIG-235'],
      ['TRIG-3', 'TRIG-236'],
    ])
    expect(r.collisions[0]?.counter_after).toBe(236)
  })

  it('parks it under a key nothing uses', () => {
    const taken = new Set(['TRIG', 'ZZ1TRIG'])
    expect(plan.tempKey('TRIG', taken)).toBe('ZZ2TRIG')
    expect(plan.tempKey('CAIRNLONGX', new Set())).toMatch(/^[A-Z][A-Z0-9]{1,9}$/)
  })
})

describe('mirror refs in the target text', () => {
  const refs = new Map([
    ['TRIG-1', 'TRIG-6'],
    ['TRIG-6', 'TRIG-102'],
    ['LT-7', 'KDP-1'],
  ])
  const lab = {
    subjects: new Map([['S-1', 'LAB-1']]),
    todos: new Map([
      ['T-1', 'TRIG-1'],
      ['T-6', 'TRIG-6'],
      ['T-51', 'LT-7'],
      ['T-52', 'LT-8'],
    ]),
  }

  it('rebuilds an unedited field from its origin, so a real ref written as such stays', () => {
    // In Croft, T-1 was the todo and TRIG-6 the personal task it was handed to.
    const origin = 'T-1 pushed to Cairn as TRIG-6; see S-1 and T-52.'
    const current = 'TRIG-1 pushed to Cairn as TRIG-6; see LAB-1 and LT-8.'
    const r = plan.rewriteField({ current, origin, refs, lab })
    expect(r.mode).toBe('origin')
    expect(r.text).toBe('TRIG-6 pushed to Cairn as TRIG-6; see LAB-1 and LT-8.')
    expect(r.changes).toEqual([{ from: 'TRIG-1', to: 'TRIG-6' }])
  })

  it('rewrites every mirror ref, and says it guessed, when the field was edited after the import', () => {
    const r = plan.rewriteField({
      current: 'TRIG-1 pushed to Cairn as TRIG-6, edited later',
      origin: 'T-1 pushed to Cairn as TRIG-6',
      refs,
      lab,
    })
    expect(r.mode).toBe('ambiguous')
    expect(r.text).toBe('TRIG-6 pushed to Cairn as TRIG-102, edited later')
  })

  it('rewrites simultaneously, not one ref after another', () => {
    const r = plan.rewriteField({ current: 'TRIG-1 then TRIG-6', refs, lab: null })
    expect(r.text).toBe('TRIG-6 then TRIG-102')
  })

  it('leaves code, links and lookalikes alone', () => {
    const current = 'Keep `TRIG-1`, https://x.example/TRIG-1, TRIG-10 and LT-70; change LT-7.'
    expect(plan.rewriteField({ current, refs, lab: null }).text).toBe(
      'Keep `TRIG-1`, https://x.example/TRIG-1, TRIG-10 and LT-70; change KDP-1.',
    )
  })

  it('collects the map from mirrors and renumbered tasks', () => {
    const m = plan.refMap({
      mirrors: [{ ref: 'TRIG-1', real_ref: 'TRIG-6' }],
      collisions: [{ renumber: [{ from: 'TRIG-2', to: 'TRIG-235' }] }],
    })
    expect([...m]).toEqual([
      ['TRIG-1', 'TRIG-6'],
      ['TRIG-2', 'TRIG-235'],
    ])
  })
})

describe('links and knowledge', () => {
  const o = { fromBase: 'https://tasks.example.com', toBase: 'https://croft.example.com/', movingKeys: new Set(['CAIRN']) }

  it('points a link into a moving project at the target, and leaves the rest', () => {
    expect(plan.moveUrl('https://tasks.example.com/projects/CAIRN/tasks/12', o)).toBe('https://croft.example.com/projects/CAIRN/tasks/12')
    expect(plan.moveUrl('https://tasks.example.com/projects/AT/tasks/1', o)).toBe('https://tasks.example.com/projects/AT/tasks/1')
    expect(plan.moveUrl('https://tasks.example.com/projects/CAIRNX/tasks/1', o)).toBe('https://tasks.example.com/projects/CAIRNX/tasks/1')
    expect(plan.moveUrl('https://linear.app/x/issue/CAIRN-1', o)).toBe('https://linear.app/x/issue/CAIRN-1')
    expect(plan.moveUrl(null, o)).toBe(null)
  })

  it('scopes knowledge: moving only moves, both is copied, none is global', () => {
    const moving = new Set(['p1', 'p2'])
    expect(plan.knowledgeScope(['p1', 'p2'], moving)).toBe('move')
    expect(plan.knowledgeScope(['p1', 'p9'], moving)).toBe('copy')
    expect(plan.knowledgeScope(['p9'], moving)).toBe('stay')
    expect(plan.knowledgeScope([], moving)).toBe('global')
  })
})
