/**
 * Turn settlement (REQ-01 / REQ-08, REQ-04 hook).
 *
 * Why this module exists: the previous implementation polled the transcript and
 * declared a turn finished once a final planner message existed *and* the file
 * had been quiet for 45 seconds. A 39.9-second turn therefore cost ~85 seconds
 * of wall clock. Antigravity's own `WaitForConversationFullyIdle` is a real
 * long-poll: while the agent is busy it blocks until the turn ends, and returns
 * in ~34 ms when it is already idle. Waiting on that instead of on a fixed quiet
 * window removes the dead time entirely.
 *
 * Two traps are baked into the algorithm below (CONTRACT.md §1):
 *
 *   1. "last step is a PLANNER_RESPONSE" is NOT a completion test. A background
 *      `run_command` emits PLANNER_RESPONSE first and reports completion later
 *      through a CORTEX_STEP_TYPE_SYSTEM_MESSAGE, so completion is decided by
 *      `getAllCascadeTrajectories` (CASCADE_RUN_STATUS_IDLE) plus the trajectory's
 *      `terminationReason`, and only *then* cross-checked against the answer.
 *   2. Between tool rounds the cascade is briefly idle with a planner message
 *      already on disk. The required "tool-call-free PLANNER_RESPONSE" test plus
 *      a short `fastSettleSeconds` confirmation window absorbs that gap: if a new
 *      step appears during the window we go back and long-poll again.
 *
 * When `WaitForConversationFullyIdle` is unavailable (method missing, or a
 * retryable transport error), the whole turn degrades to
 * "poll + quietWindowSeconds of silence" — the old behaviour, only slower.
 *
 * REQ-04 needs TWO hooks because it asks two different questions (v0.6.0):
 *
 *   - `onStep(step)` is edge-driven: it runs when a *new* step appears, so a
 *     violation can be stopped before its effects are observed.
 *   - `onTick({steps, elapsedMs})` is clock-driven: it runs on every poll
 *     iteration, so a time-based rule keeps advancing even when the turn
 *     produces nothing at all.
 *
 * The second clock is not a convenience. A command that never exits — `npm run
 * dev`, a bare `vitest`, `next dev` — emits its `run_command` step exactly once
 * and then never produces another step, which is precisely the state in which
 * `onStep` can never be called again. Measured on the shipped 0.5.1 default
 * (`maxSeconds: 900`): such a turn holds the cascade BUSY until the whole
 * budget is spent, then returns a bare timeout with no diagnostics. The static
 * recognition (`findHangingCommands`) already existed; what was missing was a
 * clock, because a step-driven hook has no second edge to fire on. A
 * tick-driven rule turns that 900s burn into a cut at the caller's threshold
 * (60s in the shipped wiring).
 *
 * `onTick` is advisory in every direction: a throw is swallowed, a returned
 * promise is ignored rather than awaited (the contract is synchronous — the
 * loop must never be stalled by it), and `block: true` is handled exactly like
 * `onStep`'s block verdict, so both hooks share one kill path and one
 * settlement value.
 *
 * @module antigravity-executor/lib/turn
 */

import { readTranscript, readTranscriptViaRpc } from './transcript.js'

const RUN_STATUS_PREFIX = 'CASCADE_RUN_STATUS_'
const TERMINATION_PREFIX = 'EXECUTOR_TERMINATION_REASON_'

/**
 * terminationReason values that prove the executor stopped (CONTRACT.md §1).
 * `MAX_TOKEN_BUDGET_EXCEEDED` and friends also end the turn, so they belong here.
 */
const TERMINAL_REASONS = new Set([
  'NO_TOOL_CALL',
  'USER_CANCELED',
  'ERROR',
  'HALTED_STEP',
  'MAX_INVOCATIONS',
  'MAX_TOKEN_BUDGET_EXCEEDED',
])

/** Fallback config; the caller always passes the validated plugin config. */
const DEFAULT_CFG = Object.freeze({
  quietWindowSeconds: 45,
  pollIntervalSeconds: 2,
  fastSettleSeconds: 2,
  maxSeconds: 900,
  useFullTranscript: true,
})

// ---------------------------------------------------------------------------
// rpc dependency
// ---------------------------------------------------------------------------

let injectedRpc

/**
 * Test hook: replace the default RPC client (the module's own `./rpc.js`).
 * Passing `undefined` restores the real one.
 */
export function setDefaultRpc(rpc) {
  injectedRpc = rpc
}

/**
 * The real client is imported lazily: `./rpc.js` is written by another module
 * and may not exist yet, and a missing method must degrade the turn, not crash
 * the import of this module.
 */
