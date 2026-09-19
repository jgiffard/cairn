# Contributing

Cairn is a personal tool published in the open. Issues and PRs are welcome; the
maintainer's own use is what drives the roadmap, so a feature may be declined simply
because it is not needed here.

## Running it

See [`README.md`](./README.md#self-hosting). You need Node 22+, Docker and PostgreSQL 17+.

Cairn used to run on Supabase and no longer does — the runtime moved to the native
PostgreSQL driver, and `migrations/` used to be `supabase/migrations/`. If you find a
reference to Supabase that reads as a requirement rather than as history, it is stale and
a PR fixing it is welcome.

## Before opening a PR

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs all four, plus a check that `AGENTS.md` stays under 7900 bytes — agents read that
file every session, so its size is a real cost. It currently sits within a hundred bytes of
that, so adding a line there means cutting one: guidance with room to grow belongs in
[`skills/cairn/SKILL.md`](./skills/cairn/SKILL.md) instead.

## Things worth knowing before you change them

**Never derive an update schema with `.partial()` on a schema that has `.default()`.**
Zod wraps the default rather than replacing it, so the defaults still fire and every
PATCH silently overwrites fields the caller never sent. `src/schemas/task.ts` derives
create and update from a defaults-free base for exactly this reason, and
`src/schemas/task.test.ts` guards it.

**Generated columns must be IMMUTABLE.** `to_tsvector(text, text)` is only STABLE — use
`'english'::regconfig`. `array_to_string` is also only STABLE, which is why `labels` is
absent from the search vector.

**The editor must never save an unchanged body.** Markdown round-trips through
ProseMirror, so writing an untouched body can rewrite what an agent authored. See
[`docs/tiptap-markdown-spike.md`](./docs/tiptap-markdown-spike.md).

**A backfill must not advertise itself as user activity.** `tasks`, `projects` and
`task_comments` carry a `before update` touch trigger that sets `updated_at = now()` on
every row it sees. A migration that rewrites a column for bookkeeping therefore stamps
every row it touches as just-edited. Migration 049 qualified legacy actor ids across the
table and flattened `updated_at` on 3023 tasks to one timestamp, which destroyed recency
ordering and blinded every staleness view until it was repaired from a backup. Disable
the trigger around the statement, and turn it back on in the same transaction:

```sql
alter table tasks disable trigger tasks_touch;
update tasks set ... ;
alter table tasks enable trigger tasks_touch;
```

Nothing warns you: the migration succeeds, the data is correct, and only the timestamps
are quietly wrong.

**The knowledge map's layout must stay a pure function of the graph.** No `Math.random`,
no simulation in the browser — `src/lib/graph-layout.ts` seeds every position from a hash
of the slug and settles it on the server. Every view in this app re-renders through
`router.refresh()` when the live stream reports a change, which on a working day is every
few minutes, so a layout computed client-side rearranges the whole map under whoever is
reading it each time an agent writes a note. Animation is allowed and moves a node *around*
its anchor; nothing may move the anchor. `src/lib/graph-layout.test.ts` asserts two runs
agree, and `graph-view.test.tsx` asserts two renders are byte-identical.

**The `admin()` client bypasses RLS.** It is a PostgREST-compatible adapter over the
`pg` driver (`src/lib/db/client.ts`) and it connects as the owner, so every query made
with it must filter by owner explicitly — `.eq('owner_user_id', …)`, or through the
embedded relation for a join. RLS is the browser-side boundary and defence in depth, not
what protects server-side reads.

## Licence

Contributions are made under the [Sustainable Use License](./LICENSE), the licence this
project ships under. You keep the copyright in what you write; you are granting the
project the right to use it under those terms.

Work contributed before 2026-09-19 was contributed under MIT and is acknowledged as such —
see [`LICENSE-MIT-HISTORY`](./LICENSE-MIT-HISTORY).

## Credit

Contributions keep their authorship: a PR is merged rather than squashed into a
maintainer commit, so your commits stay yours in the history and in GitHub's contributor
graph. Anything that lands is credited by name and issue number in
[`CHANGELOG.md`](./CHANGELOG.md), and a report that leads to a fix is credited the same
way as a patch — finding the problem is most of the work.

## Versions and releases

Semantic versioning, and pre-1.0: the schema, API and CLI are stable in practice but a
minor bump may still change them. Anything that breaks an existing install is called out
under **Breaking** in [`CHANGELOG.md`](./CHANGELOG.md), with what to do about it.

Cutting a release:

```bash
# 1. version in package.json AND in cli/cairn.mjs — a test fails if they disagree
# 2. move Unreleased into a dated section in CHANGELOG.md
npm test && git commit -am "release: v0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The CLI carries its own version number because it is copied onto machines rather than
installed from a registry — there is no package.json beside the copy in `/usr/local/bin`.
That makes it exactly the kind of constant that goes stale silently, so a test pins it,
and `cairn --version` asks the server as well and says when the two disagree.

`/api/v1/health` reports both: `version` is the release, `build` the commit it was built
from. The first tells a CLI whether it is out of step, the second tells you whether your
fix is actually live.

## Secrets

`.env*` is gitignored except `.env.example`, and GitHub secret scanning with push
protection is enabled. Do not add real hostnames, IPs or keys to committed files —
deployment specifics belong in a gitignored `docker-compose.override.yml`.
