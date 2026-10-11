import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Every field the API lets you change has a CLI path (CAIRN-383). Each verb is
 * spawned against a fake server, so what is asserted is what reaches the wire
 * and what is printed — including the requests that must NOT be sent.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method?: string; path?: string; body?: Record<string, unknown> }
type Routes = Record<string, unknown>

/** `METHOD /path` → data. Anything not listed answers 404, which fails the verb loudly. */
const serve = (routes: Routes, seen: Seen[]) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method, path: req.url }
        if (raw) try { entry.body = JSON.parse(raw) } catch { /* not json */ }
        seen.push(entry)
        const key = `${req.method} ${req.url}`
        const found = key in routes
        res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
        res.end(JSON.stringify(found ? { success: true, data: routes[key] } : { success: false, error: `no route ${key}`, code: 'not_found' }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string, stdin?: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-coverage-'))
  directories.push(home)
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key', CAIRN_AGENT: 'test' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
}

const NOTE_ID = '11111111-2222-4333-8444-555555555555'
const FILE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const task = { ref: 'CIVIC-1', title: 'T', status: 'todo' }
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== 'GET')

describe('a due date', () => {
  it('is set on add and on update, and cleared with none', async () => {
    const seen: Seen[] = []
    const base = await serve({
      'GET /api/v1/search?q=ship+OR+thing&kinds=task': { results: [] },
      'POST /api/v1/projects/CIVIC/tasks': task,
      'PATCH /api/v1/tasks/CIVIC-1': task,
    }, seen)

    expect((await run(['add', 'Ship thing', '--project', 'CIVIC', '--no-start', '--due', '2026-11-30'], base)).code).toBe(0)
    expect(writes(seen)[0]?.body).toMatchObject({ title: 'Ship thing', dueDate: '2026-11-30' })

    await run(['update', 'CIVIC-1', '--due', '2026-12-01'], base)
    await run(['update', 'CIVIC-1', '--due', 'none'], base)
    const patches = seen.filter((s) => s.method === 'PATCH')
    expect(patches[0]?.body).toEqual({ dueDate: '2026-12-01' })
    expect(patches[1]?.body).toEqual({ dueDate: null })
  })

  it.each([
    [['update', 'CIVIC-1', '--due', '2026-02-30'], 'is not a date'],
    [['update', 'CIVIC-1', '--due', 'tomorrow'], 'YYYY-MM-DD'],
    [['update', 'CIVIC-1', '--due'], '--due needs a value'],
    [['add', 'x', '--project', 'CIVIC', '--due', 'none'], 'nothing to clear'],
  ])('refuses %j before any request', async (args, said) => {
    const seen: Seen[] = []
    const base = await serve({}, seen)
    const { code, stderr } = await run(args, base)
    expect(code).not.toBe(0)
    expect(stderr).toContain(said)
    expect(seen).toEqual([])
  })
})

describe('clearing', () => {
  it('update --label none empties the labels, a list replaces them', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'PATCH /api/v1/tasks/CIVIC-1': task }, seen)
    await run(['update', 'CIVIC-1', '--label', 'none'], base)
    await run(['update', 'CIVIC-1', '--label', 'a, b'], base)
    expect(seen.map((s) => s.body)).toEqual([{ labels: [] }, { labels: ['a', 'b'] }])
  })

  it.each([
    [['update', 'CIVIC-1', '--label', ''], '--label needs a value'],
    [['update', 'CIVIC-1', '--title', ''], '--title needs a value'],
    [['update', 'CIVIC-1', '--body', ''], '--body needs a value'],
    [['relearn', 'a-fact', '--label', ''], '--label needs a value'],
    [['relearn', 'a-fact', '--title', ''], '--title needs a value'],
    [['entities', 'rename', 'ops', '--description', ''], '--description needs a value'],
  ])('refuses an empty value, %j, instead of sending "true" or dropping it', async (args, said) => {
    const seen: Seen[] = []
    const base = await serve({}, seen)
    const { code, stderr } = await run(args, base)
    expect(code).not.toBe(0)
    expect(stderr).toContain(said)
    expect(seen).toEqual([])
  })
})

