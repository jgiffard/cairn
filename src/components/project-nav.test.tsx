import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectNav } from '@/components/project-nav'
import { LabProvider } from '@/components/lab/lab-context'

const pathname = vi.hoisted(() => ({ value: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }))

const render = (labEnabled: boolean, projects: { key: string; title: string }[] = []) =>
  renderToStaticMarkup(
    <LabProvider enabled={labEnabled}>
      <ProjectNav projects={projects} />
    </LabProvider>,
  )

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
const labels = (html: string) =>
  [...html.matchAll(/id="nav-section-[a-z]+"[^>]*>([^<]+)</g)].map((m) => m[1])
/** The marker's offset, in rows of 1.75rem. */
const markerRow = (html: string) => Number(/translateY\(([\d.]+)rem\)/.exec(html)?.[1]) / 1.75

beforeEach(() => {
  pathname.value = '/'
})

describe('the sidebar’s sections', () => {
  it('runs Work, Memory, Health and Projects, in that order', () => {
    expect(labels(render(true))).toEqual(['Work', 'Memory', 'Health', 'Projects'])
  })

  it('leads the work with the Lab, above All tasks, when it is on', () => {
    expect(hrefs(render(true)).slice(0, 4)).toEqual(['/lab', '/', '/board', '/search'])
  })

  it('starts the work at All tasks when the Lab is off', () => {
    const html = render(false)
    expect(hrefs(html).slice(0, 3)).toEqual(['/', '/board', '/search'])
    expect(html).not.toContain('href="/lab"')
  })

  it('files the rest under Memory and Health', () => {
    expect(hrefs(render(false)).slice(3, 8)).toEqual([
      '/knowledge', '/knowledge/graph', '/sessions', '/activity', '/vitals',
    ])
  })

  it('keeps every project reachable: the list, and All', () => {
    const html = render(false, [{ key: 'AC', title: 'Acme' }])
    expect(hrefs(html)).toEqual(expect.arrayContaining(['/projects', '/projects/AC']))
    expect(html).toContain('Acme')
  })

  it('groups each section for assistive tech under its label', () => {
    const html = render(false)
    expect(html).toContain('role="group" aria-labelledby="nav-section-work"')
    expect(html).toContain('role="group" aria-labelledby="nav-section-health"')
  })
})

describe('the sidebar’s active entry', () => {
  it('marks the page it is on, and only that one', () => {
    pathname.value = '/board'
    const html = render(true)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-current="page"[^>]*href="\/board"/)
  })

  it('places the marker on the row it names, labels counted', () => {
    // Work label, Lab, All tasks, Board: Board is the fourth row.
    pathname.value = '/board'
    expect(markerRow(render(true))).toBe(3)
    // Without the Lab, Board is one row higher.
    expect(markerRow(render(false))).toBe(2)
  })

  it('counts the section labels between sections', () => {
    // Work(label,All,Board,Search) Memory(label,Knowledge...) -> Knowledge is row 5.
    pathname.value = '/knowledge'
    expect(markerRow(render(false))).toBe(5)
    // Health: Work 4 + Memory 4 rows, then its label, then Activity.
    pathname.value = '/activity'
    expect(markerRow(render(false))).toBe(9)
  })

  it('lights Lab for a subject page', () => {
    pathname.value = '/lab/subjects/12'
    const html = render(true)
    expect(html).toMatch(/aria-current="page"[^>]*href="\/lab"/)
  })

  it('lights the project, and not an entry above it', () => {
    pathname.value = '/projects/AC/tasks/3'
    const html = render(true, [{ key: 'AC', title: 'Acme' }])
    expect(html).toMatch(/aria-current="page"[^>]*href="\/projects\/AC"/)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })
})
