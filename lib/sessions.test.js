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

import {
  contextRecoveryBanner,
  createSessionStore,
  longSessionHint,
  mergeRolloverBrief,
  nextTurnCount,
  nextTurnCountAfterRollover,
  projectSessionRow,
  rolloverSessionPatch,
  sessionKey,
} from './sessions.js'

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

// ---------------------------------------------------------------------------
// REQ-03: the context a follow-up request will be missing
// ---------------------------------------------------------------------------

test('set persists the touched files and the task head under their stored names', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  const record = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    lastTouchedFiles: ['src/a.js', 'src/b.js'],
    lastTaskHead: 'refactor the parser',
  })
  assert.deepEqual(record.last_touched_files, ['src/a.js', 'src/b.js'])
  assert.equal(record.last_task_head, 'refactor the parser')
  // The camelCase input names never leak into the persisted shape.
  assert.equal('lastTouchedFiles' in record, false)
  assert.equal('lastTaskHead' in record, false)
})

test('last_touched_files drops non-strings, de-duplicates and keeps first-seen order', async (t) => {
  const { store } = await withStore(t)
  const record = store.set({}, {
    sessionId: 'main',
    workspace: 'E:\\p',
    last_touched_files: ['b.js', 'a.js', 'b.js', '', '   ', 7, null, { x: 1 }, ' a.js '],
  })
  assert.deepEqual(record.last_touched_files, ['b.js', 'a.js'])
})

test('last_touched_files and last_task_head are capped', async (t) => {
  const { store } = await withStore(t)
  const files = Array.from({ length: 15 }, (_, i) => `file-${i}.js`)
  const record = store.set({}, {
    sessionId: 'main',
    workspace: 'E:\\p',
    lastTouchedFiles: files,
    lastTaskHead: 'z'.repeat(500),
  })
  // A runaway file list or a pasted transcript must not grow the record without
  // bound: the record is re-read on every delegation.
  assert.equal(record.last_touched_files.length, 10)
  assert.deepEqual(record.last_touched_files, files.slice(0, 10))
  assert.equal(record.last_task_head.length, 200)
  assert.equal(record.last_task_head, 'z'.repeat(200))
})

test('last_task_head is trimmed, and an empty one counts as "not supplied"', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  assert.equal(
    store.set(state, { sessionId: 'main', workspace: 'E:\\p', lastTaskHead: '  fix it  ' }).last_task_head,
    'fix it',
  )
  const blank = store.set(state, { sessionId: 'main', workspace: 'E:\\p', lastTaskHead: '   ' })
  // Nothing was supplied, so the key is absent — not an empty string.
  assert.equal('last_task_head' in blank, false)
})

test('omitting the new fields on an update preserves the stored ones', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    turns: 2,
    lastTouchedFiles: ['a.js'],
    lastTaskHead: 'fix the parser',
  })
  const updated = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    tier: 'flash',
  })
  assert.deepEqual(updated.last_touched_files, ['a.js'])
  assert.equal(updated.last_task_head, 'fix the parser')
})

test('a changed conversation_id does not inherit the previous thread context', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    turns: 9,
    lastTouchedFiles: ['a.js', 'b.js'],
    lastTaskHead: 'fix the parser',
  })
  const fresh = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-2',
  })
  // Same reasoning as turn_count: this is a new thread, and the old thread's
  // files and task describe work the new conversation has never seen.
  assert.equal('last_touched_files' in fresh, false)
  assert.equal('last_task_head' in fresh, false)
  assert.equal(fresh.conversation_id, 'conv-2')
})

