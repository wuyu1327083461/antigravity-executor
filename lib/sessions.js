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
 * WHY THE RECORD ALSO CARRIES CROSS-THREAD STATE (v0.8.0)
 * ------------------------------------------------------
 * Two v0.8.0 capabilities are impossible with a mapping that only describes the
 * *current* thread:
 *
 * 1. **Long-session rollover (REQ-04).** Rolling an 8-turn session over into a
 *    fresh `conversation_id` deliberately zeroes `turn_count` — but it must not
 *    zero what the work has *accumulated*, or the new thread starts by
 *    re-scanning the project from scratch. That is why the record now also
 *    remembers `rollover_brief` (the files and the plan head to hand the new
 *    thread) and `cumulative_turn_count` (the truth about how much work this
 *    session has actually done).
 * 2. **Rework escalation (REQ-01) and mode stickiness (REQ-05).** "Did the last
 *    turn fail?" and "which persona did this session settle on?" are facts about
 *    the *session*, not about one conversation: after a rollover or a dead-thread
 *    eviction the next thread still needs them. They are therefore recorded
 *    session-scoped and survive a `conversation_id` change, unlike the
 *    thread-scoped context fields above.
 *
 * The compatibility discipline is unchanged and, if anything, stricter: every
 * new field is written only when the caller supplies it, so a v0.7.0-shaped
 * `sessions.json` still round-trips with exactly its old key set.
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

/**
 * Read a v0.8.0 field that accepts both spellings.
 *
 * Deliberately *not* `??`: two of these fields use `null` as a meaningful
 * supplied value ("no brief was ever written", "never rolled over"), and `??`
 * would silently fall through from an explicit `null` to a stale snake_case
 * sibling. Presence, not nullishness, decides which spelling wins.
 *
 * @param {object} record the caller's input record
 * @param {string} camel e.g. `rolloverBrief`
 * @param {string} snake e.g. `rollover_brief`
 * @returns {unknown}
 */
function pick(record, camel, snake) {
  if (record[camel] !== undefined) return record[camel]
  return record[snake]
}

/** How many turns a session may accumulate before the plugin suggests a reset. */
export const DEFAULT_LONG_SESSION_TURNS = 8

/** How many touched files one record remembers (REQ-03). */
const MAX_TOUCHED_FILES = 10
/** How much of the previous task text one record remembers (REQ-03). */
const MAX_TASK_HEAD_CHARS = 200

/** How many touched files a rollover brief remembers (REQ-04). */
const MAX_BRIEF_FILES = 15
/** How much of the plan head a rollover brief remembers (REQ-04). */
const MAX_BRIEF_PLAN_CHARS = 600

/** The task modes a session may settle on (REQ-05). */
const KNOWN_TASK_MODES = new Set(['surgical', 'creative', 'document'])

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
 * Normalise a boolean-ish flag (`true`/`false`/`1`/`0`/`'true'`/`'false'`).
 *
 * Anything else is read as "not supplied" (undefined) so the key stays absent
 * rather than being guessed into `false` — a record without the key must remain
 * distinguishable from one that recorded a healthy turn.
 *
 * @param {unknown} value
 * @returns {boolean|undefined}
 */
function normalizeBool(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes') return true
    if (text === 'false' || text === '0' || text === 'no') return false
  }
  return undefined
}

/**
 * Normalise a task mode (REQ-05): one of the three known modes, nothing else.
 *
 * An unknown mode is dropped instead of stored, so a typo in a caller cannot
 * teach the session a persona that {@link projectSessionRow} would then have to
 * pass through to the UI.
 *
 * @param {unknown} value
 * @returns {'surgical'|'creative'|'document'|undefined}
 */
function normalizeTaskMode(value) {
  if (typeof value !== 'string') return undefined
  const mode = value.trim().toLowerCase()
  return KNOWN_TASK_MODES.has(mode) ? mode : undefined
}

/**
 * Normalise a non-negative count (`turn_count`, `cumulative_turn_count`).
 * @param {unknown} value
 * @returns {number|undefined}
 */
function normalizeCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.trunc(n))
}

