import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { resolveProjectKeys } from '@/lib/api/entity-projects'

export const dynamic = 'force-dynamic'

const entityCreate = z.object({
  key: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase words separated by single hyphens.'),
  title: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  projects: z.array(z.string().min(1).max(10)).max(60).default([]),
})

/**
 * Entities, with the projects in each.
 *
 * An entity is any grouping a fact can be true of — a business, a stack, a
 * subsystem. Many-to-many with projects on purpose: a project belongs to a
 * business AND sits on a stack, and a fact can be true for either reason.
 */
export const GET = route({
  handler: async () => {
    const { data, error } = await admin()
      .from('entities')
      .select('id, key, title, description, project_entities(project:projects(key))')
      .order('key')

    if (error) return fail('internal_error', error.message)

    return ok({
      count: (data ?? []).length,
      results: (data ?? []).map((e) => ({
        key: e.key,
        title: e.title,
        description: e.description,
        projects: ((e.project_entities ?? []) as unknown as {
          project: { key: string } | { key: string }[] | null
        }[])
          .map((pe) => (Array.isArray(pe.project) ? pe.project[0]?.key : pe.project?.key))
          .filter((k): k is string => Boolean(k))
          .sort(),
      })),
    })
  },
})

export const POST = route({
  schema: entityCreate,
  handler: async ({ actor, body }) => {
    const { data, error } = await admin()
      .from('entities')
      .insert({
        owner_user_id: actor.userId,
        key: body.key,
        title: body.title,
        description: body.description,
      })
      .select('id, key, title')
      .single()

    if (error) {
      return fail(error.code === '23505' ? 'conflict' : 'internal_error', error.message)
    }

    if (body.projects.length > 0) {
      const projects = await resolveProjectKeys(body.projects)
      if (projects.error) return fail('internal_error', projects.error)
      if (projects.missing.length > 0) {
        return fail('not_found', `No such project: ${projects.missing.join(', ')}`)
      }

      const { error: linkError } = await admin()
        .from('project_entities')
        .insert(projects.ids.map((project_id) => ({ project_id, entity_id: data.id })))
      if (linkError) return fail('internal_error', linkError.message)
    }

    return ok(data, { status: 201 })
  },
})

const entityPatch = z.object({
  key: z.string().min(2).max(40),
  /**
   * Rename the key itself. Links are held by id, so nothing stored breaks —
   * but anything that names the old key in prose or a habit does, which is why
   * it is a separate field rather than something `title` quietly implies.
   */
  newKey: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase words separated by single hyphens.')
    .optional(),
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(),
  addProjects: z.array(z.string().min(1).max(10)).max(60).default([]),
  removeProjects: z.array(z.string().min(1).max(10)).max(60).default([]),
})

/** Membership changes are additive/subtractive, not a wholesale replacement:
 *  assigning one project should not silently unassign thirty others. */
export const PATCH = route({
  schema: entityPatch,
  handler: async ({ body }) => {
    const { data: entity } = await admin()
      .from('entities')
      .select('id')
      .eq('key', body.key.toLowerCase())
      .maybeSingle()
    if (!entity) return fail('not_found', `No entity "${body.key}".`)

    if (
      body.title !== undefined ||
      body.description !== undefined ||
      body.newKey !== undefined
    ) {
      const fields: Record<string, string> = {}
      if (body.title !== undefined) fields.title = body.title
      if (body.description !== undefined) fields.description = body.description
      if (body.newKey !== undefined) fields.key = body.newKey.toLowerCase()

      const { error } = await admin().from('entities').update(fields).eq('id', entity.id)
      if (error) return fail('internal_error', error.message)
    }

    const add = await resolveProjectKeys(body.addProjects)
    const remove = await resolveProjectKeys(body.removeProjects)

    /* A key naming no project is a typo, and it used to read as success: it
     * vanished from the resolved ids and the response still said added: 0.
     * Refuse the whole request naming the strays, as create already does. */
    const failure = add.error ?? remove.error
    if (failure) return fail('internal_error', failure)
    const missing = [...new Set([...add.missing, ...remove.missing])]
    if (missing.length > 0) return fail('not_found', `No such project: ${missing.join(', ')}`)

    /* Both counts are what actually moved, not what was asked for: `do nothing`
     * returns only the rows it really inserted and delete returns only the rows
     * that were really there, so a re-assign reports 0 rather than 1. */
    let added = 0
    if (add.ids.length > 0) {
      /* `ignoreDuplicates` is required, not a preference: project_entities is a
       * pure join table, so every column is a conflict column. Without it the
       * builder emits `do update set` with nothing to set, which is a syntax
       * error — and re-assigning a project already in the entity is a no-op
       * anyway, since the row carries nothing but the pair itself. */
      const { data: linked, error } = await admin()
        .from('project_entities')
        .upsert(
          add.ids.map((project_id) => ({ project_id, entity_id: entity.id })),
          { onConflict: 'project_id,entity_id', ignoreDuplicates: true },
        )
        .select('project_id')
      if (error) return fail('internal_error', error.message)
      added = (linked ?? []).length
    }

    let removed = 0
    if (remove.ids.length > 0) {
      const { data: unlinked, error } = await admin()
        .from('project_entities')
        .delete()
        .eq('entity_id', entity.id)
        .in('project_id', remove.ids)
        .select('project_id')
      if (error) return fail('internal_error', error.message)
      removed = (unlinked ?? []).length
    }

    return ok({ key: body.key, added, removed })
  },
})

/**
 * Deleting an entity drops its project links and unscopes any knowledge that
 * was filed against it — which is a widening, not a loss: those facts become
 * global rather than disappearing. Said plainly in the response so the caller
 * can tell the difference.
 */
export const DELETE = route({
  handler: async ({ url }) => {
    const key = url.searchParams.get('key')
    if (!key) return fail('validation_failed', 'Provide ?key=<entity>.')

    const { data: entity } = await admin()
      .from('entities')
      .select('id')
      .eq('key', key.toLowerCase())
      .maybeSingle()
    if (!entity) return fail('not_found', `No entity "${key}".`)

    const [{ count: projects }, { count: knowledge }] = await Promise.all([
      admin()
        .from('project_entities')
        .select('project_id', { count: 'exact', head: true })
        .eq('entity_id', entity.id),
      admin()
        .from('knowledge_entities')
        .select('knowledge_id', { count: 'exact', head: true })
        .eq('entity_id', entity.id),
    ])

    const { error } = await admin()
      .from('entities')
      .delete()
      .eq('id', entity.id)
    if (error) return fail('internal_error', error.message)

    return ok({
      deleted: key,
      projectsUnlinked: projects ?? 0,
      knowledgeWidenedToGlobal: knowledge ?? 0,
    })
  },
})