test('a v0.5.x-shaped record round-trips without the new keys', async (t) => {
  const { store } = await withStore(t)
  const record = store.set({}, {
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

test('the new fields survive a save/load round-trip', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    lastTouchedFiles: ['src/a.js'],
    lastTaskHead: 'fix the parser',
  })
  await store.save(state)
  const reloaded = await store.load()
  assert.deepEqual(reloaded, state)
  const record = reloaded[sessionKey('E:\\p', 'main')]
  assert.deepEqual(Object.keys(record).filter((k) => k.startsWith('last_')), [
    'last_touched_files',
    'last_task_head',
  ])
})

// ---------------------------------------------------------------------------
// REQ-03: contextRecoveryBanner
// ---------------------------------------------------------------------------

const BANNER_FIRST = (id) =>
  `[Context Recovery Note: The previous conversation thread for session "${id}" expired and a fresh conversation was opened.`
const BANNER_LAST =
  'Please inspect the relevant files in the workspace first before applying the following incremental request.]'

test('contextRecoveryBanner names the session and both remembered facts', () => {
  const banner = contextRecoveryBanner(
    { session_id: 'main', turn_count: 2, last_touched_files: ['a.js', 'b.js'], last_task_head: 'fix it' },
    { sessionId: 'main' },
  )
  assert.equal(
    banner,
    [
      BANNER_FIRST('main'),
      'Previously touched files in this session: a.js, b.js.',
      'Previous task summary: fix it.',
      BANNER_LAST,
    ].join('\n'),
  )
})

test('the first and last banner lines are verbatim, whatever else is present', () => {
  const full = contextRecoveryBanner(
    { session_id: 's', turn_count: 1, last_touched_files: ['a.js'], last_task_head: 't' },
    { sessionId: 's' },
  )
  const lines = full.split('\n')
  assert.equal(lines[0], BANNER_FIRST('s'))
  assert.equal(lines.at(-1), BANNER_LAST)
  assert.equal(
    lines[0],
    '[Context Recovery Note: The previous conversation thread for session "s" expired and a fresh conversation was opened.',
  )
  assert.equal(
    lines.at(-1),
    'Please inspect the relevant files in the workspace first before applying the following incremental request.]',
  )
})

test('a files-only banner omits the task-summary line', () => {
  const banner = contextRecoveryBanner({ session_id: 's', turn_count: 1, last_touched_files: ['a.js'] })
  assert.match(banner, /^\[Context Recovery Note/)
  assert.match(banner, /Previously touched files in this session: a\.js\./)
  assert.doesNotMatch(banner, /Previous task summary/)
  assert.match(banner, /Please inspect the relevant files/)
})

test('a head-only banner omits the touched-files line', () => {
  const banner = contextRecoveryBanner({ session_id: 's', turn_count: 1, last_task_head: 'fix it' })
  assert.doesNotMatch(banner, /Previously touched files/)
  assert.match(banner, /Previous task summary: fix it\./)
  assert.match(banner, /Please inspect the relevant files/)
})

test('the banner falls back to the record session_id and then to "?"', () => {
  assert.match(
    contextRecoveryBanner({ session_id: 'from-record', turn_count: 1, last_task_head: 'x' }),
    /session "from-record"/,
  )
  // The explicit sessionId wins over the record's own.
  assert.match(
    contextRecoveryBanner(
      { session_id: 'from-record', turn_count: 1, last_task_head: 'x' },
      { sessionId: 'explicit' },
    ),
    /session "explicit"/,
  )
  assert.match(contextRecoveryBanner({ turn_count: 1, last_task_head: 'x' }), /session "\?"/)
})

test('contextRecoveryBanner stays silent without a completed turn or without facts', () => {
  assert.equal(contextRecoveryBanner(undefined), undefined)
  assert.equal(contextRecoveryBanner(null), undefined)
  assert.equal(contextRecoveryBanner({}), undefined)
  // Turn 0: the old thread had no context to lose.
  assert.equal(contextRecoveryBanner({ turn_count: 0, last_task_head: 'x' }), undefined)
  assert.equal(contextRecoveryBanner({ last_task_head: 'x' }), undefined)
  assert.equal(contextRecoveryBanner({ turn_count: 'nonsense', last_task_head: 'x' }), undefined)
  // A turn count with nothing to say is still nothing to say.
  assert.equal(contextRecoveryBanner({ session_id: 's', turn_count: 3 }), undefined)
  assert.equal(
    contextRecoveryBanner({ session_id: 's', turn_count: 3, last_touched_files: [], last_task_head: '  ' }),
    undefined,
  )
})

test('contextRecoveryBanner never throws on a malformed record', () => {
  assert.equal(contextRecoveryBanner('not a record'), undefined)
  assert.equal(contextRecoveryBanner(42), undefined)
  // A garbage file list is read as empty, not as a crash.
  assert.equal(contextRecoveryBanner({ turn_count: 1, last_touched_files: 'a.js' }), undefined)
  const banner = contextRecoveryBanner({
    turn_count: 1,
    last_touched_files: [null, 3, 'a.js'],
    last_task_head: 9,
  })
  assert.match(banner, /Previously touched files in this session: a\.js\./)
  assert.doesNotMatch(banner, /Previous task summary/)
})

// ---------------------------------------------------------------------------
// v0.8.0: rollover (REQ-04) and rework-escalation (REQ-01) fields
// ---------------------------------------------------------------------------

/** A record exactly as v0.7.0 wrote it — every key, no v0.8.0 key. */
const V070_RECORD = {
  session_id: 'main',
  conversation_id: 'conv-1',
  workspace_dir: 'E:\\p',
  tier: 'pro',
  turn_count: 4,
  last_touched_files: ['a.js'],
  last_task_head: 'fix it',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
}

/** The keys v0.7.0 wrote, and therefore the only keys v0.8.0 may write back. */
const V070_KEYS = Object.keys(V070_RECORD).sort()

/** How `index.js` writes a settled turn: camelCase, threads the live record in. */
const TURN_WRITE = {
  sessionId: 'main',
  workspace: 'E:\\p',
  conversationId: 'conv-1',
  tier: 'pro',
  turns: 5,
  lastTouchedFiles: ['a.js'],
  lastTaskHead: 'fix it',
  now: new Date('2026-10-03T00:00:00.000Z'),
}

test('set persists the six v0.8.0 fields under their stored snake_case names', async (t) => {
  const { store } = await withStore(t)
  const record = store.set({}, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    lastTurnFailed: true,
    taskMode: 'document',
    rolloverBrief: {
      cumulativeTouchedFiles: ['src/a.js'],
      lastPlanHead: 'ship the report',
      previousTurnCount: 8,
    },
    rolledOverAt: new Date('2026-10-29T10:00:00.000Z'),
    cumulativeTurnCount: 8,
    burnCumulative: 0.42,
  })

  assert.equal(record.last_turn_failed, true)
  assert.equal(record.task_mode, 'document')
  assert.deepEqual(record.rollover_brief, {
    cumulative_touched_files: ['src/a.js'],
    last_plan_head: 'ship the report',
    previous_turn_count: 8,
  })
  assert.equal(record.rolled_over_at, '2026-10-29T10:00:00.000Z')
  assert.equal(record.cumulative_turn_count, 8)
  assert.equal(record.burn_cumulative, 0.42)

  // The camelCase inputs never leak into the persisted shape.
  const camelKeys = [
    'lastTurnFailed',
    'taskMode',
    'rolloverBrief',
    'rolledOverAt',
    'cumulativeTurnCount',
    'burnCumulative',
  ]
  for (const key of camelKeys) {
    assert.equal(key in record, false, `${key} must not be persisted`)
  }
})

test('the v0.8.0 fields accept their snake_case spellings too', async (t) => {
  const { store } = await withStore(t)
  const record = store.set({}, {
    session_id: 'main',
    workspace_dir: 'E:\\p',
    conversation_id: 'conv-1',
    last_turn_failed: false,
    task_mode: 'surgical',
    rolled_over_at: '2026-10-29T10:00:00.000Z',
    cumulative_turn_count: 3,
    burn_cumulative: 0.25,
    rollover_brief: {
      cumulative_touched_files: ['src/b.js'],
      last_plan_head: 'refactor',
      previous_turn_count: 3,
    },
  })
  assert.equal(record.last_turn_failed, false)
  assert.equal(record.task_mode, 'surgical')
  assert.equal(record.rolled_over_at, '2026-10-29T10:00:00.000Z')
  assert.equal(record.cumulative_turn_count, 3)
  assert.equal(record.burn_cumulative, 0.25)
  assert.deepEqual(record.rollover_brief.cumulative_touched_files, ['src/b.js'])
})

test('an omitted v0.8.0 field is absent from the record, not defaulted', async (t) => {
  // "Don't pass it, it doesn't appear" is the whole compatibility contract: a
  // v0.7.0-shaped caller must not gain a single key.
  const { store } = await withStore(t)
  const record = store.set({}, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    tier: 'pro',
    now: new Date('2026-10-29T10:00:00.000Z'),
  })
  const newKeys = [
    'last_turn_failed',
    'task_mode',
    'rollover_brief',
    'rolled_over_at',
    'cumulative_turn_count',
    'burn_cumulative',
  ]
  for (const key of newKeys) {
    assert.equal(key in record, false, `${key} must not appear when not supplied`)
  }
})

