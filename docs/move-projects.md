# Moving projects between instances

`scripts/move-projects.mjs` moves projects from one Cairn instance to another, with everything
that hangs off them. It was written for CAIRN-385: personal Cairn (`tasks.montytorr.com`)
keeps AT, BB, CCS, FDE, FLASHB, ONE, OD and TD, and every other project goes to croft
(`croft.montytorr.com`).

It is dry-run by default. A dry run is the whole move on both databases, checked, then
rolled back. Ids, numbers, actors and timestamps are kept, so a moved task keeps its ref.

## What moves

| With each project | Notes |
|---|---|
| the project, its counter, former keys, repos, entity links | entities are matched by key on the target, added when missing |
| tasks | same id and number. Claims, checkpoints, resolutions and hand-off fields are kept as they are. |
| sub-tasks, duplicates, dependencies, secondary projects (`task_projects`) | a link to a task or project that stays is dropped. The task that stays gets a note, and so does the one that moves. |
| notes, comments, attachments, activity events, delivery evidence | events of deleted tasks go too (they hold the project id). Attachment files are copied between the stores, at the same storage path. |
| file touches | the ones for a moving task, or for a moving session with no task |
| sessions scoped to a moving project | a session the target already records (same runtime and id) keeps the target's row. Fields the target lacks are filled in from the source. |
| knowledge scoped only to moving projects | with its revisions, files, entities, recall state and reads |
| knowledge scoped to moving and staying projects | copied: each side keeps its own scope |
| mentions | not copied: rebuilt on the target from the text, so refs that now resolve there link |

**Staying behind:** global knowledge, knowledge scoped only to staying projects, sessions with no
project or a staying one, users, agent keys, sign-ins and search telemetry.

**Users** are matched by email. A source user with no account on the target stops the run.

**Links across the line:**
- A mention between a moving task and a staying one is lost: there is no cross-instance mention.
- Global knowledge learned from a moving task loses `source_task_id`.
- A session that moves is still named in `source_session_ref`.
- Moving knowledge superseded by an entry that stays loses `superseded_by`. Its body names the
  successor instead.

## The Lab's mirrors

On a Lab instance, a todo handed off to the source has a mirror there: a task with
`handoff_tracker = cairn` whose URL is on the source. When the real project arrives, every mirror
of a moving task is merged into the real task:

- The real task takes the mirror's subject link.
- The mirror's notes, comments, attachments, dependencies, children and events move onto the real
  task. A note whose content hash the real task already has is dropped. Events get
  `merged_from: <mirror ref>`.
- A note on the real task records the merge, the mirror's number and its Croft origin. That note
  names no task ref, so it creates no false mention.
- The mirror is deleted. Mirrors that point at a staying project are reported and left alone.

A target project whose key a moving project needs (`TRIG`, `CROFT`) is parked under a temporary
key while the real one goes in. Any task in it that is not a mirror is renumbered after the real
project's last number. Its subjects, events and links then point at the real project, and the
parked project is deleted.

### Mirror refs in the Lab's text

The Croft import rewrote `T-n` to the mirror's ref. On croft, a `TRIG-6` in a subject can
therefore be the mirror (once Croft's `T-6`) or the real personal `TRIG-6` written as such. The
two can only be told apart from the origin. Pass `--lab-origin` (a restore of the Croft dump the
Lab was imported from) and `--lab-mapping` (that import's mapping file):
- **Unedited fields:** a field whose text is exactly what the import produced is rebuilt from the
  Croft text, with each `T-n` sent straight to its final ref. A real ref stays as written. The
  report calls this `origin`.
- **Edited fields:** a field edited since the import has every mirror ref rewritten. The report
  lists each one as `ambiguous`, to be read by eye.

The rewrite is the importer's: whole tokens only, never in code, a URL or a link target.

## Running it

```bash
node scripts/move-projects.mjs \
  --from 'postgresql://…/cairn' --to 'postgresql://…/cairn_lab' \
  --keep AT,BB,CCS,FDE,FLASHB,ONE,OD,TD \
  --move AA,BOTHY,CAIRN,CC,CIVIC,CROFT,DROVE,HOL,HOLC,KDP,MTC,POD,QRY,TRIG \
  --from-url https://tasks.montytorr.com --to-url https://croft.montytorr.com \
  --lab-origin 'postgresql://…/croft_origin' --lab-mapping croft-mapping.json \
  --from-files-dir /srv/cairn/attachments --to-files-dir /srv/cairn-lab/attachments \
  --mapping-file move-mapping.json --report-file move-report.json        # add --apply to write
```

How each project is decided:
- **Named in `--move`:** it moves.
- **In neither list and active:** the run stops. It was probably made after the plan.
- **In neither list and archived:** it moves, and the report says so.

Exit codes:
- `0`: the dry run or the apply succeeded.
- `1`: blocked or rolled back; nothing changed.
- `2`: the target committed and the source did not (see Rollback).

The tool connects as the owner of each database's tables, because it switches some triggers
off inside its transaction:
- the mention, touch, comment-index and knowledge-file triggers on the target, since it writes what
  they would derive;
- three cascade triggers on the source.

It switches them back on before committing, and a check fails if any is left off.

### Order inside the run

1. Both transactions open, at repeatable read, holding the migration lock.
2. Read and check:
   - users by email, schemas at the same migration;
   - keys, external refs, knowledge slugs and session ids that would collide;
   - the attachment files, by size and `sha256`.
3. Write the target:
   - rewrite the mirror refs, then park the colliding projects;
   - copy the rows table by table, as JSON text, so microseconds and bigints survive;
   - merge the mirrors, rebuild the mentions.
4. Empty the source:
   - for rows that stay, drop pointers that would cascade;
   - note the links that crossed, then delete.
5. Check both sides:
   - every table balances;
   - every moving task is on the target with the same id, key and number;
   - nothing moved is left on the source, and nothing staying changed;
   - all triggers are on.
6. Copy the attachment files without overwriting, commit the target, then commit the source.
   The mapping file is written last.

## Rollback

Take a fresh dump of both databases and a tar of both attachment trees before `--apply`.

- **Blocked or failed:** both transactions roll back, and copied files are removed. Nothing to do.
- **Exit 2 (target committed, source not):** the moved rows are on both sides. Restore the target
  from its dump and remove the files listed in the mapping file from the target store, or delete
  the moved projects from the source by hand.
- **Undo an applied move**, with both apps stopped:
  1. Restore each dump into a new database.
  2. Swap the names (`alter database … rename`).
  3. Remove the copied files from the target store.

  Writes made after the move are lost, which is why the move happens inside a write freeze.

The source's attachment files are left in place after a move. Remove them once the move is
confirmed; they are in the pre-run tar either way.
