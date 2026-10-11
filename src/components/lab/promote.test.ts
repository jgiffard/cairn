import { describe, expect, it } from 'vitest'
import { canPromote, keyProblem, promotionStage, suggestProjectKey } from './promote'
import type { Stage } from './types'

const stage = (name: string, category: Stage['category'], position: number): Stage => ({
  id: name,
  name,
  category,
  color: '#8a8792',
  position,
})

describe('suggestProjectKey', () => {
  it.each([
    ['Evaluate pgvector for recall', 'EPR'],
    ['Pgvector', 'PGVE'],
    ['The Lab lifecycle', 'LL'],
    ['  ', ''],
    ['42', ''],
    ['x', ''],
  ])('reads %j as %j', (title, key) => {
    expect(suggestProjectKey(title)).toBe(key)
  })

  it('always suggests something the server accepts, or nothing', () => {
    for (const title of ['Rank by vector', 'A B C D E F', 'ai-trader v4', 'Café au lait']) {
      const key = suggestProjectKey(title)
      expect(key === '' || keyProblem(key) === null).toBe(true)
    }
  })
})

describe('keyProblem', () => {
  it('says nothing about an empty key, and names what is wrong otherwise', () => {
    expect(keyProblem('')).toBeNull()
    expect(keyProblem('ACME')).toBeNull()
    expect(keyProblem('A')).toMatch(/2–10/)
    expect(keyProblem('1AB')).toMatch(/starting with a letter/)
    expect(keyProblem('LAB')).toMatch(/reserved/)
  })
})

describe('promotionStage', () => {
  it('prefers implementing, else the first active stage, else none', () => {
    const board = [
      stage('to explore', 'planned', 0),
      stage('exploring', 'active', 1),
      stage('Implementing', 'active', 5),
      stage('done', 'completed', 2),
    ]
    expect(promotionStage(board)?.name).toBe('Implementing')
    expect(promotionStage(board.filter((s) => s.name !== 'Implementing'))?.name).toBe('exploring')
    expect(promotionStage(board.filter((s) => s.category !== 'active'))).toBeNull()
  })
})

describe('canPromote', () => {
  const owner = { id: 'u1', name: 'Cal' }
  const live = { owner, project: null, archived_at: null }

  it('is the owner or an administrator, on a live subject that has no project', () => {
    expect(canPromote(live, { userId: 'u1', role: 'member' })).toBe(true)
    expect(canPromote(live, { userId: 'u2', role: 'admin' })).toBe(true)
    expect(canPromote(live, { userId: 'u2', role: 'member' })).toBe(false)
    expect(canPromote({ ...live, project: { id: 'p', key: 'ACME', title: 'Acme' } }, { userId: 'u1', role: 'admin' })).toBe(false)
    expect(canPromote({ ...live, archived_at: '2026-10-10T00:00:00Z' }, { userId: 'u1', role: 'admin' })).toBe(false)
  })
})