/**
 * Normalise a quota-burn fraction: finite and inside `[0, 1]` (REQ-04).
 *
 * An out-of-range value is clamped rather than dropped, because "110% of the
 * quota" is real information (it means the guard ran late), and the UI's
 * progress bar would otherwise silently show nothing.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function normalizeFraction(value) {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.min(1, Math.max(0, n))
}

/**
 * Normalise a remembered path list for a rollover brief: strings only, trimmed,
 * de-duplicated in first-seen order, capped at {@link MAX_BRIEF_FILES}.
 *
 * Unlike {@link normalizeTouchedFiles} an empty result stays an empty array: a
 * brief is a structured object whose consumer reads `.cumulative_touched_files`
 * directly, so a missing key there would be a nuisance, not a compatibility win.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeBriefFiles(value) {
  if (!Array.isArray(value)) return []
  const files = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const path = item.trim()
    if (path === '') continue
    if (files.includes(path)) continue
    files.push(path)
    if (files.length === MAX_BRIEF_FILES) break
  }
  return files
}

/**
 * Normalise the plan head stored inside a rollover brief: trimmed, capped at
 * {@link MAX_BRIEF_PLAN_CHARS}, empty string when nothing was supplied.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBriefPlanHead(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  return text.length > MAX_BRIEF_PLAN_CHARS ? text.slice(0, MAX_BRIEF_PLAN_CHARS) : text
}

/**
 * Normalise a rollover brief (REQ-04) into the persisted shape.
 *
 * Accepts the contract's camelCase shape (`buildRolloverBrief` in
 * `lib/session-brief.js` returns it) and the stored snake_case shape, so a
 * persisted record can be handed straight back in.
 *
 * @param {unknown} value
 * @returns {{cumulative_touched_files: string[], last_plan_head: string, previous_turn_count: number}|undefined}
 *   undefined means "not supplied"; `null` is a *supplied* "no brief" and is
 *   normalised to the empty brief so the two shapes never mix.
 */
