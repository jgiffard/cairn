# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Cairn is pre-1.0: the schema, API and CLI are in daily use and stable in practice, but a
minor bump may still change them. Anything that would break an existing install is called
out under **Breaking** with what to do about it.

## [Unreleased]

### Added

- **`cairn learn` refuses a `[[reference]]` the store can almost resolve, and says what it
  should have said** (CAIRN-253). 70 of 579 references in the corpus pointed at nothing, and 44
  of those named a fact Cairn already holds under a different slug — `capsolver-akamai-bug`
  where `capsolver-akamai-script-bug` exists — so two thirds of the "missing knowledge" was a
  recall miss rather than a gap. Nothing checked `[[...]]` at write time; dangling links
  surfaced only in a diagnostic nobody is obliged to run, which is how 70 accumulated. A write
  is now refused when a close slug exists — the same name modulo a type prefix, or one name
  containing the other whole — and the refusal names the candidate, because there is nothing to
  override in that case. It is accepted with a warning when nothing close exists: that is the
  genuinely unwritten fact, and the structural case that two entries citing each other cannot
  both be written first. A task ref in wiki brackets (`[[dis-2129]]`) is refused by shape with
  "write it bare", since it names an entry that will never exist. `--allow-dangling` on the CLI,
  `"allowUnresolvedRefs": true` on the API, is the deliberate way past, so recording a reference
  as it stands is a claim somebody made rather than a default nobody noticed. The CLI now prints
  the unresolved list and its suggestions — `request()` printed `error` alone, so the
  suggestions were computed and thrown away. Prefix tolerance deliberately does not live in
  `normalizeSlugRef`: folding `project-` in there would make `project-x` and `x` the same
  identifier, and the store holds both. A `[[ref]]` quoted inside an inline code span no longer
  counts as an edge, so the diagnostic and the rendered page agree. This stops new ones; the
  existing 44 are untouched.
- **The same check runs on `PATCH /api/v1/knowledge/{slug}`.** Without it the whole thing was
  reachable in one hop: write a clean entry, then edit a dangling reference into it with nothing
  looking. A request that does not change the body is not re-checked, so a rename or a
  `--verified` does not fail on a reference the entry has carried for weeks.
- **Every API response carries `x-cairn-version`, and a CLI that has drifted says so**
  (CAIRN-246). `cairn --version` could always answer this, but it is the one command an agent
  has no reason to run, so a stale copy goes on working — just not the way the docs say. One
  install here was found only because `cairn vitals` happened to come back "unknown command",
  after a day of writes recorded under the wrong identity. The header is set at `ok()` and
  `fail()`, and the CLI compares once per process and writes the mismatch to stderr, never
  stdout: callers parse stdout, and a warning in it is a bug. Silent when the header is absent,
  so it degrades quietly against an older server.
- **`GET /api/v1/vitals` returns a `memory` block, and `cairn vitals --all` prints it**
  (CAIRN-254). Whether agents consult the memory was already measured and was visible only on a
  page in a browser — the one place the population it measures cannot look, which is the same
  failure the knowledge-gaps route names in its own header, one panel over. The block rides
  along on the same window as the counts: searches, how many widened, how many came back empty,
  how many tasks were filed without checking first, and the recent misses. It degrades to `null`
  rather than taking the monitor down when the aggregate cannot be read.
- **Knowledge recall is recorded, not just knowledge volume** (CAIRN-254, migration `053`).
  `search_events` has answered "was the memory consulted" since migration `024`, and nothing
  answered "did it give back the right thing": results were counted and never identified, and
  `cairn know <slug>` — the single path that most directly means an agent called knowledge when
  it needed it — recorded nothing at all, because `recordSearch` only ever fired from
  `/api/v1/search`. A `knowledge_reads` table now records actor, slug and hit on every read of
  `GET /api/v1/knowledge/{slug}`, and the miss is written as a row *before* the not-found
  return, because a miss on a guessed slug is a dangling reference followed live and an absence
  cannot be counted. `search_events.returned_slugs` records which entries a search actually
  returned; it is nullable with no default on purpose, so `NULL` means the row predates the
  column and `{}` means the search returned nothing — defaulting to `{}` would have rewritten
  every historical row into a claim nobody made. A separate table rather than a reused one,
  because pooling would corrupt the three numbers `search_events` exists to produce: `widened`
  is meaningless for a slug lookup, `zeroResults` means the opposite on the two paths, and
  `result_count` is only ever 0 or 1. `cairn_memory_use` reports both, and
  `tasksFiledWithoutChecking` unions them — looking a fact up by name is checking.
