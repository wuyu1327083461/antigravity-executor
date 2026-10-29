/**
 * Transcript reading and step normalization (REQ-02).
 *
 * Antigravity keeps two copies of a conversation's step log under
 * `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/`:
 *
 *   - `transcript.jsonl`       compact; fields longer than ~4000 chars carry
 *                              `truncated_fields: ["content"]`.
 *   - `transcript_full.jsonl`  same steps, same order, never truncated.
 *
 * When the full copy is missing (or lags behind the compact one, because the
 * desktop app flushes them at different moments) the compact copy is used and
 * any truncated step is repaired from `GetCascadeTrajectorySteps`, whose steps
 * are never truncated either. That gives us two independent fallbacks.
 *
 * `normalizeStep` folds both sources (RPC `CORTEX_STEP_TYPE_*` objects and
 * already-normalized transcript rows) into the single shape frozen in
 * CONTRACT.md §4, so downstream code never has to know where a step came from.
 *
 * @module antigravity-executor/lib/transcript
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TYPE_PREFIX = 'CORTEX_STEP_TYPE_'
const STATUS_PREFIX = 'CORTEX_STEP_STATUS_'
const COMPACT_FILE = 'transcript.jsonl'
const FULL_FILE = 'transcript_full.jsonl'

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * Root of the Antigravity brain directory.
 *
 * `AGY_BRAIN_DIR` overrides it so tests can point the reader at a fixture
 * directory instead of the real profile.
 */
export function brainDir() {
  const override = process.env.AGY_BRAIN_DIR
  if (typeof override === 'string' && override.trim() !== '') return override
  return join(homedir(), '.gemini', 'antigravity', 'brain')
}

/**
 * All three paths for one conversation.
 *
 * @returns {{ dir: string, compact: string, full: string }}
 */