test('a v0.7.0 record survives load -> set -> save with exactly its old keys', async (t) => {
  // The zero-config upgrade promise, end to end: an untouched v0.7.0
  // sessions.json gains no key merely because v0.8.0 reloaded it.
  const { store, filePath } = await withStore(t)
  await writeFile(filePath, JSON.stringify({ [sessionKey('E:\\p', 'main')]: V070_RECORD }))

  const state = await store.load()
  const written = store.set(state, TURN_WRITE)
  await store.save(state)

  assert.deepEqual(Object.keys(written).sort(), V070_KEYS)
  const reloaded = await store.load()
  assert.deepEqual(Object.keys(reloaded[sessionKey('E:\\p', 'main')]).sort(), V070_KEYS)
  // The update still did its actual job.
  assert.equal(reloaded[sessionKey('E:\\p', 'main')].turn_count, 5)
  assert.equal(reloaded[sessionKey('E:\\p', 'main')].created_at, V070_RECORD.created_at)
})

test('a persisted record handed straight back in keeps its key set', async (t) => {
  const { store } = await withStore(t)
  const record = store.set({}, { ...V070_RECORD })
  assert.deepEqual(Object.keys(record).sort(), V070_KEYS)
  assert.equal(record.turn_count, 4)
  assert.deepEqual(record.last_touched_files, ['a.js'])
})