- **`scripts/release.mjs` cuts a release** (CAIRN-248). The process lived in whoever remembered
  it, and it has two version strings to keep in step by hand: `package.json`, which the server
  reports, and the constant in `cli/cairn.mjs`, which a copied CLI reports. Forgetting the
  second fails in the direction that reassures — every stale install then agrees with a server
  that has moved on, disarming the header above. The script bumps both, closes `[Unreleased]`
  into a dated section, commits and tags, and refuses to start if the two strings are already
  out of step. It does not push: pushing a tag is a release, and that stays a decision. A test
  asserts the two versions match.
- **One mark across both Cairn sites, and a social card** (CAIRN-249). The two properties
  carried different artwork, and this one had no opengraph image or metadata at all, so every
  link pasted as a bare URL. `icon`, `apple-icon` and `opengraph-image` now share the cloud's
  palette and geometry with the stones solidified — at a true 16px the outlined version fills in
  and the three stones fuse into one shape — and `openGraph`/`twitter` metadata is set.
  `metadataBase` reads `CAIRN_BASE_URL` rather than hardcoding a domain, because this repo is
  meant to be self-hosted.
- **The skill says when *not* to reach for Cairn, and no longer tells agents a note claims a
  task.** `skills/cairn/SKILL.md` carried one line of negative guidance and a frontmatter
  description of eleven positive triggers with no boundary, so it fired on anything task-shaped
  (CAIRN-245); the new section sits before the lifecycle rather than after it, and its test is
  durability rather than size — a one-line fix that lands in the repo gets a task, an afternoon
  of reading that changes nothing does not. The file also contradicted itself 123 lines apart
  (CAIRN-250): the sweep section said a note does not claim, and a bolded "You do not have to
  remember" said it does. The second is pre-CAIRN-146 wording, and it is the half that wins,
  because it is written to reassure and therefore to be believed — an agent trusting it
  concludes that noting is enough and never claims, which is the behaviour the surrounding
  paragraph complains about. `claim.ts` and `AGENTS.md` have had it right since CAIRN-146; the
  skill never caught up. A checkpoint still claims an unheld task; a note still does not.
- **`--mine` answered "this human's agents" while reading like "this session".** The CLI
  guessed the caller from a `CAIRN_AGENT` environment variable and sent
  `claimed_by=$CAIRN_AGENT` — and when that variable was unset it sent an empty string,
  asking for tasks held by nobody and getting back an answer that looked like an answer. The
  server resolves it now, because only the server knows who is asking, and narrows to the
  caller's session when there is one. A claim that names no session is still yours, on the
  same rule the release guard and `cairn next` follow: cannot tell must not become not
  yours.
- **`cairn next` offered another session's live claim as "you are holding this one".** It
  compared `claimedBy` alone, and that is an actorLabel every Claude Code session on a
  machine shares — so a sibling's claim was not merely left unskipped, it was promoted to
  the top of the list with "finish it or hand it back". A session working on a trading bot
  was told to finish a knowledge-map task it had never opened. The comparison now includes
  the session on both the skip and the tier, so a live claim from another session is passed
  over exactly as any other agent's would be, and a stale one still surfaces as the
  abandoned work it is.
- **A session's closing summary could be recorded against tasks it never touched.** The
  session-end hook filtered its breadcrumbs by time and directory and, when no breadcrumb
  matched the directory, fell back to *every task any session wrote in that window*. Its
  last resort was worse: task references regex-matched out of conversation prose, so
  discussing a task counted as working it. CAIRN-209 — a task about label collision on the
  knowledge map — is carrying a progress report about three unrelated pull requests, and two
  more carry a checkpoint about a task in a different product. Breadcrumbs now record the
  session that wrote them and are filtered on it exactly, with no fallback to the window:
  a session row with no task links is a small loss, a session row attached to someone
  else's task is a wrong record that later readers believe. Bare prose mentions no longer
  count as work at all.
- **A claim now says which session holds it, not just which human.** `claimed_by` is a label
  like `claude-code · cal@example.com`, and every Claude Code session on a machine writes
  exactly that — four run here at once. The claim itself was never the broken part; the
  things around it were. `release` matched on the label and would drop another session's
  claim silently, `--mine` answered "this human's agents" while looking like "this session",
  and the session-end hook stamped its checkpoint onto every task the *label* held, so one
  session's afternoon landed on another's tasks. Nobody could answer "which session is
  holding this", which cost a duplicated implementation the day this was written. The CLI
  now sends its session id (`CAIRN_SESSION_ID`, or `CLAUDE_CODE_SESSION_ID`, which Claude
  Code already exports), releasing another session's claim requires `--force`, and a claim
  that names no session behaves exactly as before — because "cannot tell" must not become
  "not yours".
