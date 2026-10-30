/**
 * Durable `session_id -> conversation_id` mapping (REQ-06).
 *
 * WHY ATOMIC WRITES
 * -----------------
 * The map is written after every delegation. A half-written JSON file (dsh
 * killed mid-write, disk full, antivirus lock on Windows) would lose *every*
 * previous mapping, not just the current one, so writes go to a sibling
 * `*.tmp` file and are `rename`d into place — rename is atomic on both NTFS
 * and POSIX filesystems. A failed write is never fatal: the delegation already
 * succeeded and this file is only a convenience.
 *
 * Records are stored keyed by `${workspace}::${sessionId}` so the same session
 * name in two different projects cannot resume each other's conversation.
 *
 * WHY THE RECORD ALSO REMEMBERS CONTEXT (REQ-03)
 * ----------------------------------------------
 * The mapping outlives the conversation, and evicting a dead one opens a fresh
 * conversation with no context at all. The planner's next message is usually an
 * *incremental* instruction, so the record now also carries the last touched
 * files and the head of the last task — that is the only material
 * {@link contextRecoveryBanner} has to rebuild the missing context from.
 *
 * @module antigravity-executor/lib/sessions
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const DEFAULT_LIST_LIMIT = 20
const DEFAULT_KEEP_DAYS = 30
const DAY_MS = 86_400_000

/** The composite key used by every store operation. */
export function sessionKey(workspace, sessionId) {
  return `${workspace}::${sessionId}`
}

/** Drop `undefined` members so persisted records stay compact and JSON-clean. */
function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined))
}

/** `now` accepts a Date, epoch ms, or nothing. */
function toMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

/** Parse an ISO timestamp back to epoch ms; undefined when unparseable. */
function parseTime(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : undefined
}

/** Do two optional conversation ids name the same conversation? */
function sameConversation(a, b) {
  if (a === undefined || b === undefined) return false
  return String(a) === String(b)
}

/** How many turns a session may accumulate before the plugin suggests a reset. */
export const DEFAULT_LONG_SESSION_TURNS = 8

/** How many touched files one record remembers (REQ-03). */
const MAX_TOUCHED_FILES = 10
/** How much of the previous task text one record remembers (REQ-03). */
const MAX_TASK_HEAD_CHARS = 200

/**
 * Normalise the remembered file list: strings only, de-duplicated in first-seen
 * order, trimmed, capped at {@link MAX_TOUCHED_FILES}.
 *
 * Returns `undefined` for "nothing was supplied", so the key is simply absent
 * from the record and a v0.5.x-shaped record keeps exactly its old keys.
 */
function normalizeTouchedFiles(value) {
  if (!Array.isArray(value)) return undefined
  const files = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const path = item.trim()
    if (path === '') continue
    if (files.includes(path)) continue
    files.push(path)
    if (files.length === MAX_TOUCHED_FILES) break
  }
  return files.length === 0 ? undefined : files
}

/**
 * Normalise the remembered task head: trimmed and capped, with an empty or
 * non-string value read as "not supplied".
 *
 * The cap is a hard slice — appending an ellipsis would make the stored string
 * 201 characters and quietly break the documented bound.
 */
function normalizeTaskHead(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length > MAX_TASK_HEAD_CHARS ? text.slice(0, MAX_TASK_HEAD_CHARS) : text
}

/**
 * The `turn_count` to store after one more completed turn.
 *
 * A conversation that changed identity starts again at 1: carrying the old
 * count over would make a brand-new thread look "long" on its first turn.
 *
 * @param {object|undefined} record the existing record, if any
 * @param {string|undefined} conversationId the conversation this turn used
 * @param {number} [turns] explicit override (a resumed turn may want to set it)
 * @returns {number}
 */
export function nextTurnCount(record, conversationId, turns) {
  const explicit = Number(turns)
  if (Number.isFinite(explicit)) return Math.max(0, Math.trunc(explicit))

  const existing = Number(record?.turn_count)
  const base = sameConversation(record?.conversation_id, conversationId) && Number.isFinite(existing)
    ? Math.max(0, Math.trunc(existing))
    : 0
  return base + 1
}

/**
 * Should the caller be told this session is getting long?
 *
 * Every extra turn re-sends a larger history, so the per-turn quota cost grows
 * with `turn_count`; starting a fresh session for the next independent feature
 * is meaningfully cheaper. Returns the warning line, or undefined.
 *
 * @param {object} record a session record
 * @param {number} [threshold=DEFAULT_LONG_SESSION_TURNS]
 * @returns {string|undefined}
 */