test('session-scoped fields survive a conversation_id change; thread fields do not', async (t) => {
  // The split that is easiest to get wrong: a rollover opens a NEW conversation
  // and deliberately drops the transcript, but "the last turn failed", "this
  // session is on document mode" and "how much quota did it burn" are facts
  // about the session and must come through the rollover intact.
  const { store } = await withStore(t)
  const state = {}
  store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    turns: 8,
    lastTouchedFiles: ['a.js'],
    lastTaskHead: 'fix it',
    lastTurnFailed: true,
    taskMode: 'document',
    burnCumulative: 0.7,
  })

  const rolled = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-2',
    turns: 0,
  })

  // Session-scoped: carried over.
  assert.equal(rolled.last_turn_failed, true)
  assert.equal(rolled.task_mode, 'document')
  assert.equal(rolled.burn_cumulative, 0.7)

  // Thread-scoped: unchanged v0.6.0/v0.7.0 semantics, byte for byte.
  assert.equal('last_touched_files' in rolled, false)
  assert.equal('last_task_head' in rolled, false)
  assert.equal(rolled.turn_count, 0)
  assert.equal(rolled.conversation_id, 'conv-2')
})

test('rollover_brief and rolled_over_at appear only when supplied', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, { sessionId: 'main', workspace: 'E:\\p', conversationId: 'conv-1' })
  // A conversation change alone must not fabricate a rollover.
  const changed = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-2',
  })
  assert.equal('rollover_brief' in changed, false)
  assert.equal('rolled_over_at' in changed, false)
})

