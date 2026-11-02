/**
 * Long-session rollover memory brief (REQ-04).
 *
 * WHY THIS EXISTS
 * ---------------
 * A conversation that has run for many turns is not just expensive, it is
 * *cold-start expensive*: the next turn re-sends a long history and the planner
 * still re-explores the project from scratch. Starting a fresh conversation is
 * the cheap move, but a blank conversation knows nothing — it re-globs the tree,
 * re-reads the entry points and re-runs the environment checks, which is exactly
 * the cold-start cost the rollover was supposed to remove.
 *
 * So a rollover carries a small, bounded memory across: which files the session
 * has already modified (cumulatively, oldest touch first) and the head of the
 * work in progress. The banner built here is prepended to the first prompt of
 * the new conversation and ends with one hard instruction — start from these
 * files, do not rescan the whole project.
 *
 * RELATION TO {@link contextRecoveryBanner} (lib/sessions.js)
 * ----------------------------------------------------------
 * That banner handles the *involuntary* case: a dead conversation was evicted
 * and a replacement opened, so the record's last-touched files are the only
 * survival. This module handles the *deliberate* case: the session is healthy
 * but long, and we choose to roll it over while it still has more to remember
 * (cumulative files from every turn, plus the current plan head). Same spirit,
 * separately implemented on purpose — this is a pure, dependency-free module so
 * it can be tested on its own and imported without pulling the session store in.
 *
 * CONTRACT
 * --------
 * Pure and total: no imports, no store, no clock, no I/O, and no input can make
 * it throw. Unreadable input degrades to an empty brief, never to an exception,
 * because this runs on the delegation hot path.
 *
 * @module antigravity-executor/lib/session-brief
 */

/** How many cumulative touched files one brief may carry. */
const MAX_CUMULATIVE_FILES = 15
/** How much of the plan (or of the previous task head) one brief remembers. */
const MAX_PLAN_HEAD_CHARS = 600
/** Turn count at which a session is considered long (matches sessions.js). */
const DEFAULT_LONG_SESSION_TURNS = 8

/**
 * `String()` with the exception path closed.
 *
 * A hand-edited or foreign record can carry a value whose `toString` is not
 * callable (`{ toString: null }`), and `String()` throws on it. Every coercion
 * in this module goes through a safe helper: the brief is a convenience and
 * must never be the reason a delegation fails.
 */
function safeString(value) {
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** `Number()` with the exception path closed (`Number(Symbol())` throws). */
function safeNumber(value) {
  try {
    return Number(value)
  } catch {
    return Number.NaN
  }
}

/**
 * Normalise a path to slash form and drop a redundant leading `./`.
 *
 * The editor-facing form is always the slash form, even on Windows: the brief
 * is read by an agent and pasted into a prompt, not fed back to `path`.
 */
function toSlashes(value) {
  let path = safeString(value).trim().replace(/\\/g, '/')
  while (path.startsWith('./')) path = path.slice(2)
  return path
}

/**
 * Strip the workspace prefix so the brief speaks in workspace-relative paths.
 *
 * Absolute paths waste prompt tokens and leak the user's drive layout into the
 * new conversation. Paths outside the workspace are kept verbatim (in slash
 * form) — the agent may legitimately have touched a reference file elsewhere,
 * and silently rewriting it would point at the wrong place.
 *
 * The comparison is case-insensitive and separator-anchored: Windows paths are
 * case-insensitive, and `F:/work/app2/x` must not lose a prefix it never had
 * just because it starts with the workspace's characters.
 */
function stripWorkspacePrefix(path, workspace) {
  if (workspace === undefined || workspace === null) return path
  let root = toSlashes(workspace)
  while (root.length > 1 && root.endsWith('/')) root = root.slice(0, -1)
  if (root === '') return path

  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return path

  const rest = path.slice(prefix.length)
  // A path that IS the workspace root is a directory, not a touched file.
  return rest === '' ? path : rest
}

/**
 * Read `turn_count`, with every non-number degraded to 0.
 *
 * Accepts the camelCase projection too: `projectSessionRow` hands index.js a
 * `turnCount`, and a caller should not have to remember which shape it holds.
 */
function readTurnCount(record) {
  if (record === null || typeof record !== 'object') return 0
  const turns = safeNumber(record.turn_count ?? record.turnCount)
  if (!Number.isFinite(turns)) return 0
  return Math.max(0, Math.trunc(turns))
}

/** Strings only, in order: anything else in a remembered list is noise. */
function readFileList(value) {
  if (!Array.isArray(value)) return []
  const files = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (item.trim() === '') continue
    files.push(item)
  }
  return files
}

/**
 * Trim and hard-cap a plan head.
 *
 * The cap is a slice, not a slice-plus-ellipsis: appending `…` would make the
 * stored string 601 characters and quietly break the documented bound (same
 * rule as `normalizeTaskHead` in sessions.js).
 */
function readPlanHead(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  return text.length > MAX_PLAN_HEAD_CHARS ? text.slice(0, MAX_PLAN_HEAD_CHARS) : text
}