const defaultRpc = {
  async waitForConversationFullyIdle(server, conversationId, opts) {
    const mod = await import('./rpc.js')
    return mod.waitForConversationFullyIdle(server, conversationId, opts)
  },
  async getAllCascadeTrajectories(server, opts) {
    const mod = await import('./rpc.js')
    return mod.getAllCascadeTrajectories(server, opts)
  },
  async getCascadeTrajectory(server, cascadeId, opts) {
    const mod = await import('./rpc.js')
    return mod.getCascadeTrajectory(server, cascadeId, opts)
  },
  async cancelCascadeInvocation(server, cascadeId, opts) {
    const mod = await import('./rpc.js')
    return mod.cancelCascadeInvocation(server, cascadeId, opts)
  },
  async getCascadeTrajectorySteps(server, cascadeId, opts, callOpts) {
    const mod = await import('./rpc.js')
    return mod.getCascadeTrajectorySteps(server, cascadeId, opts, callOpts)
  },
}

/** Per-call overrides win over the module-level test hook, which wins over the real client. */
function resolveRpc(override) {
  const base = injectedRpc ?? defaultRpc
  if (override === undefined || override === null) return base
  return { ...base, ...override }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stripPrefix(value, prefix) {
  const text = String(value ?? '')
  return text.startsWith(prefix) ? text.slice(prefix.length) : text
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** `A B  C` -> `A B C` (PowerShell line breaks in CommandLine must not break the trace). */
function flatten(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * One-line human summary of a tool call, reused for the trace and for REQ-08
 * progress events (`[step 5] run_command: npm test`).
 */
export function summarizeToolCall(call) {
  const args = call?.args ?? {}
  for (const key of ['CommandLine', 'command', 'toolSummary', 'Path', 'path', 'file_path']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return flatten(value).slice(0, 140)
  }
  return ''
}

/** Trace line format kept identical to the previous implementation. */
function traceLine(step, call) {
  const summary = summarizeToolCall(call)
  const suffix = summary === '' ? '' : ` ${summary}`
  return `  [${step.step_index}] ${call?.name ?? 'tool'}${suffix}`.trimEnd()
}

/**
 * Collect the turn's answer and tool trace from the steps of this turn.
 *
 * The answer is the *last* tool-call-free PLANNER_RESPONSE with non-empty
 * content, which is what the user actually reads as the executor's report.
 */
export function collectTurn(steps, sinceIndex = 0) {
  const trace = []
  let answer
  let answerStep
  for (const step of steps) {
    const idx = Number(step?.step_index ?? -1)
    if (!Number.isFinite(idx) || idx < sinceIndex) continue
    const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : []
    for (const call of calls) trace.push(traceLine(step, call))
    if (step?.type === 'PLANNER_RESPONSE' && calls.length === 0) {
      const content = String(step.content ?? '').trim()
      if (content !== '') {
        answer = content
        answerStep = idx
      }
    }
  }
  return { answer, answerStep, trace }
}

/**
 * Should this tick stop the turn? Pure: no clock, no I/O.
 *
 * WHY THIS IS A SEPARATE PURE FUNCTION
 * -----------------------------------
 * `onTick` runs on every poll iteration, so the rule behind it executes
 * hundreds of times per long turn and has to be reviewable on sight. Keeping it
 * out of the loop makes it testable at the exact millisecond boundary (one ms
 * early vs. exactly at the threshold) with no fake rpc, no fake transcript and
 * no fake clock — and it keeps `waitForTurn` free of any opinion about *why* a
 * step is hanging. That judgement belongs to the caller (`findHangingCommands`
 * in `audit.js`); this function only answers the timing question.
 *
 * THE RULE
 * --------
 * A command that never exits has a signature: its `run_command` step is the
 * newest step of the turn, and it stays the newest one forever. So a turn is
 * only treated as hung when all three of these hold:
 *
 *   1. an open hanging entry points at the newest step (`stepIndex ===
 *      newestStepIndex`). A newer step means the executor moved on; the command
 *      is then background work, which the normal settlement path already
 *      handles, and cutting it would kill a healthy long turn.
 *   2. the newest step is at least `timeoutMs` old (`now - newestStepAt >=
 *      timeoutMs`). Measured from the newest step, not from the turn start, so
 *      a busy turn that keeps producing steps can never trip the rule.
 *   3. `timeoutMs > 0`. Zero/NaN/negative means "rule disabled", which stops a
 *      mis-configured caller from killing every turn on its first tick.
 *
 * Presence in `hanging` means "still open": the caller drops an entry once the
 * command exits. `since` (when the hit was first observed) is carried for the
 * caller's own detail line and deliberately plays no part in the decision — the
 * quantity that distinguishes a hang from ordinary long-running work is how
 * long *no new step* has appeared.
 *
 * Every field is untrusted (the caller builds this from a config value and a
 * Map it assembled across scans): missing, non-finite, negative and non-array
 * input all degrade to "do not block", and the function never throws.
 *
 * @param {object} [input]
 * @param {Array<{stepIndex: number, since?: number}>} [input.hanging] open hang hits
 * @param {number} [input.newestStepIndex] step_index of the newest step of this turn
 * @param {number} [input.newestStepAt]     wall clock when that step first appeared
 * @param {number} [input.now]              wall clock at this tick
 * @param {number} [input.timeoutMs]        how long a stuck newest step may sit
 * @returns {{block: false}|{block: true, reason: string, stepIndex: number, waitedMs: number}}
 */
export function evaluateHangingTimeout(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const timeoutMs = Number(source.timeoutMs)
  const now = Number(source.now)
  const newestStepAt = Number(source.newestStepAt)
  const newestStepIndex = Number(source.newestStepIndex)
  const { hanging } = source

  // Order matters: the cheapest disqualifiers first, so a disabled rule costs
  // nothing and can never be reached by a half-populated input.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { block: false }
  if (!Number.isFinite(now) || !Number.isFinite(newestStepAt)) return { block: false }
  if (!Number.isFinite(newestStepIndex)) return { block: false }
  if (!Array.isArray(hanging) || hanging.length === 0) return { block: false }

  const waitedMs = now - newestStepAt
  // Two clocks mixed by the caller reads as a negative wait. That is not
  // evidence of a hang, so it must not block.
  if (!Number.isFinite(waitedMs) || waitedMs < timeoutMs) return { block: false }

  const hit = hanging.find((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    const stepIndex = Number(entry.stepIndex)
    return Number.isFinite(stepIndex) && stepIndex === newestStepIndex
  })
  if (hit === undefined) return { block: false }

  return {
    block: true,
    reason:
      `已在 ${Math.round(waitedMs / 1000)}s 后中止：检测到疑似常驻/交互式挂起命令` +
      `（第 ${newestStepIndex} 步之后无新步骤）。`,
    stepIndex: newestStepIndex,
    waitedMs,
  }
}

function isAbort(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError' || error?.code === 'aborted'
}

/**
 * Combine the caller's cancellation signal with a local one.
 *
 * The long poll needs its own abort handle so a kill-switch finding can cut it
 * short, but it must still observe the caller's cancellation. `AbortSignal.any`
 * does exactly that; the manual fallback keeps older runtimes working.
 */
function combineSignals(signal, local) {
  if (signal === undefined || signal === null) return local
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, local])
  const controller = new AbortController()
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  local.addEventListener('abort', () => controller.abort(local.reason), { once: true })
  return controller.signal
}

/**
 * Start one long poll and expose it as a small handle.
 *
 * The handle exists so the main loop can keep scanning while the poll blocks:
 * `done` is a promise that never rejects (the outcome is captured in `result`
 * / `settled` instead), `abort()` cancels the underlying request, and `settled`
 * is a plain flag the tick loop can read synchronously.
 */
function startLongPoll(rpc, server, conversationId, { signal, timeoutMs }) {
  const controller = new AbortController()
  const handle = { settled: false, result: undefined, abort: () => controller.abort() }
  handle.done = Promise.resolve()
    .then(() =>
      rpc.waitForConversationFullyIdle(server, conversationId, {
        signal: combineSignals(signal, controller.signal),
        timeoutMs,
      }),
    )
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    )
    .then((result) => {
      handle.result = result
      handle.settled = true
      return result
    })
  return handle
}

