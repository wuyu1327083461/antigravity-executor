/**
 * Unit tests for the durable session store.
 *
 * The store guards the only piece of state that survives a dsh restart, so the
 * atomic-write path and the corrupt-file path are both exercised directly: a
 * truncated `sessions.json` must degrade to "no known conversations", never to
 * a thrown error that would block every future delegation.
 *
 * Run: node --test lib/sessions.test.js
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createSessionStore, longSessionHint, nextTurnCount, sessionKey } from './sessions.js'

/** Fresh scratch directory with a store bound to `<dir>/sessions.json`. */
async function withStore(t) {
  const dir = await mkdtemp(join(process.env.TEMP ?? process.env.TMPDIR ?? homedir(), 'agy-sessions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'sessions.json')
  return { dir, filePath, store: createSessionStore(filePath) }
}

// ---------------------------------------------------------------------------
// keying
// ---------------------------------------------------------------------------

test('sessionKey scopes a session name to its workspace', () => {
  assert.equal(sessionKey('E:\\a', 'main'), 'E:\\a::main')
  // The same session name in two projects must not collide.
  assert.notEqual(sessionKey('E:\\a', 'main'), sessionKey('E:\\b', 'main'))
})

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------

test('load returns an empty map when the file does not exist', async (t) => {
  const { store } = await withStore(t)
  assert.deepEqual(await store.load(), {})
})

test('save then load round-trips the map', async (t) => {
  const { store, filePath } = await withStore(t)
  const state = {}
  store.set(state, {
    sessionId: 'main-dev-session',
    workspace: 'E:\\work\\proj',
    conversationId: 'conv-1',
    tier: 'flash',
  })

  assert.equal(await store.save(state), true)
  const reloaded = await store.load()
  assert.deepEqual(reloaded, state)

  // Written as pretty JSON with a trailing newline, matching the repo's style.
  const raw = await readFile(filePath, 'utf8')
  assert.match(raw, /^\{\n/)
  assert.match(raw, /\n$/)
})

test('save creates the parent directory when it is missing', async (t) => {
  const { dir } = await withStore(t)
  const nested = join(dir, 'deep', 'deeper', 'sessions.json')
  const store = createSessionStore(nested)

  assert.equal(await store.save({ a: { session_id: 'a' } }), true)
  assert.deepEqual(await store.load(), { a: { session_id: 'a' } })
})

test('save is atomic: it leaves no .tmp file behind', async (t) => {
  const { store, dir } = await withStore(t)
  await store.save({ a: { session_id: 'a' } })
  await store.save({ a: { session_id: 'a' }, b: { session_id: 'b' } })

  const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('a failed save returns false instead of throwing', async (t) => {
  const { dir } = await withStore(t)
  // Point the store at a path whose parent is a *file*, so mkdir fails.
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'x')
  const store = createSessionStore(join(blocker, 'sessions.json'))

  assert.equal(await store.save({ a: 1 }), false)
})

test('load tolerates a corrupt JSON file', async (t) => {
  const { store, filePath } = await withStore(t)
  await writeFile(filePath, '{ this is not json')
  assert.deepEqual(await store.load(), {})
})

test('load tolerates an empty file', async (t) => {
  const { store, filePath } = await withStore(t)
  await writeFile(filePath, '   \n')
  assert.deepEqual(await store.load(), {})
})

test('load rejects a non-object payload', async (t) => {
  const { store, filePath } = await withStore(t)
  // A JSON array or scalar is not a usable map; degrade rather than crash.
  await writeFile(filePath, '[1,2,3]')
  assert.deepEqual(await store.load(), {})
  await writeFile(filePath, '"just a string"')
  assert.deepEqual(await store.load(), {})
})

test('load strips a UTF-8 BOM left by a Windows editor', async (t) => {
  const { store, filePath } = await withStore(t)
  await writeFile(filePath, `\uFEFF${JSON.stringify({ k: { session_id: 'k' } })}`)
  assert.deepEqual(await store.load(), { k: { session_id: 'k' } })
})

// ---------------------------------------------------------------------------
// get / set
// ---------------------------------------------------------------------------

test('set writes the contract record shape', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  const now = new Date('2026-10-29T10:00:00.000Z')
  const record = store.set(state, {
    sessionId: 'main-dev-session',
    workspace: 'E:\\work\\proj',
    conversationId: 'conv-1',
    tier: 'pro',
    now,
  })

  assert.deepEqual(record, {
    session_id: 'main-dev-session',
    conversation_id: 'conv-1',
    workspace_dir: 'E:\\work\\proj',
    tier: 'pro',
    created_at: '2026-10-29T10:00:00.000Z',
    updated_at: '2026-10-29T10:00:00.000Z',
  })
  assert.deepEqual(store.get(state, 'E:\\work\\proj', 'main-dev-session'), record)
})

test('set preserves created_at across updates and moves updated_at', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    tier: 'pro',
    now: new Date('2026-10-01T00:00:00.000Z'),
  })
  const updated = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-2',
    tier: 'flash',
    now: new Date('2026-10-29T00:00:00.000Z'),
  })

  assert.equal(updated.created_at, '2026-10-01T00:00:00.000Z')
  assert.equal(updated.updated_at, '2026-10-29T00:00:00.000Z')
  assert.equal(updated.conversation_id, 'conv-2')
  assert.equal(updated.tier, 'flash')
})

