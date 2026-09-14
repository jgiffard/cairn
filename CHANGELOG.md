# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Cairn is pre-1.0: the schema, API and CLI are in daily use and stable in practice, but a
minor bump may still change them. Anything that would break an existing install is called
out under **Breaking** with what to do about it.

## [Unreleased]

### Changed

- **Working on a task claims it.** 36% of recently closed tasks across CAIRN, OD and QRY
  were never claimed, so they never showed as In Progress while somebody was on them. The
  cause was structural rather than a lapse: nothing cost anything when it was skipped, and
  the rule had been stated plainly in the skill for weeks. A note or a checkpoint from an
  agent on an open task nobody holds now claims it and says so. It never steals a live
  claim — noting on a colleague's task stays a note — never reopens closed work, and never
  applies to humans, who coordinate by talking. `cairn add --start` files and claims in one
  call, for the file-it-then-do-it pattern that skipped claiming most often.

### Fixed

- **A resolution can no longer be written without closing the task.** It was accepted
  silently: the agent wrote the answer, believed it had finished, and the task sat in
  backlog carrying an answered dot — which also offered it to `check` as settled prior
  work. Refused rather than auto-closed, because `done` and `cancelled` are different
  claims about the work and only the caller knows which one it is making.

## [0.4.0] — 2026-09-14

### Added

- **`cairn next`** says what to pick up rather than what exists. The briefing listed what was
  held, in flight and dropped and never which one to do, so every agent invented its own
  ranking and they disagreed. Finishing beats starting: work you hold, then work dropped with
  a checkpoint, then dropped without one, then in-review, todo, backlog. Anything blocked,
  waiting on an unfinished task, or actively held by another agent is absent rather than
  ranked last. Every pick carries the reason it won.

- **Knowledge ages, and says so.** `verified_at` existed and nothing used it, so half a dozen
  entries describing the Supabase stack went on reading like facts confirmed this morning
  after the stack was replaced. A fact whose named files several sessions have reworked since
  it was last confirmed is marked stale in `check` and in the briefing. Marked, never hidden
  and never expired — a wrong confidence signal is worse than none. `cairn verify <slug>`
  confirms a fact without rewriting it.

- **`cairn task delete <ref> --confirm <ref>`**, refusing any task with children, notes,
  comments or dependencies in either direction, and pointing at cancel — which keeps the
  record and the reason — instead.

- **Writes survive a deploy.** They normally return in half a second; during a restart they
  blocked for minutes, so an agent mid-task froze rather than carrying on. A write now has a
  deadline, after which a note, comment, heartbeat or checkpoint is put aside and replayed by
  the next successful write. `add` and `claim` are deliberately not queued: a ref that does
  not exist yet, or being told you hold a task you may not have won, is worse than a clear
  failure. `cairn replay` flushes by hand.

### Changed

- **Sessions record what they actually touched.** The session hook recovered task refs by
  regex over the transcript and returned refs from documentation examples; those links feed
  search, and a session linked to everything answers yes to everything. The CLI now drops a
  breadcrumb per accepted write and the hook reads those, matched on time so it works for
  Codex and OpenClaw, which name sessions in ways the CLI cannot see. The regex remains as a
  fallback.

### Breaking

- `DELETE /api/v1/tasks/{ref}` now requires `?confirm=<REF>` and refuses a task that has
  children, notes, comments or dependencies. It previously deleted anything, with no
  confirmation. Anything scripted against it needs the parameter; anything relying on it to
  remove a task with history should use `cancel`.

## [0.3.0] — 2026-09-13

### Added

- Scheduled maintenance installs on macOS, as LaunchAgents rather than a crontab. The jobs
  were defined as cron lines and the defaults named one host's layout, so on a laptop every
  one of them skipped — correctly, and uselessly. They are now defined once as a schedule,
  an environment and a command, rendered by whichever backend the platform calls for, and
  the defaults describe the machine: `~/.local/bin` for the CLI, `~/Library/Logs` for logs,
  and the node running the installer. Verified byte-identical against the live Linux
  crontab before anything else changed.

- `sync-agent-files.mjs` repairs itself. It was the one file it never checked, so the
  repairer could sit stale indefinitely while reporting everything else healthy.

### Fixed

- A job whose prerequisite was never configured reported `skipping <job>: no  on this
  machine`, with an empty path where a filename should be — it reads as a bug in the
  installer rather than as a job this machine was never meant to run.

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

[Unreleased]: https://github.com/montytorr/cairn/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/montytorr/cairn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/montytorr/cairn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/montytorr/cairn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/montytorr/cairn/releases/tag/v0.1.0