/**
 * A long-poll timeout is not a degradation trigger: it means the turn is still
 * running past the poll budget, which is exactly the case to poll again. Only a
 * *client-side* budget timeout counts; the server never answers this way.
 */
function isLongPollTimeout(error) {
  const name = String(error?.name ?? '')
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '')
  if (name === 'AbortError') return false // caller cancellation, handled elsewhere
  return (
    name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'timeout' ||
    /超时|timeout/i.test(message)
  )
}

/**
 * Errors that mean "the long poll is not usable here" rather than "the turn
 * failed": a missing/unknown method, or a retryable transport problem.
 */
function shouldDegrade(error) {
  const message = String(error?.message ?? '')
  const code = String(error?.code ?? '')
  if (isLongPollTimeout(error) && code !== 'unknown') {
    // Transport timed out: retry the poll, do not switch modes.
    return false
  }
  return (
    error?.retryable === true ||
    code === 'unknown' ||
    code === 'not_found' ||
    code === 'unimplemented' ||
    error?.httpStatus === 404 ||
    error?.httpStatus === 405 ||
    error?.httpStatus === 501 ||
    /unknown method|method not found|not implemented|unimplemented/i.test(message)
  )
}

/** Read cascade status + terminationReason; never throws. */
async function readCascadeState(rpc, server, conversationId, opts) {
  const state = { status: undefined, idle: undefined, terminationReason: undefined }
  try {
    const trajectories = await rpc.getAllCascadeTrajectories(server, opts)
    const summaries = trajectories?.trajectorySummaries ?? {}
    const entry = summaries[conversationId] ?? Object.values(summaries)[0]
    if (entry !== undefined && entry !== null) {
      state.status = stripPrefix(entry.status, RUN_STATUS_PREFIX)
      state.idle = state.status === 'IDLE'
    }
  } catch {
    // Unconfirmed (undefined), not "running": the caller decides how strict to be.
    state.idle = undefined
  }
  try {
    const trajectory = await rpc.getCascadeTrajectory(server, conversationId, opts)
    // The RPC answers `{ trajectory: {...}, status, numTotalSteps, ... }`, so the
    // metadata lives one level down. Reading the top level silently yielded
    // `undefined` for every turn — which is why an ERROR-terminated cascade
    // looked alive and ran to the deadline instead of failing immediately.
    const body = trajectory?.trajectory ?? trajectory
    const metas = Array.isArray(body?.executorMetadatas) ? body.executorMetadatas : []
    const reasons = metas
      .map((meta) => stripPrefix(meta?.terminationReason, TERMINATION_PREFIX))
      .filter((reason) => reason !== '')
    if (reasons.length > 0) state.terminationReason = reasons[reasons.length - 1]
  } catch {
    // terminationReason is informative; its absence must not block settlement.
  }
  // A terminal terminationReason is independent proof that the executor stopped,
  // so a failed status lookup degrades to "idle" instead of spinning to timeout.
  if (state.idle === undefined && TERMINAL_REASONS.has(state.terminationReason) === true) {
    state.idle = true
    state.idleConfirmedBy = 'terminationReason'
  }
  return state
}

