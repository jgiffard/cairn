import { describe, expect, it } from 'vitest'
import { TASK_FIELDS, TASK_LIST_FIELDS } from './tasks'

/** Key-based task refs require the embedded project relation. */
describe('task field lists', () => {
  it.each([
    ['TASK_FIELDS', TASK_FIELDS],
    ['TASK_LIST_FIELDS', TASK_LIST_FIELDS],
  ])('%s embeds projects with an inner join', (_name, fields) => {
    expect(fields).toContain('projects!project_id!inner')
  })

  it.each([
    ['TASK_FIELDS', TASK_FIELDS],
    ['TASK_LIST_FIELDS', TASK_LIST_FIELDS],
  ])('%s does not encode the legacy owner scope', (_name, fields) => {
    expect(fields).not.toContain('owner_user_id')
  })

  // Columns added by later migrations that the API reads back.
  it.each(['duplicate_of', 'parent_id', 'resolution', 'resolution_kind'])(
    'TASK_FIELDS selects %s',
    (column) => {
      expect(TASK_FIELDS).toContain(column)
    },
  )
})
