import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { knowledgeGaps } from '@/lib/api/knowledge-graph'

export const dynamic = 'force-dynamic'

/**
 * Where the memory has holes in it.
 *
 * Three things, none of which a list of knowledge can show, because a list
 * shows what is there: entries joined to nothing, references pointing at
 * entries nobody ever wrote, and how many separate islands the corpus has
 * fallen into.
 *
 * This exists because the map that found them is a web page, and everything
 * that writes knowledge here is an agent. The 377 entries were written by
 * things that cannot open a browser, so the findings were visible only to a
 * person who happened to click Map — which makes them observations rather than
 * something anyone can act on.
 *
 * No coordinates. A reader with a screen needs somewhere to draw each node; a
 * reader without one needs the facts, and should not pay for a force
 * simulation to get them.
 */
export const GET = route({
  handler: async () => ok(await knowledgeGaps()),
})