test('last_turn_failed / task_mode / burn_cumulative are copied, never guessed', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  // A v0.7.0 record has no such keys; an update must not invent them.
  const updated = store.set(state, { sessionId: 'main', workspace: 'E:\\p', conversationId: 'conv-1' })
  assert.equal('last_turn_failed' in updated, false)
  assert.equal('task_mode' in updated, false)
  assert.equal('burn_cumulative' in updated, false)

  // Garbage in a written field is read as "not supplied", not as a value.
  const junk = store.set({}, {
    sessionId: 'main',
    workspace: 'E:\\p',
    lastTurnFailed: 'maybe',
    taskMode: 'painting',
    burnCumulative: 'lots',
  })
  assert.equal('last_turn_failed' in junk, false)
  assert.equal('task_mode' in junk, false)
  assert.equal('burn_cumulative' in junk, false)
})

test('burn_cumulative is clamped to the 0-1 range', async (t) => {
  const { store } = await withStore(t)
  // "110% of the quota" is real information the guard ran late; clamping keeps
  // the UI progress bar renderable instead of silently blank.
  assert.equal(
    store.set({}, { sessionId: 'a', workspace: 'E:\\p', burnCumulative: 1.4 }).burn_cumulative,
    1,
  )
  assert.equal(
    store.set({}, { sessionId: 'b', workspace: 'E:\\p', burnCumulative: -2 }).burn_cumulative,
    0,
  )
  assert.equal(
    store.set({}, { sessionId: 'c', workspace: 'E:\\p', burnCumulative: 0 }).burn_cumulative,
    0,
  )
})

test('an explicit null rollover_brief / rolled_over_at is recorded as null', async (t) => {
  const { store } = await withStore(t)
  const record = store.set({}, {
    sessionId: 'main',
    workspace: 'E:\\p',
    rolloverBrief: null,
    rolledOverAt: null,
  })
  // `null` is a value the caller chose ("recorded, but empty"), so the key is
  // present — unlike `undefined`, which means "not supplied".
  assert.deepEqual(record.rollover_brief, {
    cumulative_touched_files: [],
    last_plan_head: '',
    previous_turn_count: 0,
  })
  assert.equal(record.rolled_over_at, null)
})

test('rollover_brief is capped and de-duplicated like every other list', async (t) => {
  const { store } = await withStore(t)
  const files = Array.from({ length: 20 }, (_, i) => `file-${i}.js`)
  const record = store.set({}, {
    sessionId: 'main',
    workspace: 'E:\\p',
    rolloverBrief: {
      cumulativeTouchedFiles: [...files, 'file-0.js', '  ', 7, null],
      lastPlanHead: 'z'.repeat(900),
      previousTurnCount: -3,
    },
  })
  assert.equal(record.rollover_brief.cumulative_touched_files.length, 15)
  assert.deepEqual(record.rollover_brief.cumulative_touched_files, files.slice(0, 15))
  assert.equal(record.rollover_brief.last_plan_head.length, 600)
  assert.equal(record.rollover_brief.previous_turn_count, 0)
})

test('the v0.8.0 fields survive a save/load round-trip', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    lastTurnFailed: false,
    taskMode: 'creative',
    rolloverBrief: {
      cumulativeTouchedFiles: ['src/a.js'],
      lastPlanHead: 'plan',
      previousTurnCount: 2,
    },
    rolledOverAt: new Date('2026-10-29T10:00:00.000Z'),
    cumulativeTurnCount: 10,
    burnCumulative: 0.5,
  })
  await store.save(state)
  const reloaded = await store.load()
  assert.deepEqual(reloaded, state)
  const record = reloaded[sessionKey('E:\\p', 'main')]
  assert.equal(record.task_mode, 'creative')
  assert.equal(record.last_turn_failed, false)
  assert.equal(record.cumulative_turn_count, 10)
  assert.equal(record.burn_cumulative, 0.5)
})