export function longSessionHint(record, threshold = DEFAULT_LONG_SESSION_TURNS) {
  const turns = Number(record?.turn_count)
  const limit = Number(threshold)
  if (!Number.isFinite(turns) || !Number.isFinite(limit) || limit <= 0) return undefined
  if (turns < limit) return undefined
  return (
    `hint         : 本 session_id 已连续 ${turns} 轮（阈值 ${limit}）。` +
    '同一个 conversation 每轮都会携带更长的历史，账号配额消耗随之放大；' +
    '下一个独立子功能建议换一个新的 session_id。'
  )
}

/**
 * The banner to prepend to a re-dispatched prompt after a dead-session eviction.
 *
 * WHY THIS EXISTS (REQ-03)
 * ------------------------
 * Evicting a dead `session_id -> conversation_id` mapping and opening a fresh
 * conversation keeps the delegation working, but it silently changes what the
 * planner's next message *means*. On turn 2+ that message is an incremental
 * instruction ("change line 40 of that function"), and a brand-new blank
 * conversation has no idea which function — so it guesses, and the guess costs
 * a whole extra delegation. The record is the only thing that survives the
 * eviction, so whatever it remembers is the only context worth carrying over.
 *
 * Kept a pure function of the record (no store, no clock) so it can be tested
 * directly and so a caller cannot accidentally emit it without an eviction.
 *
 * @param {object|undefined} record a persisted session record
 * @param {{sessionId?: string}} [o] the session id to name, defaulting to the
 *   record's own and then to `'?'`
 * @returns {string|undefined} the banner, or undefined when there is nothing
 *   worth saying
 */
export function contextRecoveryBanner(record, { sessionId } = {}) {
  if (record === null || typeof record !== 'object') return undefined

  // Turn 0 (or an unreadable count) means the previous thread had no context to
  // lose: a banner would only add tokens to a delegation that never had state.
  const turns = Number(record.turn_count)
  if (!Number.isFinite(turns) || turns < 1) return undefined

  const files = normalizeTouchedFiles(record.last_touched_files) ?? []
  const head = normalizeTaskHead(record.last_task_head)
  if (files.length === 0 && head === undefined) return undefined

  const id = String(sessionId ?? record.session_id ?? '?')
  const lines = [
    `[Context Recovery Note: The previous conversation thread for session "${id}" expired and a fresh conversation was opened.`,
  ]
  if (files.length > 0) lines.push(`Previously touched files in this session: ${files.join(', ')}.`)
  if (head !== undefined) lines.push(`Previous task summary: ${head}.`)
  lines.push(
    'Please inspect the relevant files in the workspace first before applying the following incremental request.]',
  )
  return lines.join('\n')
}

/**
 * Create a store bound to one JSON file.
 *
 * The returned object is stateless — every method takes the state map explicitly,
 * so the caller decides when to reload or persist it.
 *
 * @param {string} filePath absolute path of the JSON map
 */
