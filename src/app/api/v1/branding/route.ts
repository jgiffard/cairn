import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { canAdministerUsers } from '@/lib/api/actor'
import { admin } from '@/lib/db/client'
import { HEX } from '@/lib/brand-colour'
import { DEFAULT_NAME, getBranding, invalidateBranding } from '@/lib/branding'

export const dynamic = 'force-dynamic'

/** A name or accent of null goes back to the stock one. */
const brandingUpdate = z.object({
  name: z.string().trim().max(60).nullable(),
  accent: z.string().regex(HEX, 'Use a six-digit hex colour, like #01519b.').nullable(),
})

const describe = async () => {
  const b = await getBranding()
  return { name: b.name, accent: b.accent }
}

export const GET = route({ handler: async () => ok(await describe()) })

/**
 * What the instance is called and looks like. A signed-in administrator
 * only: an agent key has no business renaming the workspace everyone sees.
 */
export const PUT = route<Record<string, string>, z.infer<typeof brandingUpdate>>({
  schema: brandingUpdate,
  handler: async ({ actor, body }) => {
    if (!canAdministerUsers(actor)) {
      return fail('forbidden', 'Only a signed-in administrator can change the branding.')
    }

    const row = {
      id: true,
      // The stock name is stored as no name, so it follows the product's.
      name: body.name && body.name !== DEFAULT_NAME ? body.name : null,
      accent: body.accent?.toLowerCase() ?? null,
      updated_at: new Date().toISOString(),
      updated_by: actor.userId,
    }
    const { error } = await admin().from('instance_branding').upsert(row, { onConflict: 'id' })
    if (error) return fail('internal_error', error.message)

    invalidateBranding()
    return ok(await describe())
  },
})