test('mergeRolloverBrief keeps first-seen order and de-duplicates old against new', () => {
  const merged = mergeRolloverBrief(
    {
      rollover_brief: {
        cumulative_touched_files: ['a.js', 'b.js'],
        last_plan_head: 'old plan',
        previous_turn_count: 8,
      },
    },
    { cumulativeTouchedFiles: ['b.js', 'c.js'], lastPlanHead: 'new plan', previousTurnCount: 4 },
  )
  // Old first: it was seen first. `b.js` appears once.
  assert.deepEqual(merged.cumulative_touched_files, ['a.js', 'b.js', 'c.js'])
  // The newest plan wins — that is the plan the work is following.
  assert.equal(merged.last_plan_head, 'new plan')
  assert.equal(merged.previous_turn_count, 4)
})

test('mergeRolloverBrief caps at fifteen files across rollovers', () => {
  const old = Array.from({ length: 12 }, (_, i) => `old-${i}.js`)
  const fresh = Array.from({ length: 12 }, (_, i) => `new-${i}.js`)
  const merged = mergeRolloverBrief(
    {
      rollover_brief: {
        cumulative_touched_files: old,
        last_plan_head: '',
        previous_turn_count: 8,
      },
    },
    { cumulativeTouchedFiles: fresh, lastPlanHead: 'fresh', previousTurnCount: 8 },
  )
  // A brief is re-sent in the first prompt of every new thread, so it cannot
  // grow with the number of rollovers.
  assert.equal(merged.cumulative_touched_files.length, 15)
  assert.deepEqual(merged.cumulative_touched_files, [...old, ...fresh].slice(0, 15))
})

test('mergeRolloverBrief falls back to the stored brief and the record', () => {
  // New brief has no plan head -> the old one is still the best we have.
  const kept = mergeRolloverBrief(
    {
      rollover_brief: {
        cumulative_touched_files: ['a.js'],
        last_plan_head: 'old plan',
        previous_turn_count: 8,
      },
    },
    { cumulativeTouchedFiles: ['b.js'] },
  )
  assert.deepEqual(kept.cumulative_touched_files, ['a.js', 'b.js'])
  assert.equal(kept.last_plan_head, 'old plan')
  assert.equal(kept.previous_turn_count, 8)

  // No briefs at all -> the record's own count, then zero.
  assert.equal(mergeRolloverBrief({ turn_count: 6 }, undefined).previous_turn_count, 6)
  assert.deepEqual(mergeRolloverBrief(undefined, undefined), {
    cumulative_touched_files: [],
    last_plan_head: '',
    previous_turn_count: 0,
  })
  assert.equal(mergeRolloverBrief({}, undefined, 3).previous_turn_count, 3)
})

test('mergeRolloverBrief never mutates its inputs', () => {
  const record = {
    rollover_brief: {
      cumulative_touched_files: ['a.js'],
      last_plan_head: 'x',
      previous_turn_count: 2,
    },
  }
  const brief = { cumulativeTouchedFiles: ['b.js'], lastPlanHead: 'y', previousTurnCount: 1 }
  const snapshot = JSON.stringify({ record, brief })
  mergeRolloverBrief(record, brief)
  assert.equal(JSON.stringify({ record, brief }), snapshot)
})

test('mergeRolloverBrief tolerates malformed inputs', () => {
  assert.deepEqual(mergeRolloverBrief(null, null), {
    cumulative_touched_files: [],
    last_plan_head: '',
    previous_turn_count: 0,
  })
  assert.deepEqual(mergeRolloverBrief('nonsense', 42).cumulative_touched_files, [])
  assert.deepEqual(mergeRolloverBrief({ rollover_brief: { cumulative_touched_files: 'a.js' } }, {}), {
    cumulative_touched_files: [],
    last_plan_head: '',
    previous_turn_count: 0,
  })
})

