import { admin } from '@/lib/db/client'

/**
 * What a project used to be called.
 *
 * A ref is not an internal handle — it is designed to escape into commit
 * messages, PR titles and other agents' notes, all of which are immutable. A
 * rename cannot reach them, so the former key is kept and keeps resolving.
 */

/** The project a retired key belongs to, or null if the key was never used. */
export const projectIdForFormerKey = async (
  userId: string,
  key: string,
): Promise<string | null> => {
  const { data, error } = await admin()
    .from('project_former_keys')
    .select('project_id')
    .eq('owner_user_id', userId)
    .eq('key', key.toUpperCase())
    .maybeSingle()

  if (error) throw new Error(error.message)
  return (data as { project_id: string } | null)?.project_id ?? null
}

/** Every retired key, with the live key it now resolves to. */
export const listFormerKeys = async (
  userId: string,
): Promise<{ key: string; project_id: string; current: string }[]> => {
  const { data, error } = await admin()
    .from('project_former_keys')
    .select('key, project_id, project:projects(key)')
    .eq('owner_user_id', userId)
    .order('retired_at')

  if (error) throw new Error(error.message)
  type Row = { key: string; project_id: string; project: { key: string } | { key: string }[] | null }
  return ((data ?? []) as unknown as Row[]).map((row) => {
    const embedded = row.project
    return {
      key: row.key,
      project_id: row.project_id,
      current: (Array.isArray(embedded) ? embedded[0]?.key : embedded?.key) ?? '',
    }
  })
}

/** The keys a given project has been known by, oldest first. */
export const formerKeysFor = async (userId: string, projectId: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('project_former_keys')
    .select('key')
    .eq('owner_user_id', userId)
    .eq('project_id', projectId)
    .order('retired_at')

  if (error) throw new Error(error.message)
  return ((data ?? []) as { key: string }[]).map((row) => row.key)
}
