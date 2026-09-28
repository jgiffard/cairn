import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/client', () => ({ admin: vi.fn() }))
import { STOCK, brandingFrom } from './branding'

describe('branding from its row', () => {
  const at = '2026-09-28T10:00:00.000Z'

  it('is the stock look with no row', () => {
    expect(brandingFrom(null)).toBe(STOCK)
  })

  it('falls back to the stock name for a blank one, and drops an accent that is not a hex', () => {
    const b = brandingFrom({ name: '  ', accent: 'red', updated_at: at })
    expect(b.name).toBe('Cairn')
    expect(b.accent).toBeNull()
    expect(b.palette).toBeNull()
  })

  it('derives the palette, and versions the icons by when the branding last changed', () => {
    const b = brandingFrom({ name: 'Dispofi Cairn', accent: '#01519B', updated_at: at })
    expect(b).toMatchObject({ name: 'Dispofi Cairn', accent: '#01519b', version: String(Date.parse(at)) })
    expect(b.palette?.light.accent).toBe('#01519b')
  })
})