export function createSessionStore(filePath) {
  const target = String(filePath)

  /** Unique temp name: two concurrent writers must not share a scratch file. */
  function tempPath() {
    return `${target}.${process.pid}.${Date.now()}.tmp`
  }

  /**
   * Read the map. Missing, empty, corrupt, or non-object JSON all degrade to an
   * empty map: a broken cache must never block a delegation.
   * @returns {Promise<Record<string, object>>}
   */
  async function load() {
    try {
      const text = (await readFile(target, 'utf8')).replace(/^\uFEFF/, '')
      if (text.trim() === '') return {}
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed
    } catch {
      return {}
    }
  }

  /**
   * Persist the map atomically. Never throws.
   * @returns {Promise<boolean>} true when the rename succeeded
   */
  async function save(state) {
    const payload = `${JSON.stringify(state ?? {}, null, 2)}\n`
    const tmp = tempPath()
    try {
      const dir = dirname(target)
      if (dir !== '') await mkdir(dir, { recursive: true })
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, target)
      return true
    } catch {
      // Best effort cleanup; a leftover tmp file is harmless either way.
      try {
        await unlink(tmp)
      } catch {
        /* ignore */
      }
      return false
    }
  }

  /** Look up one record; `undefined` when the workspace/session pair is unknown. */
  function get(state, workspace, sessionId) {
    if (state === null || typeof state !== 'object') return undefined
    return state[sessionKey(workspace, sessionId)]
  }

  /**
   * Upsert a record and return it. `created_at` survives updates, `updated_at`
   * always moves to `now`.
   *
   * Accepts both the contract's camelCase call shape and the snake_case record
   * shape, so callers can pass a persisted record straight back in.
   *
   * `turn_count` counts completed turns on this conversation (v0.5.0). It is
   * what lets the plugin warn that a long-lived session is re-reading an ever
   * larger history every round — the single largest hidden quota cost of
   * `persistSessions`. Pass `turns` to set it explicitly; otherwise a `set()`
   * that keeps the same conversation adds one, and `set()` with a *new*
   * conversation starts again at 0.
   *
   * `last_touched_files` and `last_task_head` (REQ-03) are the context a
   * follow-up request will be missing after a dead-session eviction. Both are
   * optional and stored only when supplied, so a v0.5.x-shaped record round-trips
   * byte-identically; both are inherited on an update of the *same* conversation
   * and dropped when `conversation_id` changes, exactly like `turn_count`.
   */
  function set(state, record = {}) {
    const workspace = record.workspace ?? record.workspace_dir ?? record.workspaceDir
    const sessionId = record.sessionId ?? record.session_id
    if (workspace === undefined || sessionId === undefined) {
      throw new TypeError('sessions.set: workspace and sessionId are required')
    }

    const key = sessionKey(workspace, sessionId)
    const existing = state[key]
    const nowMs = toMs(record.now) ?? Date.now()
    const nowIso = new Date(nowMs).toISOString()

    const conversationId =
      record.conversationId ?? record.conversation_id ?? existing?.conversation_id

    // `turn_count` is stored only when the caller supplies it, so a v0.4.0-shaped
    // record keeps exactly its old keys. `nextTurnCount` decides the number.
    const turns = Number(record.turns ?? record.turn_count)
    const turnCount = Number.isFinite(turns) ? Math.max(0, Math.trunc(turns)) : undefined
    // A record loaded from an older version may already carry a count.
    const carriedTurns = sameConversation(existing?.conversation_id, conversationId)
      ? Number(existing?.turn_count)
      : undefined

    // REQ-03 context carry-over. Same discipline as `turn_count`: stored only
    // when supplied, inherited from the existing record when omitted — but a
    // *changed* conversation_id starts clean, because the files and the task
    // head describe the thread that died, not the fresh one that replaces it.
    const sameThread = sameConversation(existing?.conversation_id, conversationId)
    const touchedFiles =
      normalizeTouchedFiles(record.lastTouchedFiles ?? record.last_touched_files) ??
      (sameThread ? normalizeTouchedFiles(existing?.last_touched_files) : undefined)
    const taskHead =
      normalizeTaskHead(record.lastTaskHead ?? record.last_task_head) ??
      (sameThread ? normalizeTaskHead(existing?.last_task_head) : undefined)

    const next = compact({
      session_id: String(sessionId),
      conversation_id: conversationId,
      workspace_dir: String(workspace),
      tier: record.tier ?? existing?.tier,
      turn_count: turnCount ?? (Number.isFinite(carriedTurns) ? carriedTurns : undefined),
      last_touched_files: touchedFiles,
      last_task_head: taskHead,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    })

    state[key] = next
    return next
  }

  /**
   * Remove one record; returns the removed record or undefined.
   *
   * WHY THIS EXISTS (v0.5.0)
   * ------------------------
   * A persisted `session_id -> conversation_id` outlives the conversation it
   * points at: the user can delete the thread in Antigravity, or clear the
   * brain directory. Reusing that session then fails as a dead turn in ~0.1s,
   * and without an eviction path it would keep failing forever — the persisted
   * map would be actively worse than not persisting at all.
   */
  function remove(state, workspace, sessionId) {
    if (state === null || typeof state !== 'object') return undefined
    const key = sessionKey(workspace, sessionId)
    const record = state[key]
    if (record === undefined) return undefined
    delete state[key]
    return record
  }

  /**
   * Most recently updated records first.
   * @param {Record<string, object>} state
   * @param {number} [limit]
   */
  function list(state, limit) {
    const rows =
      state !== null && typeof state === 'object'
        ? Object.values(state).filter((r) => r !== null && typeof r === 'object')
        : []
    rows.sort((a, b) =>
      String(b.updated_at ?? b.created_at ?? '').localeCompare(
        String(a.updated_at ?? a.created_at ?? ''),
      ),
    )
    const n = Number(limit)
    const cap = Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_LIST_LIMIT
    return rows.slice(0, cap)
  }

  /**
   * Drop records untouched for `keepDays`. Records with no usable timestamp are
   * kept — deleting a record we cannot date is worse than keeping it.
   * @returns {{removed: number, kept: number}}
   */
  function prune(state, { keepDays = DEFAULT_KEEP_DAYS, now = Date.now() } = {}) {
    if (state === null || typeof state !== 'object') return { removed: 0, kept: 0 }
    const days = Number(keepDays)
    const span = Number.isFinite(days) && days > 0 ? days : DEFAULT_KEEP_DAYS
    const cutoff = (toMs(now) ?? Date.now()) - span * DAY_MS

    let removed = 0
    for (const [key, record] of Object.entries(state)) {
      const at = parseTime(record?.updated_at ?? record?.created_at)
      if (at !== undefined && at < cutoff) {
        delete state[key]
        removed += 1
      }
    }
    return { removed, kept: Object.keys(state).length }
  }

  return { filePath: target, load, save, get, set, remove, list, prune }
}