- **Vitals counts the work nobody could see was happening.** CAIRN-135 measured that 36% of
  closed tasks had never been claimed, shipped auto-claim on checkpoint, and that number then
  had no reader — nothing recomputed it, so nobody would have known if it went back up. `cairn
  vitals` now reports when a quarter or more of the tasks closed in the window went from filed
  to closed with *nothing at all* recorded in between: no claim, no checkpoint, no commit, no
  push, no run result, and no status move off the status the task was filed in — and with the
  close itself made by a runtime, because a person is documented as never claiming and
  `claim.ts` refuses to claim on their behalf, so counting their closes measures the design
  rather than a lapse. The transition that closes the task is not evidence, since every close
  writes one; without that carve-out the count would be permanently zero and look like a fix.
  That is a strictly narrower question than *was this ever claimed*, which is what this check
  asked in its first, unreleased form: a task that moved to in-review hours earlier with commits
  and test runs against it was not invisible while it was being worked, whatever the claim log
  says, and a claim is one way of being visible rather than the only one. A floor of five closed
  tasks, so a small week is not mistaken for a pattern. Not an alarm, and deliberately not auto-
  claim on close: CAIRN-146 rejected inferring intent from an ambiguous signal, and closing is
  at least as ambiguous as annotating — `--kind verified` exists precisely for closing somebody
  else's fix.
- **A map of the knowledge corpus** at `/knowledge/graph`, and the same findings without a
  screen through `cairn know --gaps` / `--orphans` / `--dangling`, a `GET
  /api/v1/knowledge/gaps` route and a `cairn_gaps` MCP tool. It answers what a list of
  knowledge cannot — what is connected to *nothing*. On the corpus that prompted it: a
  quarter of the entries joined to nothing, nineteen separate islands, and dozens of
  references pointing at entries nobody ever wrote. The layout is computed on the server
  and is a pure function of the graph, because every view re-renders on a live update and a
  map that rearranges itself under the reader is not a map.
- **`[[slug]]` references resolve**, in the rendered body and in the terminal, with
  underscores read as hyphens. 265 of 377 entries carried them and nothing had ever parsed
  them, so 606 references rendered as literal brackets.
- **A reference to an entry nobody wrote is marked** rather than quietly linked into
  nothing — in the browser, and on the way out of `cairn know <slug>`.
- **Knowledge pages show the slug, who wrote it, and the task it was learned on**, and
  their scope chips link through to the project or entity.
- **Six knowledge tools on the MCP facade** — `know`, `learn`, `relearn`, `unlearn`,
  `verify`, `entities`. An MCP-only agent could not read or write the memory half of the
  product, and was not told it existed.
- **`scripts/install-mcp.mjs`**, because the facade needs a `node_modules` beside it and so
  cannot be copied like the CLI. It prints by default, and refuses to call an install done
  unless an account other than the installer's can read what it wrote.
- **A CI guard against one machine's layout reaching this repository**, checking shape —
  absolute paths into a named account's home — rather than carrying a list of private names,
  which would itself be a list of private names in a public repository.
- **Shared workspace membership:** administrators can add, disable and restore users,
  assign administrator or member roles, reset passwords, and manage each user's agent
  keys. Active users and valid agent keys work across one common project and memory space.

### Changed

- **The `closed-unclaimed` finding is now `closed-without-trace`, and counts a different
  population** (CAIRN-251, migration `054`). It was firing on the wrong tasks and its own
  sentence was false of them. Of the ten flagged in a 24h window, classified by hand against the
  activity feed, *zero* were the bare filed-to-closed shape it was built for: nine had moved to
  in-review hours earlier, several with commits and test runs recorded against them. Two defects
  behind that. Human closes were counted, although a person is documented as never claiming and
  `claim.ts` returns false for them by design — while the agent-silent finding twenty lines
  above it in the same report does skip people. And the backlog sweep the skill explicitly
  instructs — file one task, claim that, work the rest unclaimed — was indistinguishable from
  the failure the check exists to catch. So the question became "was there any evidence of work
  by anyone at any point" rather than "was this claimed". Renamed rather than redefined in
  place, because the name is the safety mechanism: a server still on migration `051` sends the
  old key, the new check does not find the new one, and it says nothing — which is correct,
  where printing the new sentence over the old number would not be. Measured here after the
  migration landed, 12 of 64 closes were untraced, under the quarter threshold, so the finding
  no longer fires; the old predicate read 26% at the same moment. Known and intended: `051`'s
  own motivating case is no longer counted, because a commit and a push were recorded against
  it. There is no grace window, because any threshold there would be arbitrary.
