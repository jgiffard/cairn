import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

/**
 * The Linear-footer backfill's rules (CAIRN-414), without a database: the
 * parser and the plan are pure. The SQL (one transaction, updated_at kept) is
 * what scripts/backfill-linear-refs.mjs documents in its header.
 */

type Footer = {
  key: string
  url: string
  footers: { key: string; url: string }[]
  urlKey: string | null
}
type ParseModule = {
  parseFooter: (description: string | null | undefined) => Footer | null
  linearRef: (key: string) => string
}
type Task = { id: string; ref: string; description: string | null; external_ref: string | null; external_url: string | null }
type Plan = {
  updates: { id: string; ref: string; external_ref: string; external_url: string | null }[]
  skipped: { ref: string; why: string; detail?: string }[]
  collisions: { external_ref: string; refs: string[]; held: boolean }[]
  multiple: { ref: string; used: string; found: string[] }[]
}
type PlanModule = { buildPlan: (input: { tasks: Task[]; heldRefs?: string[] }) => Plan }
type ReportModule = {
  buildReport: (input: object) => { set: number; scanned: number; matched: number; skipped: Record<string, number> }
  renderReport: (report: object) => string
  maskUrl: (url: string) => string
}

const load = <T>(path: string) => import(/* @vite-ignore */ join(process.cwd(), path)) as Promise<T>
const { parseFooter, linearRef } = await load<ParseModule>('scripts/backfill-linear-refs/parse.mjs')
const { buildPlan } = await load<PlanModule>('scripts/backfill-linear-refs/plan.mjs')
const { buildReport, renderReport, maskUrl } = await load<ReportModule>('scripts/backfill-linear-refs/report.mjs')

const URL_2237 = 'https://linear.app/dispofi/issue/DIS-2237/deals-created-by-a-seller-in-si-assur-are-no-longer-auto-assigned-to'
const footer = (key = 'DIS-2237', url = URL_2237) => `---\n*Imported from Linear [${key}](${url}) · Done*`

const task = (over: Partial<Task> & { ref: string }): Task => ({
  id: `id-${over.ref}`,
  description: footer(),
  external_ref: null,
  external_url: null,
  ...over,
})

describe('parseFooter', () => {
  it('finds the footer at the end of a long body', () => {
    const body = `${'A paragraph that goes on. '.repeat(1000)}\nSee also DIS-1 for context.\n\n${footer()}`
    expect(body.length).toBeGreaterThan(25_000)
    const parsed = parseFooter(body)
    expect(parsed?.key).toBe('DIS-2237')
    expect(parsed?.url).toBe(URL_2237)
    expect(parsed?.footers).toHaveLength(1)
  })

  it('does not match prose that mentions the id without the footer', () => {
    expect(parseFooter('Follow-up to DIS-2237, see https://linear.app/dispofi/issue/DIS-2237/slug')).toBeNull()
    expect(parseFooter('Imported from Linear project Dispofi')).toBeNull()
    expect(parseFooter('Imported from Linear [DIS-2237](https://example.com/DIS-2237)')).toBeNull()
    expect(parseFooter('')).toBeNull()
    expect(parseFooter(null)).toBeNull()
  })

  it('takes the last of two footers and lists both', () => {
    const parsed = parseFooter(`${footer('DIS-1', 'https://linear.app/dispofi/issue/DIS-1/a')}\n\nmore text\n\n${footer('DIS-2', 'https://linear.app/dispofi/issue/DIS-2/b')}`)
    expect(parsed?.key).toBe('DIS-2')
    expect(parsed?.footers.map((f) => f.key)).toEqual(['DIS-1', 'DIS-2'])
  })

  it('upper-cases a lowercase key', () => {
    const parsed = parseFooter(footer('dis-2237', 'https://linear.app/dispofi/issue/dis-2237/slug'))
    expect(parsed?.key).toBe('DIS-2237')
    expect(parsed?.urlKey).toBe('DIS-2237')
    expect(linearRef('dis-2237')).toBe('linear.app/DIS-2237')
  })

  it('accepts a URL with no slug, and reports a URL that names no issue', () => {
    expect(parseFooter(footer('DIS-2237', 'https://linear.app/dispofi/issue/DIS-2237'))?.urlKey).toBe('DIS-2237')
    expect(parseFooter(footer('DIS-2237', 'https://linear.app/dispofi/issue/DIS-2237/'))?.urlKey).toBe('DIS-2237')
    expect(parseFooter(footer('DIS-2237', 'https://linear.app/dispofi'))?.urlKey).toBeNull()
  })

  it('keeps keys with digits', () => {
    expect(parseFooter(footer('D2C-12', 'https://linear.app/t/issue/D2C-12/x'))?.key).toBe('D2C-12')
  })
})