describe('knowledge', () => {
  const entry = { slug: 'a-fact', title: 'New title' }

  it('retitles with relearn --title, and only the title', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'PATCH /api/v1/knowledge/a-fact': entry }, seen)
    expect((await run(['relearn', 'a-fact', '--title', 'New title'], base)).code).toBe(0)
    expect(seen[0]?.body).toEqual({ title: 'New title' })
  })

  it('takes a supersession back and clears the verified mark', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'PATCH /api/v1/knowledge/a-fact': entry }, seen)
    await run(['relearn', 'a-fact', '--superseded-by', 'none', '--reason', 'wrong successor'], base)
    await run(['relearn', 'a-fact', '--unverify'], base)
    await run(['relearn', 'a-fact', '--label', 'none'], base)
    expect(seen.map((s) => s.body)).toEqual([
      { supersededBy: null, reason: 'wrong successor' },
      { verified: false },
      { labels: [] },
    ])
  })

  it('refuses --verified with --unverify', async () => {
    const seen: Seen[] = []
    const base = await serve({}, seen)
    const { code, stderr } = await run(['relearn', 'a-fact', '--verified', '--unverify'], base)
    expect(code).not.toBe(0)
    expect(stderr).toContain('opposite')
    expect(seen).toEqual([])
  })
})

describe('comments and the work log', () => {
  it('reads the comments of a task', async () => {
    const seen: Seen[] = []
    const base = await serve({
      'GET /api/v1/tasks/CIVIC-1/comments': [
        { id: 'c1', content: 'Please keep the old URL.\nThanks.', actor_id: 'Cal', created_at: '2026-10-11T08:00:00Z' },
      ],
    }, seen)
    const { code, stdout } = await run(['comments', 'CIVIC-1'], base)
    expect(code).toBe(0)
    expect(stdout).toContain('Cal')
    expect(stdout).toContain('Please keep the old URL.')
    expect(stdout).toContain('Thanks.')
  })

  it('marks an edited comment and shows its id', async () => {
    const base = await serve({
      'GET /api/v1/tasks/CIVIC-1/comments': [
        { id: 'c1', content: 'x', actor_id: 'Cal', created_at: '2026-10-11T08:00:00Z', edited_at: '2026-10-11T09:00:00Z' },
        { id: 'c2', content: 'y', actor_id: 'Cal', created_at: '2026-10-11T08:05:00Z', edited_at: null },
      ],
    }, [])
    const lines = (await run(['comments', 'CIVIC-1'], base)).stdout.split('\n')
    expect(lines.find((l) => l.endsWith('c1'))).toContain('(edited)')
    expect(lines.find((l) => l.endsWith('c2'))).not.toContain('(edited)')
  })

  it('comment edit patches the comment by id or prefix, and plain comment still posts', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    const seen: Seen[] = []
    const base = await serve({
      'GET /api/v1/tasks/CIVIC-1/comments': [{ id, content: 'old' }],
      [`PATCH /api/v1/tasks/CIVIC-1/comments/${id}`]: { id, content: 'new', edited_at: '2026-10-11T09:00:00Z' },
      'POST /api/v1/tasks/CIVIC-1/comments': { id: 'new-one' },
    }, seen)

    expect((await run(['comment', 'edit', 'CIVIC-1', id.slice(0, 8), 'new'], base)).code).toBe(0)
    expect(seen.find((s) => s.method === 'PATCH')?.body).toEqual({ content: 'new' })

    seen.length = 0
    expect((await run(['comment', 'CIVIC-1', 'hello'], base)).code).toBe(0)
    expect(writes(seen).map((s) => [s.method, s.path, s.body])).toEqual([
      ['POST', '/api/v1/tasks/CIVIC-1/comments', { content: 'hello' }],
    ])
  })

  it('comment edit refuses an id the task does not have, without writing', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'GET /api/v1/tasks/CIVIC-1/comments': [{ id: 'aaaaaaaa-0000-4000-8000-000000000001' }] }, seen)
    const miss = await run(['comment', 'edit', 'CIVIC-1', '99999999-0000-4000-8000-000000000000', 'x'], base)
    expect(miss.code).not.toBe(0)
    expect(miss.stderr).toContain('cairn comments CIVIC-1')
    expect(writes(seen)).toEqual([])
  })

  it('says so when there are none', async () => {
    const base = await serve({ 'GET /api/v1/tasks/CIVIC-1/comments': [] }, [])
    expect((await run(['comments', 'CIVIC-1'], base)).stdout).toContain('no comments on CIVIC-1')
  })

  it('prints the note id as the last column of the log', async () => {
    const base = await serve({
      'GET /api/v1/tasks/CIVIC-1/notes': [
        { id: NOTE_ID, kind: 'note', actor_id: 'a', created_at: '2026-10-11T08:00:00Z', note: 'hello' },
      ],
    }, [])
    const { stdout } = await run(['log', 'CIVIC-1'], base)
    const [header, row] = stdout.split('\n').slice(1)
    expect(header!.split('\t').slice(-1)).toEqual(['id'])
    expect(row!.split('\t').slice(-1)).toEqual([NOTE_ID])
  })

  it('unnote deletes by id or by a unique prefix, and refuses an id the task does not have', async () => {
    const seen: Seen[] = []
    const base = await serve({
      'GET /api/v1/tasks/CIVIC-1/notes': [{ id: NOTE_ID, kind: 'note', note: 'x' }],
      [`DELETE /api/v1/tasks/CIVIC-1/notes/${NOTE_ID}`]: { deleted: true, id: NOTE_ID },
    }, seen)

    expect((await run(['unnote', 'CIVIC-1', NOTE_ID.slice(0, 8)], base)).code).toBe(0)
    expect(writes(seen)).toEqual([{ method: 'DELETE', path: `/api/v1/tasks/CIVIC-1/notes/${NOTE_ID}` }])

    seen.length = 0
    const miss = await run(['unnote', 'CIVIC-1', '99999999-0000-4000-8000-000000000000'], base)
    expect(miss.code).not.toBe(0)
    expect(miss.stderr).toContain('cairn log CIVIC-1')
    expect(writes(seen)).toEqual([])
  })
})