test('nextTurnCountAfterRollover zeroes the thread count and banks the total', () => {
  assert.deepEqual(nextTurnCountAfterRollover({ turn_count: 8 }), {
    turn_count: 0,
    cumulative_turn_count: 8,
  })
  // A second rollover accumulates rather than replacing.
  assert.deepEqual(nextTurnCountAfterRollover({ turn_count: 8, cumulative_turn_count: 8 }), {
    turn_count: 0,
    cumulative_turn_count: 16,
  })
  // Nothing to bank yet.
  assert.deepEqual(nextTurnCountAfterRollover(undefined), {
    turn_count: 0,
    cumulative_turn_count: 0,
  })
  assert.deepEqual(nextTurnCountAfterRollover({}), { turn_count: 0, cumulative_turn_count: 0 })
  assert.deepEqual(nextTurnCountAfterRollover({ turn_count: 'nonsense', cumulative_turn_count: 4 }), {
    turn_count: 0,
    cumulative_turn_count: 4,
  })
})

test('nextTurnCountAfterRollover is pure', () => {
  const record = { turn_count: 8, cumulative_turn_count: 2 }
  const snapshot = JSON.stringify(record)
  nextTurnCountAfterRollover(record)
  assert.equal(JSON.stringify(record), snapshot)
})

test('rolloverSessionPatch is exactly what set() needs to write a rollover', async (t) => {
  const { store } = await withStore(t)
  const state = {}
  store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-1',
    turns: 8,
    lastTouchedFiles: ['a.js'],
    lastTaskHead: 'fix it',
    lastTurnFailed: true,
    taskMode: 'document',
    burnCumulative: 0.6,
  })
  const before = store.get(state, 'E:\\p', 'main')

  const patch = rolloverSessionPatch(before, {
    brief: {
      cumulativeTouchedFiles: ['a.js', 'b.js'],
      lastPlanHead: 'next plan',
      previousTurnCount: 8,
    },
    now: new Date('2026-10-29T10:00:00.000Z'),
  })
  const after = store.set(state, {
    sessionId: 'main',
    workspace: 'E:\\p',
    conversationId: 'conv-2',
    ...patch,
  })

  assert.equal(after.conversation_id, 'conv-2')
  assert.equal(after.turn_count, 0)
  assert.equal(after.cumulative_turn_count, 8)
  assert.equal(after.rolled_over_at, '2026-10-29T10:00:00.000Z')
  assert.deepEqual(after.rollover_brief.cumulative_touched_files, ['a.js', 'b.js'])
  // Session-scoped state comes through the rollover untouched.
  assert.equal(after.task_mode, 'document')
  assert.equal(after.last_turn_failed, true)
  assert.equal(after.burn_cumulative, 0.6)
  // Thread-scoped state is dropped, as always.
  assert.equal('last_touched_files' in after, false)
})

// ---------------------------------------------------------------------------
// v0.8.0: projectSessionRow — the dashboard row
// ---------------------------------------------------------------------------

test('projectSessionRow projects every field the dashboard needs', () => {
  const row = projectSessionRow(
    {
      session_id: 'main',
      conversation_id: 'conv-1',
      workspace_dir: 'E:\\p',
      tier: 'pro',
      turn_count: 3,
      cumulative_turn_count: 11,
      last_touched_files: ['a.js'],
      last_task_head: 'fix it',
      task_mode: 'document',
      last_turn_failed: true,
      burn_cumulative: 0.35,
      updated_at: '2026-10-29T10:00:00.000Z',
    },
    { longSessionTurns: 8 },
  )
  assert.deepEqual(row, {
    sessionId: 'main',
    conversationId: 'conv-1',
    workspaceDir: 'E:\\p',
    tier: 'pro',
    turnCount: 3,
    cumulativeTurnCount: 11,
    longSession: false,
    lastTouchedFiles: ['a.js'],
    lastTaskHead: 'fix it',
    taskMode: 'document',
    lastTurnFailed: true,
    burnCumulative: 0.35,
    updatedAt: '2026-10-29T10:00:00.000Z',
  })
})

