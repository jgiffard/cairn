import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FromTheLab, FROM_THE_LAB_SHOWN } from './from-the-lab'
import { ProjectDescription, isLong } from './project-description'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const stage = { id: 's', name: 'Exploring', color: '#4f7cff', category: 'active' } as never

const promotedStage = { id: 'p', name: 'promoted', color: '#5f7d8c', category: 'completed' } as never

const subject = (number: number, title = `Subject ${number}`) => ({
  number,
  ref: `LAB-${number}`,
  title,
  stage,
  archived_at: null,
})

const promoted = (number: number, title = `Subject ${number}`) => ({
  ...subject(number, title),
  stage: promotedStage,
  archived_at: '2026-10-12T10:00:00.000Z',
})

describe('the project description', () => {
  it('renders markdown', () => {
    const html = renderToStaticMarkup(
      <ProjectDescription projectId="p1" description={'The **billing** service.'} />,
    )
    expect(html).toContain('<strong')
    expect(html).toContain('billing')
  })

  it('says so when there is none, and offers to add one', () => {
    const html = renderToStaticMarkup(<ProjectDescription projectId="p1" description="" />)
    expect(html).toContain('No description.')
    expect(html).toContain('Add one')
  })

  it('offers Edit on a description, and no fold on a short one', () => {
    const html = renderToStaticMarkup(<ProjectDescription projectId="p1" description="Short." />)
    expect(html).toContain('Edit')
    expect(html).not.toContain('Show more')
  })

  it('folds a long one behind Show more', () => {
    const html = renderToStaticMarkup(
      <ProjectDescription projectId="p1" description={'word '.repeat(200)} />,
    )
    expect(html).toContain('Show more')
    expect(html).toContain('max-h-[8rem]')
    expect(html).toContain('aria-expanded="false"')
  })

  it('counts long by characters and by lines', () => {
    expect(isLong('x'.repeat(100))).toBe(false)
    expect(isLong('x'.repeat(500))).toBe(true)
    expect(isLong(Array.from({ length: 9 }, () => '-').join('\n'))).toBe(true)
  })
})

describe('From the Lab', () => {
  it('draws nothing for a project the Lab has not touched', () => {
    expect(renderToStaticMarkup(<FromTheLab projectKey="AC" subjects={[]} />)).toBe('')
  })

  it('lists each subject with its stage, linked to its page', () => {
    const html = renderToStaticMarkup(
      <FromTheLab projectKey="AC" subjects={[subject(12, 'Try a cheaper index')]} />,
    )
    expect(html).toContain('From the Lab')
    expect(html).toContain('href="/lab/subjects/12"')
    expect(html).toContain('LAB-12')
    expect(html).toContain('Try a cheaper index')
    expect(html).toContain('Exploring')
  })

  it('caps the list and points at the Lab for the rest', () => {
    const subjects = Array.from({ length: FROM_THE_LAB_SHOWN + 3 }, (_, i) => subject(i + 1))
    const html = renderToStaticMarkup(<FromTheLab projectKey="AC" subjects={subjects} />)
    expect(html.match(/href="\/lab\/subjects\//g)).toHaveLength(FROM_THE_LAB_SHOWN)
    expect(html).toContain('3 more in the Lab')
    expect(html).toContain('href="/lab?project=AC&amp;archived=include"')
  })

  it('lists a promoted subject as history: archived, linked, after the live ones', () => {
    const html = renderToStaticMarkup(
      <FromTheLab projectKey="PGV" subjects={[promoted(7, 'Evaluate pgvector'), subject(9, 'Still exploring')]} />,
    )
    expect(html).toContain('href="/lab/subjects/7"')
    expect(html).toContain('LAB-7: promoted, archived')
    expect(html.indexOf('LAB-9')).toBeLessThan(html.indexOf('LAB-7'))
  })
})