/** A missing/non-object options bag must not throw on destructuring. */
function asOptions(options) {
  return options !== null && typeof options === 'object' ? options : {}
}

/** A missing/non-object record reads as an empty record. */
function asRecord(record) {
  return record !== null && typeof record === 'object' ? record : {}
}

/**
 * Build the memory that a fresh conversation should inherit.
 *
 * De-duplication happens on the *normalised* form, so `F:\ws\src\a.js` and
 * `src/a.js` collapse into one entry instead of listing the same file twice —
 * first-seen order wins, and the cap applies after merging.
 *
 * @param {object} [record] a persisted session record (snake_case) or row
 * @param {{extraFiles?: string[], planText?: string}} [options] `extraFiles` are
 *   appended after the record's own list; pass a previous brief's files here to
 *   chain rollovers across several generations.
 * @returns {{cumulativeTouchedFiles: string[], lastPlanHead: string, previousTurnCount: number}}
 */
export function buildRolloverBrief(record, options) {
  const row = asRecord(record)
  const { extraFiles, planText } = asOptions(options)
  const workspace = row.workspace_dir ?? row.workspaceDir ?? row.workspace

  const files = []
  const seen = new Set()
  for (const raw of [
    ...readFileList(row.last_touched_files ?? row.lastTouchedFiles),
    ...readFileList(extraFiles),
  ]) {
    const path = stripWorkspacePrefix(toSlashes(raw), workspace)
    if (path === '') continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    files.push(path)
    if (files.length === MAX_CUMULATIVE_FILES) break
  }

  // The live plan wins; a session that never got one falls back to the head of
  // the last task, which is the only other thing the record remembers.
  const head =
    readPlanHead(planText) || readPlanHead(row.last_task_head ?? row.lastTaskHead)

  return {
    cumulativeTouchedFiles: files,
    lastPlanHead: head,
    previousTurnCount: readTurnCount(row),
  }
}

/**
 * The banner prepended to the first prompt of the rolled-over conversation.
 *
 * Contentless briefs return undefined: a banner with no files, no summary and
 * zero turns would only add tokens to a delegation that carries no state.
 *
 * Accepts both the camelCase shape returned by {@link buildRolloverBrief} and
 * the persisted snake_case shape of `record.rollover_brief`, because the caller
 * may be rendering straight out of the session store.
 *
 * @param {object} [brief]
 * @returns {string|undefined}
 */
export function renderRolloverPrompt(brief) {
  if (brief === null || typeof brief !== 'object') return undefined
  const row = asRecord(brief)

  const files = []
  const seen = new Set()
  for (const raw of readFileList(row.cumulativeTouchedFiles ?? row.cumulative_touched_files)) {
    const path = toSlashes(raw)
    if (path === '') continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    files.push(path)
    if (files.length === MAX_CUMULATIVE_FILES) break
  }

  const head = readPlanHead(row.lastPlanHead ?? row.last_plan_head)
  const turns = safeNumber(row.previousTurnCount ?? row.previous_turn_count)
  const count = Number.isFinite(turns) ? Math.max(0, Math.trunc(turns)) : 0

  if (files.length === 0 && head === '' && count === 0) return undefined

  const lines = [
    '[Rollover Brief] 这是一个带记忆结转的新会话：前一段会话已结束，' +
      '下面是从它结转过来的全部记忆，请当作「已经做过功课」的续作，而不是一个陌生项目。',
  ]
  if (count > 0) {
    lines.push(`${'turn count'.padEnd(17)}: 前一段会话已完成 ${count} 轮（本会话从第 1 轮重新计数）`)
  }
  if (files.length > 0) {
    lines.push(
      `${'cumulative files'.padEnd(17)}: 累计修改 ${files.length} 个文件，按首次触碰顺序（最多 ${MAX_CUMULATIVE_FILES} 条）`,
    )
    files.forEach((path, index) => {
      lines.push(`  ${String(index + 1).padStart(2)}. ${path}`)
    })
  }
  if (head !== '') {
    lines.push(`${'progress digest'.padEnd(17)}: ${head}`)
  }
  lines.push(
    `${'hard instruction'.padEnd(17)}: 直接从上面这些相关文件切入——先读它们再动手，` +
      '不要重新全盘扫描项目，也不要重新探索目录结构或重跑一遍环境检查；' +
      '整盘冷启动会白白烧掉大量配额。',
  )
  lines.push('[End of Rollover Brief]')
  return lines.join('\n')
}

/**
 * Has this session reached the rollover watermark?
 *
 * An invalid threshold degrades to {@link DEFAULT_LONG_SESSION_TURNS} rather
 * than throwing or silently treating everything as long.
 *
 * @param {object} [record]
 * @param {{longSessionTurns?: number}} [options]
 * @returns {boolean}
 */
export function isLongSession(record, options) {
  const { longSessionTurns } = asOptions(options)
  const raw = safeNumber(longSessionTurns)
  const threshold =
    Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_LONG_SESSION_TURNS
  return readTurnCount(record) >= threshold
}
