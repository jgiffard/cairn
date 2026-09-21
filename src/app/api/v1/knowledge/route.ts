import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { createKnowledge, listKnowledge } from '@/lib/api/knowledge'
import {
  checkReferences,
  knownSlugs,
  referenceRefusal,
  referenceWarnings,
} from '@/lib/api/knowledge-graph'
import { knowledgeCreate, slugify } from '@/schemas/knowledge'

export const dynamic = 'force-dynamic'

const listQuery = z.object({
  project: z.string().max(10).optional(),
  entity: z.string().max(40).optional(),
  label: z.string().max(40).optional(),
  superseded: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * Knowledge scoped to a project deliberately includes the global rows: the
 * question is "what do we know that applies here", and an infra gotcha applies
 * here.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad filters.', { issues: parsed.error.issues })

    const { project, entity, label, superseded, limit } = parsed.data

    // Naming an unknown project is the caller's mistake, not a server fault.
    // Left to the shared handler it became "Something went wrong." and was
    // logged as unhandled — which is how a typo would have read as a bug in
    // Cairn. POST below has always reported its own message; this matches it.
    let rows
    try {
      rows = await listKnowledge(actor.userId, {
        project,
        entity,
        label,
        limit,
        includeSuperseded: superseded,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read that.'
      if (!message.startsWith('No such ')) throw error
      return fail('validation_failed', message)
    }

    return ok({
      count: rows.length,
      results: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        labels: r.labels,
        projects: r.projects ?? [],
        entities: r.entities ?? [],
        // Narrowest wins, and the label says which rule put it in front of you.
        scope:
          (r.projects ?? []).length > 0
            ? 'project'
            : (r.entities ?? []).length > 0
              ? 'entity'
              : 'global',
        verified: Boolean(r.verified_at),
        superseded: Boolean(r.superseded_by),
        updatedAt: r.updated_at,
        tokens: Math.ceil((r.body?.length ?? 0) / 4),
      })),
    })
  },
})

/**
 * References are resolved before the entry is written, not audited afterwards.
 *
 * This is the one place that did not look. The schema checked the shape of a
 * slug and the length of a body and inserted; `[[...]]` inside that body was
 * never parsed, so a reference to something that does not exist became a fact
 * about the store the moment it was accepted, and was found only by a
 * diagnostic nobody is obliged to run. 70 of them accumulated that way.
 *
 * What the refusal has to carry is the near miss. 44 of those 70 point at a
 * fact Cairn already holds under a different slug — `capsolver-akamai-bug`
 * where `capsolver-akamai-script-bug` exists — so the useful half of the
 * answer is not "that does not exist" but "that exists, spelt this way".
 */
const referenceCheck = async (body: string, slug: string) =>
  checkReferences({ body, slug, known: await knownSlugs() })

export const POST = route({
  schema: knowledgeCreate,
  handler: async ({ actor, body }) => {
    let warnings: string[] = []
    if (body.body.includes('[[')) {
      const report = await referenceCheck(body.body, body.slug ?? slugify(body.title))
      const refusal = referenceRefusal(report, { allowUnresolved: body.allowUnresolvedRefs })
      if (refusal) {
        // The structured half, for a caller that can use it. The CLI prints
        // `error` and nothing else, which is why the message above says it all
        // in prose as well.
        return fail('validation_failed', refusal, {
          unresolvedReferences: report.unresolved,
          taskReferences: report.taskShaped.map((ref) => ref.raw),
        })
      }
      warnings = referenceWarnings(report)
    }

    try {
      const row = await createKnowledge(actor, body)
      // Accepted, and still said out loud: a reference to something nobody has
      // written is recorded, never silent.
      return ok(warnings.length > 0 ? { ...row, warnings } : row, { status: 201 })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not record that.'
      const code = message.includes('already exists') ? 'conflict' : 'validation_failed'
      return fail(code, message)
    }
  },
})