export function transcriptPaths(conversationId) {
  const dir = join(brainDir(), String(conversationId), '.system_generated', 'logs')
  return {
    dir,
    compact: join(dir, COMPACT_FILE),
    full: join(dir, FULL_FILE),
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** First defined, non-empty value among dotted paths. */
function firstDefined(source, paths) {
  for (const path of paths) {
    let cursor = source
    for (const key of path.split('.')) {
      if (cursor === null || cursor === undefined) {
        cursor = undefined
        break
      }
      cursor = cursor[key]
    }
    if (cursor !== undefined && cursor !== null && cursor !== '') return cursor
  }
  return undefined
}

/** Strip the protobuf enum prefix (`CORTEX_STEP_TYPE_RUN_COMMAND` -> `RUN_COMMAND`). */
function stripPrefix(value, prefix) {
  const text = String(value ?? '')
  return text.startsWith(prefix) ? text.slice(prefix.length) : text
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * Turn a `file:///F:/x/y` URI into a plain absolute path, leaving anything that
 * is already a path untouched.
 *
 * RPC steps name files as `viewFile.absolutePathUri`, but the auditor compares
 * plain paths against the workspace — a `file:///` prefix would never match and
 * every read would look like an escape.
 */
function uriToPath(value) {
  const text = String(value ?? '')
  if (!text.startsWith('file://')) return text
  let rest = text.slice('file://'.length)
  // `file:///F:/x` -> `/F:/x`; strip the leading slash so the drive letter leads.
  if (rest.startsWith('/')) rest = rest.slice(1)
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}

/**
 * `metadata.toolCall.argumentsJson` is a *string* holding the tool arguments,
 * so it needs a second `JSON.parse`. Objects are accepted as-is for tests and
 * for the already-normalized transcript shape.
 */
function parseArgs(value) {
  if (value !== null && typeof value === 'object') return value
  if (!nonEmptyString(value)) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Read one tool call from any of the carriers Antigravity uses. */
function readToolCall(call) {
  if (call === null || typeof call !== 'object') return undefined
  const inner = call.toolCall !== null && typeof call.toolCall === 'object' ? call.toolCall : call
  const name = firstDefined(inner, ['name', 'toolName', 'tool_name'])
  if (!nonEmptyString(name)) return undefined
  const args = parseArgs(
    inner.args ?? inner.argumentsJson ?? inner.argsJson ?? inner.arguments ?? call.args,
  )
  return { name, args }
}

function pushCall(out, call) {
  const normalized = readToolCall(call)
  if (normalized === undefined) return
  // RPC sometimes reports the same call both on `metadata.toolCall` and inside
  // `plannerResponse.toolCalls`; keep one entry per (name, args) pair.
  const signature = `${normalized.name}:${JSON.stringify(normalized.args)}`
  if (out.some((existing) => `${existing.name}:${JSON.stringify(existing.args)}` === signature)) {
    return
  }
  out.push(normalized)
}

function isTruncated(source) {
  if (source.truncated === true) return true
  const fields = source.truncated_fields ?? source.metadata?.truncatedFields
  return Array.isArray(fields) && fields.length > 0
}

// ---------------------------------------------------------------------------
// normalizeStep
// ---------------------------------------------------------------------------

function stepIndex(raw, index) {
  const value = firstDefined(raw, [
    'step_index',
    'stepIndex',
    'metadata.stepIndex',
    'metadata.step_index',
  ])
  const number = Number(value)
  if (Number.isFinite(number)) return number
  const fallback = Number(index)
  return Number.isFinite(fallback) ? fallback : 0
}

/** Type aliases folded onto one canonical name (CONTRACT.md §4 mapping table). */
const TYPE_ALIASES = Object.freeze({ READ_FILE: 'VIEW_FILE' })

function stepType(raw) {
  const type = stripPrefix(firstDefined(raw, ['type', 'metadata.type']), TYPE_PREFIX)
  if (type === '') return 'UNKNOWN'
  return TYPE_ALIASES[type] ?? type
}

function stepStatus(raw) {
  return stripPrefix(firstDefined(raw, ['status', 'metadata.status']), STATUS_PREFIX)
}

function stepContent(raw, type) {
  if (type === 'PLANNER_RESPONSE') {
    const planner = raw.plannerResponse ?? {}
    // `modifiedResponse` is what the user actually sees; fall back to `response`.
    for (const candidate of [planner.modifiedResponse, planner.response, raw.content]) {
      if (nonEmptyString(candidate)) return candidate
    }
    return ''
  }

  if (type === 'USER_INPUT') {
    const items = raw.userInput?.items
    if (Array.isArray(items) && items.length > 0) {
      const parts = items
        .map((item) => {
          if (typeof item === 'string') return item
          if (nonEmptyString(item?.text)) return item.text
          return ''
        })
        .filter((part) => part !== '')
      if (parts.length > 0) return parts.join('\n')
    }
    return nonEmptyString(raw.content) ? raw.content : ''
  }

  if (type === 'ERROR_MESSAGE') {
    const error = raw.errorMessage?.error ?? {}
    for (const candidate of [error.shortError, error.message, raw.content]) {
      if (nonEmptyString(candidate)) return candidate
    }
    return ''
  }

  // A file-view step carries its (possibly long) payload in `viewFile.content`
  // when it comes from RPC, and in `content` when it comes from the transcript.
  // The truncation repair compares these two lengths, so the RPC side has to
  // surface the text here or the comparison silently "succeeds" against the
  // already-truncated compact copy.
  if (type === 'VIEW_FILE') {
    for (const candidate of [raw.viewFile?.content, raw.readFile?.content, raw.content]) {
      if (nonEmptyString(candidate)) return candidate
    }
    return ''
  }

  return nonEmptyString(raw.content) ? raw.content : ''
}

function stepToolCalls(raw, type) {
  const out = []

  // (1) RPC carrier. Authoritative: a tool step can still be reported as
  // `CORTEX_STEP_TYPE_GENERIC` while it generates, but its name always lives in
  // `metadata.toolCall.name`, and `argumentsJson` is complete (never truncated).
  const metaCall = raw.metadata?.toolCall
  if (metaCall !== null && typeof metaCall === 'object') pushCall(out, metaCall)

  // (2) Already-normalized transcript rows.
  if (Array.isArray(raw.tool_calls)) for (const call of raw.tool_calls) pushCall(out, call)

  // (3) Calls requested by a planner message.
  if (Array.isArray(raw.plannerResponse?.toolCalls)) {
    for (const call of raw.plannerResponse.toolCalls) pushCall(out, call)
  }

  // (4) Type-specific fallbacks, used only when no carrier matched.
  if (out.length === 0 && type === 'RUN_COMMAND') {
    const command = firstDefined(raw, ['runCommand.commandLine', 'runCommand.command'])
    if (nonEmptyString(command)) pushCall(out, { name: 'run_command', args: { CommandLine: command } })
  }
  if (out.length === 0 && type === 'VIEW_FILE') {
    // RPC names the path in `absolutePathUri` (a `file:///` URL); the transcript
    // uses plain `path`. Both spellings have to reach the auditor, which compares
    // the path against the workspace.
    const path = firstDefined(raw, [
      'viewFile.path',
      'viewFile.filePath',
      'viewFile.absolutePathUri',
      'readFile.path',
      'readFile.absolutePathUri',
    ])
    if (nonEmptyString(path)) {
      pushCall(out, { name: 'view_file', args: { Path: uriToPath(path) } })
    }
  }

  return out
}

/**
 * Fold one raw step into the canonical shape (CONTRACT.md §4).
 *
 * Works for both sources:
 *   - RPC `GetCascadeTrajectory(Steps)` steps (`CORTEX_STEP_TYPE_*`, `metadata.*`);
 *   - transcript JSONL rows (already `{step_index, type, content, tool_calls}`).
 *
 * @param {object} raw
 * @param {number} [index] - positional fallback when the raw step has no index
 * @returns {{ step_index: number, type: string, status: string, created_at: string,
 *             content: string, tool_calls: Array<{name: string, args: object}>,
 *             truncated?: true, raw: object }}
 */
export function normalizeStep(raw, index = 0) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const type = stepType(source)
  return {
    step_index: stepIndex(source, index),
    type,
    status: stepStatus(source),
    created_at:
      firstDefined(source, [
        'created_at',
        'createdAt',
        'metadata.createdAt',
        'metadata.created_at',
      ]) ?? '',
    content: stepContent(source, type),
    tool_calls: stepToolCalls(source, type),
    ...(isTruncated(source) ? { truncated: true } : {}),
    raw: source,
  }
}

// ---------------------------------------------------------------------------
// JSONL reading
// ---------------------------------------------------------------------------

/**
 * Parse a transcript JSONL file. Unparseable lines are skipped: while a turn is
 * running the last line is routinely a partially flushed write.
 */
async function readJsonl(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object') rows.push(value)
    } catch {
      // Partial trailing line: normal during generation, ignore it.
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// RPC fallback
// ---------------------------------------------------------------------------

/** Lazily load the real RPC client so this module also works before it exists. */
let injectedRpc

/**
 * Test hook: replace the default RPC client (the module's own `./rpc.js`).
 * Passing `undefined` restores the real one.
 */
export function setDefaultRpc(rpc) {
  injectedRpc = rpc
}

const defaultRpc = {
  async getCascadeTrajectorySteps(server, cascadeId, opts, callOpts) {
    const mod = await import('./rpc.js')
    return mod.getCascadeTrajectorySteps(server, cascadeId, opts, callOpts)
  },
}

function resolveRpc(override) {
  const base = injectedRpc ?? defaultRpc
  if (override === undefined || override === null) return base
  return { ...base, ...override }
}

/**
 * RPC-only fallback: `GetCascadeTrajectorySteps` never truncates text, so this
 * is the second-level safety net when neither transcript file is usable.
 *
 * @returns {Promise<{ steps: object[], source: 'rpc'|'none', truncatedSteps: number[] }>}
 */
export async function readTranscriptViaRpc(server, conversationId, opts = {}) {
  if (server === undefined || server === null) {
    return { steps: [], source: 'none', truncatedSteps: [] }
  }
  const { rpc, signal, startIndex = 0, timeoutMs } = opts
  try {
    const client = resolveRpc(rpc)
    const rawSteps = await client.getCascadeTrajectorySteps(
      server,
      conversationId,
      { startIndex },
      { signal, timeoutMs },
    )
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return { steps: [], source: 'none', truncatedSteps: [] }
    }
    return {
      steps: rawSteps.map((raw, index) => normalizeStep(raw, index)),
      source: 'rpc',
      truncatedSteps: [],
    }
  } catch {
    // RPC unavailable: the caller decides whether the compact copy is good enough.
    return { steps: [], source: 'none', truncatedSteps: [] }
  }
}

/**
 * Replace the content of truncated compact steps with the RPC originals.
 * @returns {Promise<{ filled: number, remaining: number[] }>}
 */
async function fillTruncatedFromRpc(server, conversationId, steps, truncatedSteps, opts) {
  const rpcRead = await readTranscriptViaRpc(server, conversationId, opts)
  if (rpcRead.source === 'none') {
    return { filled: 0, remaining: truncatedSteps }
  }

  const byIndex = new Map(rpcRead.steps.map((step) => [step.step_index, step]))
  const byTarget = new Map(steps.map((step) => [step.step_index, step]))
  const remaining = []
  let filled = 0

  for (const index of truncatedSteps) {
    const replacement = byIndex.get(index)
    const target = byTarget.get(index)
    if (replacement === undefined || target === undefined) {
      remaining.push(index)
      continue
    }
    if (nonEmptyString(replacement.content) && replacement.content.length >= target.content.length) {
      target.content = replacement.content
    }
    if (replacement.tool_calls.length > 0) target.tool_calls = replacement.tool_calls
    delete target.truncated
    filled += 1
  }

  return { filled, remaining }
}

// ---------------------------------------------------------------------------
// readTranscript
// ---------------------------------------------------------------------------

/**
 * Read every step of one conversation, preferring the untruncated copy.
 *
 * Priority (CONTRACT.md §3.3):
 *   1. `transcript_full.jsonl`, when present and not behind the compact file  -> 'full'
 *   2. `transcript.jsonl` without truncation                                  -> 'compact'
 *   3. `transcript.jsonl` + RPC repair of truncated steps                     -> 'compact+rpc'
 *   4. RPC only                                                               -> 'rpc'
 *   5. nothing available                                                      -> 'none'
 *
 * @returns {Promise<{ steps: object[], source: 'full'|'compact'|'compact+rpc'|'rpc'|'none',
 *                     truncatedSteps: number[] }>}
 */
export async function readTranscript(conversationId, options = {}) {
  const { server, preferFull = true, rpc, signal, timeoutMs } = options
  const paths = transcriptPaths(conversationId)

  const compactRaw = await readJsonl(paths.compact)
  const fullRaw = preferFull ? await readJsonl(paths.full) : []

  // The full copy wins only when it is at least as complete as the compact one:
  // the two files are flushed independently, so "full" can briefly lag behind.
  if (fullRaw.length > 0 && fullRaw.length >= compactRaw.length) {
    return {
      steps: fullRaw.map((raw, index) => normalizeStep(raw, index)),
      source: 'full',
      truncatedSteps: [],
    }
  }

  if (compactRaw.length > 0) {
    const steps = compactRaw.map((raw, index) => normalizeStep(raw, index))
    const truncatedSteps = steps
      .filter((step) => step.truncated === true)
      .map((step) => step.step_index)

    if (truncatedSteps.length === 0) {
      return { steps, source: 'compact', truncatedSteps: [] }
    }

    if (server !== undefined && server !== null) {
      const { filled, remaining } = await fillTruncatedFromRpc(
        server,
        conversationId,
        steps,
        truncatedSteps,
        { rpc, signal, timeoutMs },
      )
      if (filled > 0) {
        return {
          steps,
          // Partly repaired is still 'compact+rpc'; `truncatedSteps` says what is
          // still short so the caller can decide whether to trust the text.
          source: 'compact+rpc',
          truncatedSteps: remaining,
        }
      }
    }

    // Nothing could be repaired: hand back what we have and say what is still short.
    return { steps, source: 'compact', truncatedSteps }
  }

  if (server !== undefined && server !== null) {
    return readTranscriptViaRpc(server, conversationId, { rpc, signal, timeoutMs })
  }

  return { steps: [], source: 'none', truncatedSteps: [] }
}
