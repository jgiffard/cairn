# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Cairn is pre-1.0: the schema, API and CLI are in daily use and stable in practice, but a
minor bump may still change them. Anything that would break an existing install is called
out under **Breaking** with what to do about it.

## [0.2.0] — 2026-09-13

### Added

- Renaming a project key is additive: the former key is retained and keeps resolving, so a
  ref already written into a commit message, a PR title or another agent's note still finds
  the task. Old links redirect to the live ref, retired keys still linkify in prose, and the
  task shows what it used to be called — resolution alone would let the lookup succeed while
  the screen showed a ref the reader had never seen. Reusing a key another project retired is
  refused, because every `ACME-n` would then point at two tasks. The rename and the record of
  the old key happen in one statement, so they cannot half-happen.

  Reported by [@webcoder31](https://github.com/webcoder31) in #4.

- The briefing resolves a project from the **repository**, not the path. `~/.cairn/projects.json`
  keyed identity on an absolute path, and the server's fallback on a recorded `cwd` — both
  describe where one machine keeps a checkout, which is not what was being identified. A
  `git worktree` of a mapped repository, a second clone, and a `mv` all resolved to no
  project, so the briefing went quiet exactly where several agents are most likely to
  collide. `cairn map` now also claims the origin remote, and `/context` accepts `?repo=`.
  Resolution order is `--project` → repository → the `cwd` heuristic, so an explicit answer
  and the local map both still win. One local git call, no network.

  Thanks to [@webcoder31](https://github.com/webcoder31), who reported it in #2 and sent
  the implementation in #3.

### Fixed

- `next dev` no longer appends a generated block to `AGENTS.md`. The guide is hand-written,
  read by every agent at session start, and held under 8KB by CI; the block took it to within
  107 bytes of that budget, so the failure would have landed on an unrelated pull request for
  a reason appearing nowhere in its diff. `agentRules: false` in `next.config.ts`, with a test
  pinning both the setting and the upstream switch it depends on.

  Reported by [@webcoder31](https://github.com/webcoder31) in #1.

### Changed

- `cairn map <KEY>` validates the key against the server before writing, and stores the key
  the server returns. It used to write whatever it was handed, so `cairn map CAl` produced a
  map that resolved to nothing, silently. It now needs to reach the server, where before it
  was purely local.

- `cairn map none` releases the repository claim as well as the local line. Removing only
  the local line would have left every clone — including that one — still resolving.

- Vitals reads as a dashboard rather than a column of hairlines: a verdict at the top that
  says plainly whether anything is wrong, four numbers at a size that admits they matter,
  and sections as panels. Adds a 24h / 7d / 30d window.

- Migrations moved from `supabase/migrations/` to `migrations/`. The directory was named
  after a dependency the project no longer has — the runtime moved to the native
  PostgreSQL driver — and a newcomer reading the tree would reasonably conclude Supabase
  was required. No migration content changed, and the applied-migrations ledger records
  filenames rather than paths, so existing installs need nothing.

## [0.1.0] — 2026-09-12

First tagged release. Cairn has been in daily use since 2026-09-10; this is the point at
which it became something somebody else could reasonably run.

### The tracker

- Projects, tasks, sub-tasks, dependencies, labels, comments and attachments.
- A work log per task — `note · attempt · finding · decision · handoff` — so what was
  tried survives whether or not it worked.
- **Closing requires a resolution.** The API refuses a terminal status without one, which
  is the rule the rest of the value rests on.
- Claims with a lease, so several agents can work without colliding, and a heartbeat that
  says a claim is still alive.
- List, board and cross-project board views; keyboard-first; dark and light.

### The memory

- Four stores — tasks, notes, knowledge, sessions — and one verb, `cairn check`, that
  searches all four in a single pass. Two-pass full-text search, precise then widened.
- **Knowledge** outlives the task that produced it, scoped to a project, to an entity, or
  to everything, and corrected rather than appended to.
- **Sessions** are written when a session ends, without being asked: Claude Code through
  `SessionEnd`, Codex and OpenClaw by reading the rollouts they leave behind.
- A file index, so opening a file can say what is known about it.

### Agents

- REST API with an OpenAPI 3.1 document generated from the same Zod schemas the routes
  validate against, browsable at `/api-docs`.
- A dependency-free CLI — Node's built-in `fetch` is enough — that can be dropped onto a
  box and run.
- A skill for Claude Code, Codex and OpenClaw, and three hooks that brief a session at
  its start, say what is known about a file when one is opened, and record the session
  when it ends.
- **One key per runtime.** The key is the identity, so a key shared between agents makes
  their work indistinguishable afterwards.

### Operations

- Docker image, compose example and Traefik labels; migrations applied on deploy.
- `/api/v1/health` reports the version and the commit it was built from.
- `/api/v1/vitals` and the Vitals page answer whether the memory is still being
  written — sessions recorded, work opened against closed, agents that have gone quiet.
- Optional scheduled jobs: release abandoned claims, repair drifted agent files, report
  vitals, sweep transcripts from runtimes that have no session-end event.
- Backup and restore-drill scripts, because an untested backup is not a backup.

[Unreleased]: https://github.com/montytorr/cairn/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/montytorr/cairn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/montytorr/cairn/releases/tag/v0.1.0