function normalizeRolloverBrief(value) {
  if (value === null) {
    return { cumulative_touched_files: [], last_plan_head: '', previous_turn_count: 0 }
  }
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  return {
    cumulative_touched_files: normalizeBriefFiles(
      value.cumulative_touched_files ?? value.cumulativeTouchedFiles ?? value.files,
    ),
    last_plan_head: normalizeBriefPlanHead(value.last_plan_head ?? value.lastPlanHead),
    previous_turn_count: normalizeCount(value.previous_turn_count ?? value.previousTurnCount) ?? 0,
  }
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
 * Merge a new rollover brief into the one a record already carries (REQ-04).
 *
 * A rollover does not happen once: a 16-turn, a 24-turn and a 32-turn session
 * each roll over again, and each new thread must inherit *everything* the
 * previous threads touched, not only the last eight turns. So the files are
 * concatenated in first-seen order (old first, new after — the older entry was
 * seen first), de-duplicated, and capped at fifteen: a brief that grows without
 * bound would be re-sent in the first prompt of every new thread.
 *
 * The plan head is taken from the *new* brief when it has one, because the
 * newest plan is the one the work is actually following; the old head is the
 * fallback.
 *
 * Pure: neither the record nor the brief is mutated.
 *
 * @param {object|undefined} record the existing session record, if any
 * @param {object|undefined} brief the fresh brief, camelCase
 *   (`buildRolloverBrief` shape) or snake_case
 * @param {number} [fallbackTurnCount] used when neither side names a count
 * @returns {{cumulative_touched_files: string[], last_plan_head: string, previous_turn_count: number}}
 *   the persisted (snake_case) brief shape
 */
export function mergeRolloverBrief(record, brief, fallbackTurnCount) {
  const previous = normalizeRolloverBrief(
    record?.rollover_brief ?? record?.rolloverBrief ?? undefined,
  )
  const fresh = normalizeRolloverBrief(brief)

  const files = normalizeBriefFiles([
    ...(previous?.cumulative_touched_files ?? []),
    ...(fresh?.cumulative_touched_files ?? []),
  ])

  const freshHead = fresh?.last_plan_head ?? ''
  const planHead = freshHead !== '' ? freshHead : (previous?.last_plan_head ?? '')

  // "How many turns did the previous thread run?" The newest brief is the most
  // accurate source, but a count of 0 in it means "that brief did not measure
  // one" — not "the thread ran no turns" — so it falls through to the stored
  // brief, then to the record's own live count, then to the caller's fallback.
  const freshCount = fresh?.previous_turn_count
  const previousTurnCount =
    Number.isFinite(freshCount) && freshCount > 0
      ? freshCount
      : (previous?.previous_turn_count ||
        normalizeCount(record?.turn_count) ||
        normalizeCount(fallbackTurnCount) ||
        0)

  return {
    cumulative_touched_files: files,
    last_plan_head: planHead,
    previous_turn_count: previousTurnCount,
  }
}

/**
 * The `turn_count` a session must carry into a rolled-over thread (REQ-04).
 *
 * Rolling over opens a *new* conversation, and a new conversation starts at
 * zero turns — otherwise the very first turn of the fresh thread would already
 * be flagged as "long" and the user would be told to do the thing they just
 * did. What must not be lost is how much work the session has *done*, so the
 * old count is added to `cumulative_turn_count` here.
 *
 * Pure: returns a patch, never mutates the record. Feed the result straight to
 * `set()` (all three keys are accepted in snake_case) or use
 * {@link rolloverSessionPatch} to get the whole rollover write in one object.
 *
 * @param {object|undefined} record the record as it stands before the rollover
 * @returns {{turn_count: number, cumulative_turn_count: number}} where
 *   `turn_count` is always `0` and `cumulative_turn_count` is the total
 * @example
 * set(state, { sessionId, workspace, ...nextTurnCountAfterRollover(record) })
 */
export function nextTurnCountAfterRollover(record) {
  const already = normalizeCount(record?.cumulative_turn_count) ?? 0
  const current = normalizeCount(record?.turn_count) ?? 0
  return { turn_count: 0, cumulative_turn_count: already + current }
}

/**
 * The complete field patch for one rollover (REQ-04).
 *
 * This is `nextTurnCountAfterRollover` plus the two brief fields and the
 * timestamp, in the persisted snake_case spelling, so `index.js` writes the
 * rollover in a single `set()` call instead of remembering four field names and
 * their inheritance rules. `turn_count` is reset here; `task_mode`,
 * `last_turn_failed` and `burn_cumulative` are *not* touched, because they are
 * session-scoped and `set()` already carries them across the new conversation.
 *
 * @param {object|undefined} record the record as it stands before the rollover
 * @param {{brief?: object, now?: Date|number|string}} [o] the fresh brief (if
 *   any) and the rollover instant (defaults to the current clock)
 * @returns {{turn_count: number, cumulative_turn_count: number,
 *   rollover_brief: object, rolled_over_at: string}} the patch for `set()`
 */
export function rolloverSessionPatch(record, { brief, now } = {}) {
  const counts = nextTurnCountAfterRollover(record)
  const nowMs = toMs(now) ?? parseTime(now) ?? Date.now()
  return {
    ...counts,
    rollover_brief: mergeRolloverBrief(record, brief),
    rolled_over_at: new Date(nowMs).toISOString(),
  }
}

/**
 * Flatten a persisted record into the row the dashboard renders (UI-REQ-02).
 *
 * WHY THIS LIVES HERE (v0.8.0)
 * ----------------------------
 * v0.7.0 had `index.js` hand-build this shape. With v0.8.0 the row grows four
 * more session-scoped fields, and hand-building it in two places is how a UI
 * ends up reading `cumulative_turn_count` while the writer spells it
 * `cumulativeTurnCount`. One projection, one spelling.
 *
 * `longSession` cannot be derived from the record alone: the threshold lives in
 * config. It is therefore a parameter, defaulting to
 * {@link DEFAULT_LONG_SESSION_TURNS} so a caller that does not care still gets
 * the v0.7.0 default of eight turns.
 *
 * Every field is always present (with `null`/`[]`/`0` defaults) so the page can
 * read `row.taskMode` without guarding.
 *
 * @param {object|undefined} record a persisted session record
 * @param {{longSessionTurns?: number}} [o] the configured turn threshold
 * @returns {{
 *   sessionId: string,
 *   conversationId: string|null,
 *   workspaceDir: string|null,
 *   tier: string|null,
 *   turnCount: number,
 *   cumulativeTurnCount: number,
 *   longSession: boolean,
 *   lastTouchedFiles: string[],
 *   lastTaskHead: string|null,
 *   taskMode: string|null,
 *   lastTurnFailed: boolean|null,
 *   burnCumulative: number|null,
 *   updatedAt: string|null,
 * }}
 */
export function projectSessionRow(record, { longSessionTurns = DEFAULT_LONG_SESSION_TURNS } = {}) {
  const row = record !== null && typeof record === 'object' ? record : {}

  const turnCount = normalizeCount(row.turn_count) ?? 0
  // A v0.7.0 record has no cumulative counter; its thread count IS the session
  // total, so falling back keeps the UI honest instead of showing a confident 0.
  const cumulativeTurnCount = normalizeCount(row.cumulative_turn_count) ?? turnCount

  const limit = Number(longSessionTurns)
  const threshold = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LONG_SESSION_TURNS

  return {
    sessionId: row.session_id === undefined || row.session_id === null ? '?' : String(row.session_id),
    conversationId: row.conversation_id ?? null,
    workspaceDir: row.workspace_dir ?? null,
    tier: row.tier ?? null,
    turnCount,
    cumulativeTurnCount,
    longSession: turnCount >= threshold,
    lastTouchedFiles: Array.isArray(row.last_touched_files) ? [...row.last_touched_files] : [],
    lastTaskHead: row.last_task_head ?? null,
    taskMode: normalizeTaskMode(row.task_mode) ?? null,
    lastTurnFailed: normalizeBool(row.last_turn_failed) ?? null,
    burnCumulative: normalizeFraction(row.burn_cumulative) ?? null,
    updatedAt: row.updated_at ?? null,
  }
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
   *
   * v0.8.0 adds six more, all optional and all written only when supplied:
   *
   * | stored key | input spellings | scope |
   * | --- | --- | --- |
   * | `last_turn_failed` | `lastTurnFailed` / `last_turn_failed` | session |
   * | `task_mode` | `taskMode` / `task_mode` | session |
   * | `burn_cumulative` | `burnCumulative` / `burn_cumulative` | session |
   * | `cumulative_turn_count` | `cumulativeTurnCount` / `cumulative_turn_count` | session |
   * | `rollover_brief` | `rolloverBrief` / `rollover_brief` | explicit only |
   * | `rolled_over_at` | `rolledOverAt` / `rolled_over_at` | explicit only |
   *
   * The first four are **session-scoped**: they survive a `conversation_id`
   * change, unlike the thread-scoped fields above. A rollover exists to drop the
   * transcript while keeping the knowledge, so forgetting "the last turn failed"
   * or "this session is on document mode" at the exact moment the thread changes
   * would defeat the point. The last two appear only when the caller supplies
   * them, because a session that never rolled over must keep its old key set.
   *
   * `rolled_over_at` accepts a `Date`, epoch ms, or ISO string and is stored as
   * ISO; `rollover_brief` accepts the camelCase shape `buildRolloverBrief`
   * returns as well as the stored snake_case shape.
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

    // v0.8.0 session-scoped state. THE INHERITANCE RULE IS DIFFERENT HERE ON
    // PURPOSE: these describe the *session*, not the thread. A new
    // `conversation_id` must not forget that the last turn failed, which persona
    // the session settled on, how much work it has accumulated, or how much of
    // the quota it has already burned — a rollover exists precisely to keep that
    // knowledge while dropping the transcript. So the fallback to `existing`
    // is unconditional and `sameThread` is deliberately not consulted.
    const lastTurnFailed =
      normalizeBool(pick(record, 'lastTurnFailed', 'last_turn_failed')) ??
      normalizeBool(existing?.last_turn_failed)
    const taskMode =
      normalizeTaskMode(pick(record, 'taskMode', 'task_mode')) ??
      normalizeTaskMode(existing?.task_mode)
    const burnCumulative =
      normalizeFraction(pick(record, 'burnCumulative', 'burn_cumulative')) ??
      normalizeFraction(existing?.burn_cumulative)

    // `cumulative_turn_count` is a *reading*, never arithmetic done behind the
    // caller's back: a `set()` that merely records this turn's count must not
    // invent a second counter, or every v0.7.0-shaped write would gain a key it
    // never asked for. The rollover arithmetic lives in
    // {@link rolloverSessionPatch} / {@link nextTurnCountAfterRollover}.
    const cumulativeTurnCount =
      normalizeCount(pick(record, 'cumulativeTurnCount', 'cumulative_turn_count')) ??
      normalizeCount(existing?.cumulative_turn_count)

    // rollover_brief / rolled_over_at appear ONLY when supplied: they are the
    // two fields a rollover writes, and a session that never rolled over must
    // keep a v0.7.0 key set. Both accept an explicit `null` as "recorded, but
    // empty" — that is a value the caller chose, not a missing one.
    const rolloverBrief = normalizeRolloverBrief(pick(record, 'rolloverBrief', 'rollover_brief'))
    const rolledOverAt = (() => {
      const raw = pick(record, 'rolledOverAt', 'rolled_over_at')
      if (raw === null) return null
      const ms = toMs(raw) ?? parseTime(raw)
      return ms === undefined ? undefined : new Date(ms).toISOString()
    })()

    const next = compact({
      session_id: String(sessionId),
      conversation_id: conversationId,
      workspace_dir: String(workspace),
      tier: record.tier ?? existing?.tier,
      turn_count: turnCount ?? (Number.isFinite(carriedTurns) ? carriedTurns : undefined),
      last_touched_files: touchedFiles,
      last_task_head: taskHead,
      last_turn_failed: lastTurnFailed,
      task_mode: taskMode,
      rollover_brief: rolloverBrief,
      rolled_over_at: rolledOverAt,
      cumulative_turn_count: cumulativeTurnCount,
      burn_cumulative: burnCumulative,
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