describe('buildPlan', () => {
  it('sets external_ref and the footer url on a task with a footer and no ref', () => {
    const { updates, skipped } = buildPlan({ tasks: [task({ ref: 'DISPOF-231' })] })
    expect(skipped).toEqual([])
    expect(updates).toEqual([{ id: 'id-DISPOF-231', ref: 'DISPOF-231', external_ref: 'linear.app/DIS-2237', external_url: URL_2237 }])
  })

  it('leaves an existing external_url alone', () => {
    const { updates } = buildPlan({ tasks: [task({ ref: 'A-1', external_url: 'https://elsewhere.test/1' })] })
    expect(updates[0]?.external_url).toBeNull()
  })

  it('never overwrites an external_ref, and says so', () => {
    const { updates, skipped } = buildPlan({
      tasks: [task({ ref: 'A-1', external_ref: 'croft:croft.example/T-1' }), task({ ref: 'A-2', external_ref: 'linear.app/DIS-2237' })],
    })
    expect(updates).toEqual([])
    expect(skipped).toEqual([
      { ref: 'A-1', why: 'has-external-ref', detail: 'croft:croft.example/T-1' },
      { ref: 'A-2', why: 'already-set', detail: 'linear.app/DIS-2237' },
    ])
  })

  it('sets neither task when two carry the same Linear id, in any case', () => {
    const { updates, skipped, collisions } = buildPlan({
      tasks: [task({ ref: 'A-1' }), task({ ref: 'B-9', description: footer('dis-2237', 'https://linear.app/x/issue/dis-2237/s') }), task({ ref: 'A-3', description: footer('DIS-1', 'https://linear.app/x/issue/DIS-1/s') })],
    })
    expect(collisions).toEqual([{ external_ref: 'linear.app/DIS-2237', refs: ['A-1', 'B-9'], held: false }])
    expect(skipped.map((s) => s.ref)).toEqual(['A-1', 'B-9'])
    expect(updates.map((u) => u.ref)).toEqual(['A-3'])
  })

  it('refuses an id a task outside the scan already holds', () => {
    const { updates, collisions } = buildPlan({ tasks: [task({ ref: 'A-1' })], heldRefs: ['LINEAR.APP/dis-2237'] })
    expect(updates).toEqual([])
    expect(collisions).toEqual([{ external_ref: 'linear.app/DIS-2237', refs: ['A-1'], held: true }])
  })

  it('does not match prose, and reports a double footer using the last', () => {
    const double = `${footer('DIS-1', 'https://linear.app/x/issue/DIS-1/a')}\n${footer('DIS-2', 'https://linear.app/x/issue/DIS-2/b')}`
    const { updates, skipped, multiple } = buildPlan({
      tasks: [task({ ref: 'A-1', description: 'mentions DIS-2237 in passing' }), task({ ref: 'A-2', description: double })],
    })
    expect(skipped).toEqual([{ ref: 'A-1', why: 'no-footer' }])
    expect(updates.map((u) => u.external_ref)).toEqual(['linear.app/DIS-2'])
    expect(multiple).toEqual([{ ref: 'A-2', used: 'DIS-2', found: ['DIS-1', 'DIS-2'] }])
  })

  it('skips a footer whose text and URL name different issues', () => {
    const { updates, skipped } = buildPlan({ tasks: [task({ ref: 'A-1', description: footer('DIS-1', 'https://linear.app/x/issue/DIS-9/s') })] })
    expect(updates).toEqual([])
    expect(skipped[0]?.why).toBe('url-disagrees')
  })
})

describe('report', () => {
  it('counts and renders the plan, hiding the password', () => {
    const plan = buildPlan({ tasks: [task({ ref: 'A-1' }), task({ ref: 'A-2', external_ref: 'x/Y-1' }), task({ ref: 'A-3', description: 'prose' })] })
    const report = buildReport({ mode: 'dry-run', target: 'postgresql://u:secret@h:5432/db', scope: [], scanned: 10, plan })
    expect(report).toMatchObject({ scanned: 10, matched: 2, set: 1, skipped: { 'has-external-ref': 1 } })
    const text = renderReport(report)
    expect(text).toContain('would be set')
    expect(text).toContain('A-1')
    expect(text).toContain('rolled back')
    expect(text).not.toContain('secret')
    expect(maskUrl('postgresql://u:secret@h/db')).not.toContain('secret')
  })
})