- **The CLI's known-flag list is checked from the code's side.** The parser exits 2 on a flag it
  does not know, and the test meant to stop the list going stale compared it against the help
  text and the dynamic lookup loops — neither of which sees a flag the code reads directly and
  the help never names. Adding `flags.zzzProbeFlag` to the CLI left all three tests green while
  the parser would have refused it with exit 2: the same failure, one door over. The list is now
  also diffed against every `flags.x` and `flags['x']` read in the file, with comments stripped
  so prose about a flag is not mistaken for a read. A second test asserts that no
  `flags.camelCase` read exists at all — the parser keys on the literal flag name, so such a
  read is not a style choice but permanently `undefined` and silent about it (CAIRN-255).
- **A slug is cut at a whole word.** Twelve entries ended mid-word — `...cannot-sha`,
  `...dernier-passag` — which cannot be typed and read as corrupt.
- **`cairn learn` scopes to this directory's project** instead of defaulting to global.
  27% of everything written since the import was filed as true everywhere when it was true
  of one project.
- Owner columns are retained as attribution metadata, not authorization boundaries.
  Project keys, entity keys and knowledge slugs are unique across the workspace.
- Durable actor labels include the owning user's display identity, and migration `049`
  qualifies legacy task, activity, knowledge, session and search attribution accordingly.

### Fixed

- **The summariser ran on every Codex turn.** Codex has no `SessionEnd`, so the recorder is
  wired to `Stop`, which fires at the end of each assistant turn — and `record()` summarised
  unconditionally, so a forty-turn session made forty model calls, each with up to 24 KB of
  transcript, to write and rewrite one row. Nobody chose one call per turn; it arrived
  because `Stop` was the only event Codex had. The hook now reuses the last summary for a
  session when the digest is byte-for-byte what it already summarised, or when the previous
  call was under `CAIRN_SUMMARY_MIN_INTERVAL_MS` (default ten minutes). The deterministic
  half is still written fresh every time, and the prose is reused rather than omitted, so a
  row never loses prose it already had.