describe('removing a file', () => {
  it('detach takes a task file by id from the task’s own list', async () => {
    const seen: Seen[] = []
    const base = await serve({
      'GET /api/v1/tasks/CIVIC-1/attachments': [{ id: FILE_ID, original_name: 'a.png' }],
      [`DELETE /api/v1/attachments/${FILE_ID}`]: { deleted: true },
    }, seen)
    expect((await run(['detach', 'CIVIC-1', FILE_ID], base)).code).toBe(0)
    expect(writes(seen)).toEqual([{ method: 'DELETE', path: `/api/v1/attachments/${FILE_ID}` }])
  })

  it('detach refuses an id that belongs to another task', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'GET /api/v1/tasks/CIVIC-1/attachments': [] }, seen)
    const { code } = await run(['detach', 'CIVIC-1', FILE_ID], base)
    expect(code).not.toBe(0)
    expect(writes(seen)).toEqual([])
  })

  it('subject detach goes through the subject', async () => {
    const seen: Seen[] = []
    const base = await serve({
      'GET /api/v1/subjects/LAB-3/attachments': [{ id: FILE_ID, filename: 'a.png' }],
      [`DELETE /api/v1/subjects/LAB-3/attachments/${FILE_ID}`]: { deleted: true },
    }, seen)
    expect((await run(['subject', 'detach', 'LAB-3', FILE_ID], base)).code).toBe(0)
    expect(writes(seen)).toEqual([{ method: 'DELETE', path: `/api/v1/subjects/LAB-3/attachments/${FILE_ID}` }])
  })
})

