import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { promoteSubjectSchema } from '@/lib/api/lab-schemas'
import { promoteSubject } from '@/lib/api/subjects'

export const dynamic = 'force-dynamic'

/**
 * Starts a project from a subject (docs/lab.md, "Promoting a subject"). The
 * owner of the subject or an administrator; one transaction.
 */
export const POST = route<{ ref: string }, z.infer<typeof promoteSubjectSchema>>({
  schema: promoteSubjectSchema,
  secretFields: ['title', 'description'],
  handler: async ({ actor, params, body }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const promoted = await promoteSubject(actor, found.subject, body)
    return promoted.ok ? ok(promoted.value, { status: 201 }) : promoted.response
  },
})