test('set keeps an existing conversation when the update omits it', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'main', workspace: 'E:\\p', conversationId: 'conv-1' })
  const updated = store.set(state, { sessionId: 'main', workspace: 'E:\\p', tier: 'flash' })
  assert.equal(updated.conversation_id, 'conv-1')
})

test('set accepts a persisted snake_case record back in', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  const record = store.set(state, {
    session_id: 'main',
    workspace_dir: 'E:\\p',
    conversation_id: 'conv-9',
    tier: 'pro',
  })
  assert.equal(record.session_id, 'main')
  assert.equal(record.workspace_dir, 'E:\\p')
  assert.equal(record.conversation_id, 'conv-9')
})

test('set rejects a record without workspace or session id', async (t) => {
  const { store } = await withStore(t)
  assert.throws(() => store.set({}, { sessionId: 'main' }), TypeError)
  assert.throws(() => store.set({}, { workspace: 'E:\\p' }), TypeError)
})

test('get returns undefined for an unknown or malformed state', async (t) => {
  const { store } = await withStore(t)
  assert.equal(store.get({}, 'E:\\p', 'main'), undefined)
  assert.equal(store.get(undefined, 'E:\\p', 'main'), undefined)
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list returns most-recently-updated first and honours the limit', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'a', workspace: 'E:\\p', now: new Date('2026-10-01T00:00:00Z') })
  store.set(state, { sessionId: 'b', workspace: 'E:\\p', now: new Date('2026-10-20T00:00:00Z') })
  store.set(state, { sessionId: 'c', workspace: 'E:\\p', now: new Date('2026-10-10T00:00:00Z') })

  assert.deepEqual(store.list(state).map((r) => r.session_id), ['b', 'c', 'a'])
  assert.deepEqual(store.list(state, 2).map((r) => r.session_id), ['b', 'c'])
})

test('list defaults to 20 rows and ignores a bad limit', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  for (let i = 0; i < 25; i += 1) {
    store.set(state, {
      sessionId: `s${i}`,
      workspace: 'E:\\p',
      now: new Date(2026, 0, 1 + i),
    })
  }
  assert.equal(store.list(state).length, 20)
  assert.equal(store.list(state, 'nonsense').length, 20)
})

test('list returns [] for an empty or malformed state', async (t) => {
  const { store } = await withStore(t)
  assert.deepEqual(store.list({}), [])
  assert.deepEqual(store.list(undefined), [])
})

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

