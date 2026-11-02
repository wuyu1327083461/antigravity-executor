/**
 * v0.8.0 REST contract and rollback correctness (PRD §4.1, REQ-03).
 *
 * WHY BOTH HALVES LIVE IN ONE FILE
 * --------------------------------
 * The rollback route's whole value is the *effect* it has on disk, and the route
 * that produces that effect is the one under test. Splitting "the route answers
 * 200" from "the working tree is correct" would let the two drift: a handler that
 * returns `{ok:true}` while restoring nothing would pass the route test alone.
 *
 * The rollback test uses a real git repository with a real dirty worktree because
 * that is the only configuration in which the feature's central claim — "restores
 * this turn's files, leaves pre-existing edits alone" — is even meaningful.
 *
 * @module antigravity-executor/lib/control-routes.test.mjs
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { capturePreTurnSnapshot, rollbackTurn } from './snapshot.js'
import { createTelemetryBus } from './telemetry.mjs'
import { startUiServer } from './ui-server.mjs'

const exec = promisify(execFile)
const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true })

const sh = { dir: undefined, server: undefined, turnId: undefined, snap: undefined }
const ORIGIN = 'http://127.0.0.1'

const post = async (base, path, body, origin = ORIGIN) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin === '' ? {} : { origin }) },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const get = async (base, path) => {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, json: await res.json().catch(() => null) }
}

describe('v0.8.0 control routes and rollback', () => {
  it('builds a dirty git workspace and serves the routes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy ctl '))
    sh.dir = dir
    await git(dir, 'init', '-b', 'main')
    await git(dir, 'config', 'user.email', 't@t.local')
    await git(dir, 'config', 'user.name', 't')
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'app.js'), 'const x = 1\n')
    await writeFile(join(dir, 'keep.txt'), 'committed\n')
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-m', 'base')

    // Work that existed BEFORE the turn and must survive the rollback.
    await writeFile(join(dir, 'keep.txt'), 'USER EDIT\n')
    await writeFile(join(dir, 'user-file.txt'), 'USER UNTRACKED\n')

    sh.snap = await capturePreTurnSnapshot(dir)
    sh.turnId = 'turn-test'

    // What "the turn" writes.
    await writeFile(join(dir, 'src', 'app.js'), 'const x = 1\nconst y = 2\nconst z = 3\n')
    await writeFile(join(dir, 'turn-new.txt'), 'created by the turn\n')

    const bus = createTelemetryBus()
    bus.setWorkspaceDir(dir)
    const turn = bus.startTurn({
      sessionId: 's',
      conversationId: 'c',
      effectiveMode: 'surgical',
      snapshotSha: sh.snap.snapshotSha,
    })
    sh.turnId = turn.turnId
    bus.settleTurn(turn.turnId, {
      status: 'ok',
      touchedFiles: [join(dir, 'src/app.js')],
      changedFiles: [{ path: 'src/app.js', added: 2, removed: 0 }],
    })

    sh.server = await startUiServer({
      bus,
      host: '127.0.0.1',
      port: 0,
      readDiff: async ({ relative }) => {
        const r = await exec('git', ['-C', dir, 'diff', '--no-color', '--', relative], {
          windowsHide: true,
        })
        const text = r.stdout
        const added = text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
        const removed = text.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
        return { file: relative, diffText: text, stats: { added, removed } }
      },
      rollbackTurnFn: async () => rollbackTurn(dir, sh.snap, { touchedFiles: [join(dir, 'src/app.js')] }),
      rolloverSessionFn: async (sessionId) => ({ ok: true, sessionId, briefSummary: 'brief' }),
      saveConfig: async () => ({ savedPath: join(dir, 'cordis.patch.yml'), applied: ['thinkingLevel'] }),
    })
    assert.ok(sh.server.url.startsWith('http://127.0.0.1:'))
  })

  it('GET /api/git-diff returns a unified diff with stats', async () => {
    const diff = await get(sh.server.url, `/api/git-diff?turnId=${sh.turnId}&file=src/app.js`)
    assert.equal(diff.status, 200)
    assert.match(diff.json.diffText, /\+const y = 2/)
    assert.equal(diff.json.stats.added, 2)
  })

  it('GET /api/git-diff refuses a path outside the workspace', async () => {
    const bad = await get(sh.server.url, '/api/git-diff?file=../../../../etc/passwd')
    assert.equal(bad.status, 403, 'a traversal attempt must be refused, not silently resolved')
  })

  it('POST /api/control/rollback restores only this turn\u2019s files', async () => {
    const result = await post(sh.server.url, '/api/control/rollback', { turnId: sh.turnId })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)

    assert.equal(await readFile(join(sh.dir, 'src', 'app.js'), 'utf8'), 'const x = 1\n',
      'the file the turn modified must be restored to its pre-turn content')
    assert.equal(await readFile(join(sh.dir, 'keep.txt'), 'utf8'), 'USER EDIT\n',
      'a pre-existing uncommitted edit must survive the rollback')
    assert.equal(await readFile(join(sh.dir, 'user-file.txt'), 'utf8'), 'USER UNTRACKED\n',
      'a pre-existing untracked file must survive the rollback')
    await assert.rejects(
      () => readFile(join(sh.dir, 'turn-new.txt'), 'utf8'),
      'a file the turn created must be removed',
    )
    const stash = (await git(sh.dir, 'stash', 'list')).stdout.trim()
    assert.equal(stash, '', 'stash create must not put anything into stash list')
  })

  it('POST /api/control/rollback refuses a non-loopback Origin', async () => {
    const foreign = await post(
      sh.server.url,
      '/api/control/rollback',
      { turnId: sh.turnId },
      'https://evil.example',
    )
    assert.equal(foreign.status, 403)
  })

  it('POST /api/sessions/rollover validates its input', async () => {
    const ok = await post(sh.server.url, '/api/sessions/rollover', { sessionId: 's' })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    const empty = await post(sh.server.url, '/api/sessions/rollover', { sessionId: '' })
    assert.equal(empty.status, 400)
  })

  it('POST /api/control/config/save reports where it wrote', async () => {
    const saved = await post(sh.server.url, '/api/control/config/save', {})
    assert.equal(saved.status, 200)
    assert.equal(typeof saved.json.savedPath, 'string')
  })

  it('an unwired control route answers 501 instead of failing obscurely', async () => {
    const bare = await startUiServer({ bus: createTelemetryBus(), host: '127.0.0.1', port: 0 })
    try {
      const res = await fetch(`${bare.url}/api/git-diff?file=a.js`)
      assert.equal(res.status, 501)
    } finally {
      await bare.close()
    }
  })

  after(async () => {
    if (sh.server !== undefined) await sh.server.close()
    if (sh.dir !== undefined) await rm(sh.dir, { recursive: true, force: true })
  })
})
