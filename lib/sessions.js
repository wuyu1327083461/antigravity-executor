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

    const next = compact({
      session_id: String(sessionId),
      conversation_id:
        record.conversationId ?? record.conversation_id ?? existing?.conversation_id,
      workspace_dir: String(workspace),
      tier: record.tier ?? existing?.tier,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    })

    state[key] = next
    return next
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

  return { filePath: target, load, save, get, set, list, prune }
}