- **`backup.sh` could not back up the database the README tells you to create.** It dumped
  with `pg_dump -U postgres`, hardcoded, while `.env.example` documents `cairn_app` — so a
  deployment that followed the instructions either failed with `role "postgres" does not
  exist` or, on a cluster that happened to have one, quietly dumped as a superuser nobody
  intended. The role is now `CAIRN_DB_USER`, defaulting to `postgres` so existing
  deployments are untouched, and the README and `.env.example` now point at each other.
  Reported and fixed by [jgiffard](https://github.com/jgiffard) —
  [#55](https://github.com/montytorr/cairn/pull/55).
- **Vitals called the owner of the instance a silent agent.** `monty.torr@gmail.com has
  written nothing in 24h, against 97 in the week before … verify it was expected to be active
  before investigating hooks or keys` — that is a person, the 97 is a week of his own clicks
  in the web UI, and he has no hooks or keys to investigate. `agent_stats` selected
  `actor_id` and grouped by it, never referring to `actor_type`, so everyone who had ever
  touched a task arrived in the list the silent-runtime check reads. The cost was not the
  noise: a genuinely silent runtime was sitting in the same list as a false positive about a
  person, and a warning that is wrong half the time is one nobody finishes reading. Migration
  050 carries `actor_type` through, and the check skips people. A payload from an older
  server carries no type and is still checked, because there everything in that list was a
  runtime as far as anyone knew.
- **A long session was summarised by its first hour.** `buildDigest` gave the agent's
  narration head *and* tail, with a comment saying why the middle is worthless, but took the
  prompts head-only. That was fine while a session was an afternoon; now that the recorder
  also runs at compaction, the normal session being written up is a long one. The first
  session recorded under the new trigger was two days old and its `request` read "reconcile
  gaps, fix settings/users duplication" — true on the Friday, and nothing to do with what
  the session had become. Prompts now get the same head-and-tail treatment, and the
  summariser is told the middle was cut so it covers the span rather than the opening.
- **The no-sessions alarm asserted a cause it cannot know.** It ended "The session hooks
  are not running, or cannot write" — and a count of zero cannot distinguish a runtime with
  nothing to say from one that cannot speak. It named only the second, and was wrong both
  times it mattered here: once the runtimes were out of tokens and every hook was fine, once
  the hooks fired and the key authenticated and the sessions had simply never ended. Twice
  the guess was read as the finding. It now states what was observed, names the three cases
  that produce it, and points at `cairn-session-end.mjs --dry-run <transcript>`, which was
  built to separate them and which the alarm had never mentioned.
- **A session that never ends was never recorded.** The session row is written at
  `SessionEnd`, and a session that runs for days does not end — it compacts. On the machine
  this was found on, four Claude Code transcripts had been open since the same morning, one
  of them 39 MB, and the last session recorded from that host was the minute those four
  began, 54 hours earlier. Nothing was broken: the hooks fired, the key authenticated, the
  parser read a real transcript correctly. The trigger never came. `install-hooks.mjs` now
  installs `PreCompact` alongside `SessionEnd`, because compaction is what happens *instead*
  of ending, and `cairn session end` upserts on (platform, id) so the row is rewritten in
  place rather than duplicated.
- **`install-hooks.mjs` rewrote a hooks file that already said the right thing**, and for
  Codex that is not cosmetic. `JSON.stringify` emits keys in insertion order, so rebuilding
  an identical entry moves `cairn-memory` from after `timeout` to before it and the file
  gains a trailing newline — 1264 bytes become 1265, nothing about the configuration
  changes, and every `trusted_hash` under `[hooks.state]` in `config.toml` stops matching.
  Codex then silently runs none of its hooks. It now compares the hook set canonically and
  writes nothing when it matches, and the warning about re-trusting entries prints only
  when the file actually moved — printed every run, it was wallpaper.
- **Re-running `install-hooks.mjs` duplicated hooks it had not installed itself.** It
  recognised its own entries only by the tag it writes, so hooks installed by hand — or by a
  version of the script from before the tag existed — were invisible to it and a second copy
  was appended beside them. Two session recorders means two model calls per event. It now
  also recognises its scripts by name, and by name rather than absolute path, because the
  stale entry most in need of replacing is exactly the one that points somewhere else.
- **The browser UI could not write behind a TLS-terminating reverse proxy** — the
  deployment the README documents. The origin check compared the browser's `Origin`
  against the request's own URL, which reads `http://` once the proxy has terminated TLS,
  so the two could never match and every browser mutation was refused with 403. A fresh
  install could not issue its first agent key, which is the step the README sends you to
  immediately after bootstrapping the administrator. The expected origin now reads
  `X-Forwarded-Proto` and `X-Forwarded-Host`, takes the first hop of each, compares normal
  forms so an explicit `:443` still matches, and falls back to the request itself when the
  headers are absent or unparseable — so a direct deployment and the CLI are unchanged.
  Reported and fixed by [Thierry Thiers](https://github.com/webcoder31) — [#42](https://github.com/montytorr/cairn/issues/42), [#43](https://github.com/montytorr/cairn/pull/43).
- **`cairn know --project` was read after the early return**, so it was accepted and
  silently dropped on every search — the same defect as `check --project`, relocated into
  the CLI, on the verb agents use most.
- **An unknown project key answered with emptiness.** A typo and a project nobody has
  learned anything about were indistinguishable; it now says which key does not exist.
- **The MCP wrapper pointed into a checkout under a `0700` home**, so every runtime not
  running as root got `MODULE_NOT_FOUND` from a correctly registered server.
- **`install-cron.mjs` was the one file the repairer never repaired**, and so the only
  deployed copy on a busy host that had drifted.

### Breaking

- `cairn vitals` reports `tasks.closedWithoutTrace`; `tasks.closedUnclaimed` is gone. Anything
  parsing the vitals payload must read the new key — the old one is simply absent, so a reader
  that does not will see `undefined` rather than an error, and a dashboard built on it will show
  a blank where a number was. The count is not the same measurement renamed: it excludes closes
  made by a person, and it excludes any task with a checkpoint, commit, push, run result, or a
  status move that is not terminal, recorded before the close — so it reads lower than
  `closedUnclaimed` did on the same window. Apply migration `054`; until it is applied the server sends the old
  key and the finding stays silent, which is deliberate.

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

[Unreleased]: https://github.com/montytorr/cairn/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/montytorr/cairn/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/montytorr/cairn/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/montytorr/cairn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/montytorr/cairn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/montytorr/cairn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/montytorr/cairn/releases/tag/v0.1.0