test('projectSessionRow longSession still uses turn_count, not the cumulative one', () => {
  // After a rollover turn_count is 0 while cumulative_turn_count is 8: the new
  // thread is NOT long, and saying otherwise would nag the user to roll over
  // again on the first turn of the thread they just opened.
  const row = projectSessionRow({ turn_count: 0, cumulative_turn_count: 8 })
  assert.equal(row.longSession, false)
  assert.equal(row.cumulativeTurnCount, 8)
})

test('projectSessionRow honours a caller-supplied threshold and defaults to eight', () => {
  assert.equal(projectSessionRow({ turn_count: 8 }).longSession, true)
  assert.equal(projectSessionRow({ turn_count: 7 }).longSession, false)
  assert.equal(projectSessionRow({ turn_count: 4 }, { longSessionTurns: 4 }).longSession, true)
  assert.equal(projectSessionRow({ turn_count: 4 }, { longSessionTurns: 12 }).longSession, false)
  // A nonsense threshold must not silently disable the warning.
  assert.equal(projectSessionRow({ turn_count: 8 }, { longSessionTurns: 0 }).longSession, true)
  assert.equal(projectSessionRow({ turn_count: 8 }, { longSessionTurns: 'x' }).longSession, true)
})

test('projectSessionRow fills defaults so the page never has to guard', () => {
  const row = projectSessionRow({ session_id: 'main', turn_count: 2 })
  assert.equal(row.conversationId, null)
  assert.equal(row.workspaceDir, null)
  assert.equal(row.tier, null)
  assert.equal(row.lastTaskHead, null)
  assert.equal(row.taskMode, null)
  assert.equal(row.lastTurnFailed, null)
  assert.equal(row.burnCumulative, null)
  assert.equal(row.updatedAt, null)
  assert.deepEqual(row.lastTouchedFiles, [])
})

test('projectSessionRow falls back to turn_count when there is no cumulative count', () => {
  // A v0.7.0 record has no cumulative counter; its thread count IS the session
  // total, so a confident 0 would be a lie.
  assert.equal(projectSessionRow({ turn_count: 6 }).cumulativeTurnCount, 6)
})

test('projectSessionRow never throws on a malformed record', () => {
  const empty = projectSessionRow(undefined)
  assert.equal(empty.sessionId, '?')
  assert.equal(empty.turnCount, 0)
  assert.equal(empty.longSession, false)
  assert.deepEqual(projectSessionRow(null).lastTouchedFiles, [])
  assert.equal(projectSessionRow('nonsense').sessionId, '?')
  assert.equal(projectSessionRow(42).turnCount, 0)

  // Garbage values degrade to the documented defaults, not to garbage.
  const junk = projectSessionRow({
    turn_count: 'many',
    cumulative_turn_count: -4,
    last_touched_files: 'a.js',
    task_mode: 'painting',
    last_turn_failed: 'maybe',
    burn_cumulative: 'lots',
  })
  assert.equal(junk.turnCount, 0)
  assert.equal(junk.cumulativeTurnCount, 0)
  assert.deepEqual(junk.lastTouchedFiles, [])
  assert.equal(junk.taskMode, null)
  assert.equal(junk.lastTurnFailed, null)
  assert.equal(junk.burnCumulative, null)
})

test('projectSessionRow copies the file list instead of aliasing it', () => {
  const files = ['a.js']
  const row = projectSessionRow({ last_touched_files: files })
  row.lastTouchedFiles.push('b.js')
  // A UI consumer mutating its row must not corrupt the loaded state map.
  assert.deepEqual(files, ['a.js'])
})