describe('people’s notes on a subject', () => {
  const list = [{ id: NOTE_ID, body: 'old', author: { name: 'Cal' }, created_at: '2026-10-11T08:00:00Z' }]

  it('lists with ids, adds, edits and deletes', async () => {
    const seen: Seen[] = []
    const base = await serve({
      'GET /api/v1/subjects/LAB-3/human-notes': list,
      'POST /api/v1/subjects/LAB-3/human-notes': list[0],
      [`PATCH /api/v1/subjects/LAB-3/human-notes/${NOTE_ID}`]: list[0],
      [`DELETE /api/v1/subjects/LAB-3/human-notes/${NOTE_ID}`]: { id: NOTE_ID, deleted: true },
    }, seen)

    expect((await run(['subject', 'notes', 'LAB-3'], base)).stdout).toContain(NOTE_ID)
    await run(['subject', 'notes', 'LAB-3', 'add', '-'], base, '## Seen\n\nin the call\n')
    await run(['subject', 'notes', 'LAB-3', 'edit', NOTE_ID.slice(0, 8), 'new text'], base)
    await run(['subject', 'notes', 'LAB-3', 'delete', NOTE_ID], base)

    expect(writes(seen)).toEqual([
      { method: 'POST', path: '/api/v1/subjects/LAB-3/human-notes', body: { body: '## Seen\n\nin the call' } },
      { method: 'PATCH', path: `/api/v1/subjects/LAB-3/human-notes/${NOTE_ID}`, body: { body: 'new text' } },
      { method: 'DELETE', path: `/api/v1/subjects/LAB-3/human-notes/${NOTE_ID}` },
    ])
  })

  it('refuses a verb it does not have, and an edit with no text', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'GET /api/v1/subjects/LAB-3/human-notes': list }, seen)
    expect((await run(['subject', 'notes', 'LAB-3', 'remove', NOTE_ID], base)).code).not.toBe(0)
    expect((await run(['subject', 'notes', 'LAB-3', 'edit', NOTE_ID], base)).code).not.toBe(0)
    expect(writes(seen)).toEqual([])
  })
})

describe('projects and entities', () => {
  it.each(['planning', 'active', 'paused', 'completed', 'archived'])('project status sets %s', async (status) => {
    const seen: Seen[] = []
    const base = await serve({ 'PATCH /api/v1/projects/CIVIC': { key: 'CIVIC', status } }, seen)
    expect((await run(['project', 'status', 'CIVIC', status], base)).code).toBe(0)
    expect(seen[0]?.body).toEqual({ status })
  })

  it('project status refuses a state the server does not have', async () => {
    const seen: Seen[] = []
    const base = await serve({}, seen)
    const { code, stderr } = await run(['project', 'status', 'CIVIC', 'someday'], base)
    expect(code).not.toBe(0)
    expect(stderr).toContain('planning|active|paused|completed|archived')
    expect(seen).toEqual([])
  })

  it('entities delete needs the key typed back, then deletes', async () => {
    const seen: Seen[] = []
    const base = await serve({
      'GET /api/v1/entities': { results: [{ key: 'ops', title: 'Ops', projects: ['A', 'B'] }] },
      'DELETE /api/v1/entities?key=ops': { deleted: 'ops', projectsUnlinked: 2, knowledgeWidenedToGlobal: 3 },
    }, seen)

    const refused = await run(['entities', 'delete', 'ops'], base)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('2 project(s)')
    expect(writes(seen)).toEqual([])

    expect((await run(['entities', 'delete', 'ops', '--confirm', 'ops'], base)).code).toBe(0)
    expect(writes(seen)).toEqual([{ method: 'DELETE', path: '/api/v1/entities?key=ops' }])
  })

  it('entities rename --description none empties it', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'PATCH /api/v1/entities': { key: 'ops' } }, seen)
    await run(['entities', 'rename', 'ops', '--description', 'none'], base)
    expect(seen[0]?.body).toEqual({ key: 'ops', description: '' })
  })
})

describe('the help', () => {
  it('offers retitling, which the usage error used to be the only place to learn', async () => {
    const base = await serve({}, [])
    const { stdout } = await run(['help'], base)
    expect(stdout).toContain('--title T  retitle it')
    expect(stdout).toContain('cairn comments <ref>')
    expect(stdout).toContain('cairn project status <KEY>')
  })
})