// ---------------------------------------------------------------------------
// waitForTurn
// ---------------------------------------------------------------------------

/**
 * Wait for one delegated turn to finish and collect its result.
 *
 * @param {object} o
 * @param {string} o.conversationId
 * @param {number} [o.sinceIndex=0]      first step_index of this turn
 * @param {object} [o.server]            `{ port, csrf }` from discovery
 * @param {object} [o.cfg]               validated plugin config
 * @param {AbortSignal} [o.signal]
 * @param {(ev: {kind: 'step'|'progress'|'idle', step?: object, text?: string, trace?: string[]}) => void} [o.onEvent]
 * @param {(step: object) => ({block?: boolean, reason?: string})} [o.onStep]  REQ-04 edge hook
 * @param {(ctx: {steps: object[], elapsedMs: number}) => ({block?: boolean, reason?: string}|undefined)} [o.onTick]
 *   REQ-04 clock hook (v0.6.0): runs on every poll iteration, including the
 *   iterations where no new step arrives. Must be synchronous — a returned
 *   promise is ignored, never awaited, so it cannot stall the loop. A throw is
 *   swallowed. `block: true` is handled exactly like `onStep`'s block verdict.
 * @param {object} [o.rpc]               injected RPC client (tests)
 * @param {function} [o.readSteps]       injected step reader (tests)
 * @param {function} [o.sleep]           injected sleep (tests)
 * @param {number} [o.timeoutMs]         overrides cfg.maxSeconds
 * @returns {Promise<{ answer: string|undefined, trace: string[], steps: object[],
 *   settlement: 'rpc-idle'|'quiet-window'|'timeout', elapsedMs: number,
 *   terminationReason?: string, killed?: {step?: object, reason: string},
 *   note?: string, error?: string }>}
 */