test('prune removes records older than keepDays and keeps recent ones', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  const now = new Date('2026-10-29T00:00:00Z')
  store.set(state, { sessionId: 'old', workspace: 'E:\\p', now: new Date('2026-09-01T00:00:00Z') })
  store.set(state, { sessionId: 'recent', workspace: 'E:\\p', now: new Date('2026-10-25T00:00:00Z') })

  const result = store.prune(state, { keepDays: 30, now })
  assert.equal(result.removed, 1)
  assert.equal(result.kept, 1)
  assert.equal(store.get(state, 'E:\\p', 'recent').session_id, 'recent')
  assert.equal(store.get(state, 'E:\\p', 'old'), undefined)
})

test('prune keeps records with no usable timestamp', async (t) => {
  const { store } = await withStore(t)
  const state = { orphan: { session_id: 'orphan', workspace_dir: 'E:\\p' } }
  const result = store.prune(state, { keepDays: 1, now: Date.parse('2026-10-29T00:00:00Z') })
  // Deleting a record we cannot date is worse than keeping it.
  assert.equal(result.removed, 0)
  assert.equal(state.orphan.session_id, 'orphan')
})

test('prune defaults to 30 days and handles a malformed state', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'ancient', workspace: 'E:\\p', now: new Date('2026-01-01T00:00:00Z') })
  assert.equal(store.prune(state).removed, 1)
  assert.deepEqual(store.prune(undefined), { removed: 0, kept: 0 })
})

test('a pruned map still round-trips through disk', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'keep', workspace: 'E:\\p' })
  store.set(state, { sessionId: 'drop', workspace: 'E:\\p', now: new Date('2020-01-01T00:00:00Z') })
  store.prune(state, { keepDays: 30 })

  await store.save(state)
  assert.deepEqual(Object.keys(await store.load()), [sessionKey('E:\\p', 'keep')])
})

// ---------------------------------------------------------------------------
// integration: two stores on the same file see each other's writes
// ---------------------------------------------------------------------------

test('a second store observes the first store\'s saved state', async (t) => {
  const { filePath, store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'main', workspace: 'E:\\p', conversationId: 'conv-1' })
  await store.save(state)

  const other = createSessionStore(filePath)
  const reloaded = await other.load()
  assert.equal(other.get(reloaded, 'E:\\p', 'main').conversation_id, 'conv-1')
})

test('saving over a corrupt file repairs it', async (t) => {
  const { store, filePath } = await withStore(t)
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, 'not json at all')

  const state = await store.load() // {}
  store.set(state, { sessionId: 'main', workspace: 'E:\\p' })
  await store.save(state)

  assert.equal(Object.keys(await store.load()).length, 1)
})

// ---------------------------------------------------------------------------
// v0.5.0: dead-session eviction and turn counting
// ---------------------------------------------------------------------------

test('remove drops one record and leaves the rest intact', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'dead', workspace: 'E:\\p', conversationId: 'conv-dead' })
  store.set(state, { sessionId: 'live', workspace: 'E:\\p', conversationId: 'conv-live' })

  const removed = store.remove(state, 'E:\\p', 'dead')
  assert.equal(removed.conversation_id, 'conv-dead')
  // The surviving record is untouched: an eviction must not disturb other work.
  assert.equal(store.get(state, 'E:\\p', 'live').conversation_id, 'conv-live')
  assert.equal(store.get(state, 'E:\\p', 'dead'), undefined)
  // Evicting twice is harmless.
  assert.equal(store.remove(state, 'E:\\p', 'dead'), undefined)
})

test('remove tolerates a malformed state and an unknown key', async (t) => {
  const { store } = await withStore(t)
  assert.equal(store.remove({}, 'E:\\p', 'nope'), undefined)
  assert.equal(store.remove(undefined, 'E:\\p', 'nope'), undefined)
  assert.equal(store.remove(null, 'E:\\p', 'nope'), undefined)
})

