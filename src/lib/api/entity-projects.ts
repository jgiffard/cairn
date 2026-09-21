import { admin } from '@/lib/db/client'

/**
 * Resolve project keys to ids for entity membership, saying which ones missed.
 *
 * Both the create and the patch path need this, and they used to do it
 * differently: create diffed the keys it found against the keys it asked for
 * and refused the request naming the strays, while patch used whatever came
 * back. A key matching nothing simply vanished there, so `--project NOSUCH`
 * reported `added: 0` and read as success. Patch also dropped the query error,
 * which made a database failure indistinguishable from a typo.
 */
export type ResolvedProjects = {
  ids: string[]
  /** Requested keys, upper-cased, that match no project. */
  missing: string[]
  error: string | null
}

export const resolveProjectKeys = async (keys: string[]): Promise<ResolvedProjects> => {
  if (keys.length === 0) return { ids: [], missing: [], error: null }

  const wanted = [...new Set(keys.map((key) => key.toUpperCase()))]
  const { data, error } = await admin().from('projects').select('id, key').in('key', wanted)
  if (error) return { ids: [], missing: [], error: error.message }

  const found = new Map((data ?? []).map((row) => [row.key as string, row.id as string]))
  return {
    ids: wanted.filter((key) => found.has(key)).map((key) => found.get(key) as string),
    missing: wanted.filter((key) => !found.has(key)),
    error: null,
  }
}