export async function waitForTurn(o = {}) {
  const conversationId = String(o.conversationId ?? '')
  const sinceIndex = Number.isFinite(Number(o.sinceIndex)) ? Number(o.sinceIndex) : 0
  const server = o.server
  const cfg = { ...DEFAULT_CFG, ...(o.cfg ?? {}) }
  const signal = o.signal
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : undefined
  const onStep = typeof o.onStep === 'function' ? o.onStep : undefined
  // Non-function is "hook absent", not an error: `onTick` is optional and its
  // absence must behave exactly like 0.5.1 (no extra reads, no extra calls).
  const onTick = typeof o.onTick === 'function' ? o.onTick : undefined
  const rpc = resolveRpc(o.rpc)
  // Injectable clock: tests advance time explicitly instead of waiting.
  const now = typeof o.now === 'function' ? o.now : () => Date.now()
  const sleep =
    typeof o.sleep === 'function'
      ? o.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * Yield to the event loop without consuming the (possibly injected) clock.
   *
   * The long poll runs as a background promise, and a fake `sleep` that resolves
   * synchronously never gives that promise's `.then` chain a turn to run — the
   * tick loop would spin until the deadline even though the poll had already
   * resolved. One real macrotask hop per tick fixes that and costs nothing.
   */
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  /**
   * Real wall-clock delay for the scan cadence.
   *
   * The cadence must be independent of the injected clock: the long poll runs
   * concurrently with it, and sharing one fake clock would charge the same
   * elapsed time twice (measured: a 39.9s turn reported 43.9s). In tests the
   * poll resolves immediately, so the race never waits out this timer at all.
   */
  const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)))

  const timeoutMs =
    Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : positive(cfg.maxSeconds, 900) * 1000
  const pollMs = Math.max(20, positive(cfg.pollIntervalSeconds, 2) * 1000)
  const fastSettleMs = Math.max(0, Number(cfg.fastSettleSeconds) * 1000 || 0)
  const quietMs = Math.max(0, positive(cfg.quietWindowSeconds, 45) * 1000)

  const readSteps =
    typeof o.readSteps === 'function'
      ? o.readSteps
      : async () => {
          const read = await readTranscript(conversationId, {
            server,
            preferFull: cfg.useFullTranscript !== false,
            rpc: o.rpc,
            signal,
          })
          return read.steps
        }

  /**
   * Read the turn preferring the Language Server's own copy.
   *
   * WHY THIS EXISTS
   * ---------------
   * The brain log on disk is flushed asynchronously, so it lags the server:
   * measured, a conversation whose cascade was IDLE with
   * `terminationReason=ERROR` still had only the USER_INPUT step on disk, while
   * the RPC reported the ERROR_MESSAGE. Reading only the file therefore made a
   * dead turn look alive until the deadline expired (200s of dead time, and a
   * CLEAN audit for a turn that had failed).
   *
   * The RPC copy is never truncated, so preferring it is strictly better here.
   * The on-disk transcript stays the primary source for the final report because
   * it carries the complete historical turn; this path only feeds the settlement
   * decision and the incremental audit.
   */
  const readStepsFresh = async () => {
    const steps = await readSteps()
    if (server === undefined || server === null) return steps
    try {
      const viaRpc = await readTranscriptViaRpc(server, conversationId, {
        rpc: o.rpc,
        signal,
        timeoutMs: 15_000,
      })
      if (viaRpc.steps.length <= steps.length) return steps
      // Merge: keep the file's step_index ordering, extend with the RPC's newer
      // steps. The RPC view is authoritative for content; the file supplies any
      // historical step the RPC slice happens to omit.
      const byIndex = new Map(steps.map((step) => [step.step_index, step]))
      for (const step of viaRpc.steps) byIndex.set(step.step_index, step)
      return [...byIndex.values()].sort((a, b) => a.step_index - b.step_index)
    } catch {
      return steps
    }
  }

  const started = now()
  const deadline = started + timeoutMs
  const remaining = () => Math.max(0, deadline - now())

  /** 'rpc-idle' until the long poll proves unusable, then 'quiet-window'. */
  let mode = 'rpc-idle'
  let degradeNote
  let lastSeenIndex = sinceIndex - 1
  let lastSignature = ''
  let lastChangeAt = started
  let latest = { answer: undefined, answerStep: undefined, trace: [], steps: [] }
  /**
   * Last executor error text seen in this turn, if any.
   *
   * The trajectory's `terminationReason` only says "ERROR"; the actionable part
   * ("User location is not supported for the API use", a stream interruption, …)
   * lives in the ERROR_MESSAGE step. Surfacing it turns an opaque timeout into
   * something the caller can act on.
   */
  let lastErrorText
  let terminationReason
  let idleWithoutAnswer = 0
  /** In-flight long poll handle (see `startLongPoll`), reused across ticks. */
  let pollHandle

  /**
   * Emit newly seen steps and run the incremental audit hook.
   * @returns {Promise<{kill?: {step?: object, reason: string}, fresh: boolean}>}
   */
  async function scan(steps) {
    let fresh = false
    let kill
    for (const step of steps) {
      const idx = Number(step?.step_index ?? -1)
      if (!Number.isFinite(idx) || idx < sinceIndex || idx <= lastSeenIndex) continue
      lastSeenIndex = idx
      fresh = true
      onEvent?.({ kind: 'step', step })
      for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
        onEvent?.({
          kind: 'progress',
          text: `[step ${idx}] ${call?.name ?? 'tool'}: ${summarizeToolCall(call)}`.trimEnd(),
        })
      }
      if (onStep !== undefined) {
        const verdict = onStep(step) ?? {}
        if (verdict.block === true) {
          kill = { step, reason: String(verdict.reason ?? '审计判定为越界，已中止委派。') }
          break
        }
      }
    }
    return { kill, fresh }
  }

  /** Cancel the cascade; failures are never fatal (the turn may already be over). */
  async function cancelQuietly() {
    try {
      await rpc.cancelCascadeInvocation(server, conversationId, { timeoutMs: 10_000 })
    } catch {
      // Non-fatal: the result is reported as killed either way.
    }
  }

  /** Terminal result for kill/timeout, preserving everything collected so far. */
  function terminal(settlement, extra = {}) {
    return {
      answer: latest.answer,
      trace: latest.trace,
      steps: latest.steps,
      settlement,
      elapsedMs: now() - started,
      terminationReason,
      ...(degradeNote === undefined ? {} : { note: degradeNote }),
      ...extra,
    }
  }

  /** Read the transcript and refresh answer/trace/signature for this turn. */
  async function refresh() {
    // `fresh` merges the RPC view over the on-disk log, so a turn the server has
    // already finished is visible even while the brain file is still behind.
    const steps = await readStepsFresh()
    const turnSteps = steps.filter((step) => {
      const idx = Number(step?.step_index ?? -1)
      return Number.isFinite(idx) && idx >= sinceIndex
    })
    const collected = collectTurn(turnSteps, sinceIndex)
    latest = { ...collected, steps: turnSteps }
    // Keep the most recent executor error for the failure report.
    for (const step of turnSteps) {
      if (step?.type === 'ERROR_MESSAGE' && typeof step.content === 'string' && step.content !== '') {
        lastErrorText = step.content
      }
    }
    const signature = `${steps.length}:${steps.at(-1)?.step_index ?? -1}`
    const changed = signature !== lastSignature
    if (changed) {
      lastSignature = signature
      lastChangeAt = now()
    }
    return { steps, changed }
  }

  /**
   * Run the clock-driven REQ-04 hook for this poll iteration.
   *
   * WHY IT TAKES THE STEPS OF THE RE-READ THAT JUST HAPPENED
   * -------------------------------------------------------
   * `steps` may be `latest.steps` (the current-turn view `refresh()` just built
   * and the final report uses) or the raw array from a re-read that took place
   * earlier in the same iteration. Either way it is filtered down to `>=
   * sinceIndex` here rather than deriving a second, subtly different view: the
   * caller must see exactly the steps the report will show, or the 60s cut and
   * the report it accompanies would disagree about what the turn contained.
   *
   * ORDERING
   * --------
   * Always called after `scan()`, never before: the auditor's state machine
   * advances on newly discovered steps first, so a tick that both sees a new
   * step and trips the clock reports the same kill it would have reported from
   * `onStep`. Read the critical hooks-first ordering as "edges before clock".
   *
   * ROBUSTNESS
   * ----------
   * Advisory by contract, so every failure mode degrades to "no kill":
   * `onTick` is synchronous (a returned promise is dropped, never awaited — an
   * awaited tick would add a full extra round trip to the poll cadence and let
   * the caller stall the settlement loop), and a throwing hook is swallowed so
   * a buggy caller rule cannot turn a healthy turn into an error result.
   *
   * @param {object[]|undefined} steps steps of the current poll iteration
   * @returns {{kill?: {step?: object, reason: string}}}
   */
  function tick(steps) {
    if (onTick === undefined) return {}
    const source = Array.isArray(steps) ? steps : latest.steps
    const turnSteps = Array.isArray(source)
      ? source.filter((step) => {
          const idx = Number(step?.step_index ?? -1)
          return Number.isFinite(idx) && idx >= sinceIndex
        })
      : []
    let verdict
    try {
      verdict = onTick({ steps: turnSteps, elapsedMs: now() - started })
    } catch {
      // Advisory hook: a caller-side bug must never break the turn.
      return {}
    }
    // `Promise` is not awaited on purpose (see above); `thenable` covers the
    // rest. `typeof` first keeps `then`-named getters from ever being invoked.
    if (
      verdict !== null &&
      (typeof verdict === 'object' || typeof verdict === 'function') &&
      typeof verdict.then === 'function'
    ) {
      return {}
    }
    if (verdict?.block !== true) return {}
    return {
      kill: {
        // The tick has no offending step of its own (a hang is the *absence* of
        // steps), so nothing is attached: `renderKilledStep` must not invent
        // one. The caller's reason already names the step.
        reason: String(verdict.reason ?? '每拍检查判定为越界，已中止委派。'),
      },
    }
  }

  while (remaining() > 0) {
    // --- REQ-04: abort / block checks happen before any waiting ---------------
    if (signal?.aborted === true) {
      await cancelQuietly()
      return terminal('timeout', {
        killed: { reason: '委派已被取消（signal aborted）。' },
      })
    }

    try {
      const { steps, changed } = await refresh()
      const { kill, fresh } = await scan(steps)
      if (kill !== undefined) {
        await cancelQuietly()
        return terminal('timeout', { killed: kill })
      }

      if (mode === 'rpc-idle') {
        // --- step 1: long poll in the background, scan on the normal cadence -
        //
        // WHY NOT AWAIT THE POLL DIRECTLY
        // ------------------------------
        // `WaitForConversationFullyIdle` blocks until the turn ends — which is
        // exactly why it makes settlement fast, and exactly why awaiting it
        // would freeze the REQ-04 hooks: no step would ever reach `onStep`
        // before the turn was already over, so the kill switch could never fire
        // mid-flight (measured: a 240s turn ran to completion with zero
        // incremental audit verdicts, and a blocking finding was never seen).
        //
        // So the poll is started once and kept in `pollHandle`; this loop keeps
        // reading the transcript on the normal poll cadence and running the
        // hooks. When the poll resolves, the flag makes the next tick settle.
        // The poll is reused across ticks rather than restarted, because it
        // covers the whole turn and restarting it would only lose progress.
        if (pollHandle === undefined) {
          pollHandle = startLongPoll(rpc, server, conversationId, {
            signal,
            timeoutMs: Math.max(1, remaining()),
          })
        }

        // Give the poll one cadence tick to resolve. A resolved poll ends the
        // turn; an unresolved one just means "keep scanning".
        await Promise.race([pollHandle.done, realDelay(Math.min(pollMs, remaining()))])
        // Let the background promise's `.then` chain actually run before deciding.
        if (pollHandle.settled !== true) await flush()

        if (signal?.aborted === true) {
          pollHandle.abort()
          await cancelQuietly()
          return terminal('timeout', {
            killed: { reason: '委派已被取消（signal aborted）。' },
          })
        }

        // Every cadence tick: re-read and run the REQ-04 hooks.
        const tickRead = await refresh()
        const scanned = await scan(tickRead.steps)
        if (scanned.kill !== undefined) {
          pollHandle.abort()
          await cancelQuietly()
          return terminal('timeout', { killed: scanned.kill })
        }
        // A re-read already happened in this iteration, so the clock hook reuses
        // it rather than refreshing a second time.
        const ticked = tick(tickRead.steps)
        if (ticked.kill !== undefined) {
          pollHandle.abort()
          await cancelQuietly()
          return terminal('timeout', { killed: ticked.kill })
        }

        if (pollHandle.settled !== true) {
          // Still running: the hooks above already had their chance this tick.
          if (remaining() <= 0) break
          continue
        }

        // The poll finished: surface its outcome and settle below.
        const pollResult = pollHandle.result
        pollHandle = undefined

        if (pollResult.ok !== true) {
          const error = pollResult.error
          if (isAbort(error, signal)) {
            await cancelQuietly()
            return terminal('timeout', {
              killed: { reason: '委派已被取消（长轮询中断）。' },
            })
          }
          if (shouldDegrade(error) !== true) {
            // The long poll is usable but this attempt ended early (a transport
            // timeout, i.e. the turn is simply longer than the poll budget).
            // Stay in rpc-idle mode and poll again rather than giving up the
            // fast path for the rest of the turn.
            continue
          }
          // --- step 5: long poll unusable -> quiet window for the whole turn --
          mode = 'quiet-window'
          degradeNote =
            `WaitForConversationFullyIdle 不可用（${error?.message ?? 'unknown'}），` +
            '已降级为静默窗口判定。'
          continue
        }

        // --- step 2: confirm IDLE + terminationReason ------------------------
        const state = await readCascadeState(rpc, server, conversationId, {
          signal,
          timeoutMs: Math.max(1, Math.min(remaining(), 15_000)),
        })
        terminationReason = state.terminationReason ?? terminationReason
        if (state.idle !== true) {
          // Still running, or unconfirmed: the turn is not over. Normally the
          // long poll blocked for the whole turn, so reaching here means it
          // returned early (a race, or a server that answers immediately) —
          // pace the retry instead of hammering the language server.
          await sleep(Math.max(1, Math.min(pollMs, remaining())))
          continue
        }

        // --- step 3: a final, tool-call-free planner message must exist ------
        const { steps: confirmedSteps } = await refresh()
        const confirmed = await scan(confirmedSteps)
        if (confirmed.kill !== undefined) {
          await cancelQuietly()
          return terminal('timeout', { killed: confirmed.kill })
        }
        if (latest.answer === undefined) {
          // Idle with no answer. Two very different situations look identical
          // here, and conflating them is what made a dead turn spin until the
          // deadline (measured: a FAILED_PRECONDITION error sat IDLE for 200s
          // and returned "timeout" with zero diagnostics):
          //
          //   - a tool round just ended and the agent is about to speak again;
          //   - the executor died (ERROR / HALTED_STEP / MAX_*). No further
          //     message is ever coming, so waiting is pure dead time.
          //
          // Only the second case is terminal, and it must be reported as the
          // failure it is rather than as a timeout.
          if (TERMINAL_REASONS.has(terminationReason) === true && terminationReason !== 'NO_TOOL_CALL') {
            onEvent?.({ kind: 'idle', trace: latest.trace })
            return terminal('rpc-idle', {
              error:
                `Antigravity 提前结束了本回合（${terminationReason}），没有给出最终答复。` +
                (lastErrorText === undefined ? '' : `\n错误信息：${lastErrorText}`),
            })
          }

          // A tool round ended but the agent will speak again. Loop back to the
          // long poll — but never busy-spin if the cascade really is idle and
          // silent (e.g. a cancelled turn).
          idleWithoutAnswer += 1
          if (idleWithoutAnswer >= 3 && confirmed.fresh !== true) {
            await sleep(Math.max(1, Math.min(pollMs, remaining())))
          }
          continue
        }

        // --- step 4: fast settle window; new steps mean "not done yet" -------
        if (fastSettleMs > 0) await sleep(Math.min(fastSettleMs, Math.max(1, remaining())))
        if (signal?.aborted === true) {
          await cancelQuietly()
          return terminal('timeout', {
            killed: { reason: '委派已被取消（确认窗口期间）。' },
          })
        }
        const { steps: settledSteps } = await refresh()
        const settled = await scan(settledSteps)
        if (settled.kill !== undefined) {
          await cancelQuietly()
          return terminal('timeout', { killed: settled.kill })
        }
        if (settled.fresh === true) {
          // New work appeared: the apparent ending was only a gap. Start over.
          idleWithoutAnswer = 0
          continue
        }

        onEvent?.({ kind: 'idle', trace: latest.trace })
        return {
          answer: latest.answer,
          trace: latest.trace,
          steps: latest.steps,
          settlement: 'rpc-idle',
          elapsedMs: now() - started,
          terminationReason,
          ...(degradeNote === undefined ? {} : { note: degradeNote }),
        }
      }

      // --- quiet-window fallback ---------------------------------------------
      //
      // The clock hook runs BEFORE the silence test, not after it: a turn that
      // silently hangs holds a final planner answer, so the silence branch would
      // settle it as a healthy `quiet-window` turn before the hang was ever
      // considered. Checking the clock first keeps this degraded path — the only
      // one available when the long poll is unusable — subject to the same cut.
      const quietTick = tick(latest.steps)
      if (quietTick.kill !== undefined) {
        await cancelQuietly()
        return terminal('timeout', { killed: quietTick.kill })
      }
      if (now() - lastChangeAt >= quietMs && latest.answer !== undefined) {
        // Best-effort cross-check: a provably running cascade means the silence
        // is a tool gap, not an ending (background commands look like this).
        const state = await readCascadeState(rpc, server, conversationId, {
          signal,
          timeoutMs: Math.max(1, Math.min(remaining(), 15_000)),
        })
        terminationReason = state.terminationReason ?? terminationReason
        if (state.idle === false) {
          lastChangeAt = now()
        } else {
          onEvent?.({ kind: 'idle', trace: latest.trace })
          return {
            answer: latest.answer,
            trace: latest.trace,
            steps: latest.steps,
            settlement: 'quiet-window',
            elapsedMs: now() - started,
            terminationReason,
            ...(degradeNote === undefined ? {} : { note: degradeNote }),
          }
        }
      }

      await sleep(Math.max(1, Math.min(pollMs, remaining())))
    } catch (error) {
      // Unexpected failure (transcript read, injected rpc): report it, never hang.
      return terminal('timeout', {
        error: `等待 Antigravity 回复时出错：${error?.message ?? String(error)}`,
      })
    }
  }

  // Deadline hit: report what we have plus a reason the caller can surface.
  //
  // The final scan matters: steps that arrived after the last loop tick would
  // otherwise never reach `onStep`, so a timeout could return a CLEAN audit for
  // a turn that actually escaped. Scanning here keeps the streaming verdict and
  // the final report consistent even on the failure path.
  try {
    const final = await refresh()
    const scanned = await scan(final.steps)
    if (scanned.kill !== undefined) {
      await cancelQuietly()
      return terminal('timeout', { killed: scanned.kill })
    }
    // The hook gets the deadline tick too, so a rule that is evaluated on a
    // clock cannot miss the one iteration that matters most: the last re-read
    // before the loop gives up.
    const finalTick = tick(final.steps)
    if (finalTick.kill !== undefined) {
      await cancelQuietly()
      return terminal('timeout', { killed: finalTick.kill })
    }
  } catch {
    // A read failure on the way out must not hide the timeout itself.
  }
  return terminal('timeout', {
    error:
      `等待 Antigravity 回复超时（${Math.round(timeoutMs / 1000)}s，` +
      `已收到 ${latest.steps?.length ?? 0} 个步骤但没有最终答复）。` +
      '请确认 Antigravity 窗口未关闭、账号未掉线。' +
      (lastErrorText === undefined ? '' : `\n最后一条执行器错误：${lastErrorText}`),
  })
}
