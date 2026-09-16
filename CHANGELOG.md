# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Cairn is pre-1.0: the schema, API and CLI are in daily use and stable in practice, but a
minor bump may still change them. Anything that would break an existing install is called
out under **Breaking** with what to do about it.

## [0.5.1] — 2026-09-16

### Fixed

- **P0 integrity boundaries:** claim, release, checkpoint and knowledge mutations now use
  atomic server-side transitions with ownership generations and monotonic checkpoint versions.
  Stale, duplicate and concurrent writes are rejected instead of overwriting newer work or
  resurrecting a released claim.
- **Durable outbox replay:** malformed and rejected queued writes are retained in a rejected
  sidecar, crashed replay workers are recovered, and checkpoint acknowledgements survive a
  crash between local compaction and state persistence. Non-checkpoint writes no longer leave
  acknowledgement markers behind.

### Changed

- Added migrations `043_integrity_boundaries.sql` and
  `044_checkpoint_predecessor_boundary.sql`, applied by the normal deployment migration step.
- CI now runs the PostgreSQL integrity suite, and production deployment is gated on the
  successful same-repository `main` workflow before building and smoke-testing the release.

## [0.5.0] — 2026-09-14

### Added

- **`cairn next`** answers which task to pick up, not just what exists. Finishing beats
  starting: work you hold, then work dropped with a checkpoint, then in-review, todo,
  backlog. Anything blocked, waiting on an unfinished task, or actively held by another
  agent is absent rather than ranked last. Every pick carries the reason it won.

- **Knowledge ages.** A fact whose named files several sessions have reworked since it was
  last confirmed is marked stale in `check` and in the briefing. Marked, never hidden and
  never expired. `cairn verify <slug>` confirms one without rewriting it.

- **Projects are created and curated from the UI** at `/projects` — create, rename,
  archive, restore, and delete behind a typed confirmation that names the task count.
  Settings no longer carries a weaker copy of the archived list.

- **In Progress and Todo tabs**, with In Progress the default, and an empty state that
  offers somewhere to go rather than dead-ending.

- **`--kind verified`**, for closing a task after finding somebody else's commit already
  fixed it. `fixed` claims their work and makes the close indistinguishable from one where
  nobody read anything.

- **`in-review` is documented** as the gate between working and finished — written but not
  merged, or merged but not deployed. It existed in the vocabulary and no guidance
  mentioned it, so the lifecycle jumped straight from doing to done.

- **Delivery evidence in the timeline**: `cairn commit`, `push` and `run` record what
  shipped and what passed. They record; none of them executes anything.

- **The timeline records what it was missing** — checkpoints, attachments, dependency
  changes, and the project lifecycle — and now outlives what it describes. Deleting a task
  detaches its events instead of erasing them, so the record that something was deleted
  survives the deletion.

- **`cairn task delete`**, refusing any task with children, notes, comments or
  dependencies; **`cairn replay`** for writes put aside while the server was unreachable;
  **`cairn add --start`** to file and claim in one call.

### Changed

- **A checkpoint claims an unheld task; a note does not.** The first version claimed on any
  work-log write and was too broad: an agent annotating a backlog put a task into `doing`
  that nobody was working on, reverted it, then did the real work without re-claiming.
  Annotating is most of what reading a backlog is. `cairn note` now says the task is
  unclaimed rather than deciding for you.

- **Everything is larger, and scales from one number.** Every size was a fixed pixel value —
  343 text sizes and 192 dimensions — so raising the type alone would have pushed text out
  of rows that could not grow. All of it is rem now, with the root at 18px.

- **Every page keeps itself current, or says why it does not.** The live-update stream
  watched only tasks, so the pages that go stale fastest could never have been helped by
  it. `cairn_pulse` covers tasks, sessions, knowledge and activity.

- **Projects are alphabetical everywhere**, case-insensitively — the collation sorted
  lowercase titles below every capitalised one.

- **Sessions say what came of them.** The API returned the request and the next steps and
  omitted what was learned and completed, so every reader outside the web UI got a session
  that said what was wanted and never what happened.

- Sessions record whether a run was **scheduled** rather than inferring it from prose the
  hook had deliberately discarded.

### Fixed

- **Every OpenClaw session was recorded as half a record.** `claude -p` as root answers
  "Not logged in", the transcript sweep must run as root, and the hook keeps the row when
  it cannot reach a summariser — so 42 of 42 sessions held their files and no prose at all,
  silently, for the life of the feature. Vitals now counts sessions actually summarised and
  alarms when none are.

- **Codex filed its work as OpenClaw.** Detection rested on `CODEX_HOME`, which Codex reads
  but does not export; the wrapper installed to set it was being bypassed. Detection now
  uses markers Codex does export, and OpenClaw is recognised by any `OPENCLAW_*` variable
  rather than two guessed names.

- **`check --project` ignored the filter for knowledge.** Three of four branches scoped;
  knowledge did not, so a scoped search returned other projects' facts and absence read as
  "this is new". Global facts still appear, and entity-scoped facts appear for projects in
  that entity.

- **A correction now outranks the claim it corrects.** Superseded knowledge was marked and
  never ranked below, so a stale fact could beat its own replacement.

- **A resolution cannot be written without closing the task**, and a task ref resolves in
  search — `CAIRN-131` used to return every task that mentioned it and never itself. A bare
  number works too.

- **The supersede picker searched instead of listing.** It was a select holding every
  current entry, capped at 300 against a corpus of 348, so 48 could not be chosen and
  nothing said so.

- Renaming a project key keeps old refs working; the list view shows the Cairn ref rather
  than an imported identifier that resolves nowhere; the sticky group heading is no longer
  painted over by the rows beneath it; settings and vitals are centred like every other
  page; and `/activity`'s "Load older" says that it is working.

### Breaking

- `DELETE /api/v1/tasks/{ref}` requires `?confirm=<REF>` and refuses a task with children,
  notes, comments or dependencies. It previously deleted anything without confirmation.

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

[Unreleased]: https://github.com/montytorr/cairn/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/montytorr/cairn/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/montytorr/cairn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/montytorr/cairn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/montytorr/cairn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/montytorr/cairn/releases/tag/v0.1.0