test('an evicted session is really gone after a reload', async (t) => {
  // This is the whole point: the eviction must survive a dsh restart, or the
  // dead conversation would come back on the next launch.
  const { store, filePath } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'dead', workspace: 'E:\\p', conversationId: 'conv-dead' })
  await store.save(state)

  const reloaded = await store.load()
  store.remove(reloaded, 'E:\\p', 'dead')
  await store.save(reloaded)

  const other = createSessionStore(filePath)
  assert.equal(Object.keys(await other.load()).length, 0)
})

test('nextTurnCount increments within one conversation and restarts on a new one', () => {
  assert.equal(nextTurnCount(undefined, 'conv-1'), 1)
  assert.equal(nextTurnCount({ conversation_id: 'conv-1', turn_count: 3 }, 'conv-1'), 4)
  // A new conversation must not inherit the old thread's count.
  assert.equal(nextTurnCount({ conversation_id: 'conv-1', turn_count: 9 }, 'conv-2'), 1)
  // An explicit override wins.
  assert.equal(nextTurnCount({ conversation_id: 'conv-1', turn_count: 3 }, 'conv-1', 7), 7)
})

test('nextTurnCount tolerates a record with no usable count', () => {
  assert.equal(nextTurnCount({ conversation_id: 'conv-1' }, 'conv-1'), 1)
  assert.equal(nextTurnCount({ conversation_id: 'conv-1', turn_count: 'nonsense' }, 'conv-1'), 1)
  assert.equal(nextTurnCount({ conversation_id: 'conv-1', turn_count: -5 }, 'conv-1'), 1)
})

test('set persists turn_count when the caller supplies it', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  const record = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    turns: 4,
  })
  assert.equal(record.turn_count, 4)
})

test('set keeps an existing turn_count when the conversation is unchanged', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'main', workspace: 'E:\\p', conversationId: 'conv-1', turns: 2 })
  const updated = store.set(state, { sessionId: 'main', workspace: 'E:\\p', conversationId: 'conv-1', tier: 'flash' })
  assert.equal(updated.turn_count, 2)
})

test('set drops a stale turn_count when the conversation changes', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'main', workspace: 'E:\\p', conversationId: 'conv-1', turns: 9 })
  const updated = store.set(state, { sessionId: 'main', workspace: 'E:\\p', conversationId: 'conv-2' })
  assert.equal(updated.turn_count, undefined)
  assert.equal(updated.conversation_id, 'conv-2')
})

test('set omits turn_count entirely for a v0.4.0-shaped record', async (t) => {
  // Backward compatibility: a record written without a count keeps exactly the
  // keys 0.4.0 wrote, so an old sessions.json round-trips unchanged.
  const { store } = await withStore(t)
  const state = {}
  const record = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    tier: 'pro',
    now: new Date('2026-10-29T10:00:00.000Z'),
  })
  assert.deepEqual(Object.keys(record).sort(), [
    'conversation_id',
    'created_at',
    'session_id',
    'tier',
    'updated_at',
    'workspace_dir',
  ])
})

test('longSessionHint fires only at or above the threshold', () => {
  assert.equal(longSessionHint({ turn_count: 3 }, 8), undefined)
  assert.equal(longSessionHint({ turn_count: 8 }, 8), 'hint         : 本 session_id 已连续 8 轮（阈值 8）。同一个 conversation 每轮都会携带更长的历史，账号配额消耗随之放大；下一个独立子功能建议换一个新的 session_id。')
  assert.match(longSessionHint({ turn_count: 12 }, 8), /已连续 12 轮/)
})

test('longSessionHint tolerates a record with no count or a bad threshold', () => {
  assert.equal(longSessionHint({}, 8), undefined)
  assert.equal(longSessionHint(undefined, 8), undefined)
  assert.equal(longSessionHint({ turn_count: 20 }, 0), undefined)
  assert.equal(longSessionHint({ turn_count: 20 }, 'x'), undefined)
})

test('longSessionHint uses eight turns by default', () => {
  assert.equal(longSessionHint({ turn_count: 7 }), undefined)
  assert.match(longSessionHint({ turn_count: 8 }), /已连续 8 轮/)
})
