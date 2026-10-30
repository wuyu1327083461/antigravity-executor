/**
 * Telemetry bus — the single decoupling seam between the executor and the UI.
 *
 * WHY A BUS INSTEAD OF CALLING THE SERVER DIRECTLY
 * -----------------------------------------------
 * `index.js` already knows how to run a turn; it must not also know how to
 * speak HTTP. Every place that has something worth showing publishes a named
 * event here and moves on. `ui-server.mjs` is the only subscriber that turns
 * those events into SSE frames, so:
 *
 *   - with no browser connected the bus still works and the snapshot is still
 *     current, but nothing is serialized (REQ-04 "zero overhead with no
 *     client");
 *   - a second consumer (a log dump, a test) can subscribe without touching
 *     the executor;
 *   - `index.js` stays testable: a unit test asserts events, not sockets.
 *
 * STATE, NOT JUST EVENTS
 * ----------------------
 * An SSE client that connects mid-turn needs the present, not a replay. So the
 * bus keeps a bounded in-memory SNAPSHOT of everything the dashboard renders
 * (bridge, quota, lifecycle, the active turn and its steps, the recent-turn
 * ring buffer, sessions, artifacts, runtime config). Handlers mutate that
 * snapshot through small, intention-revealing methods, and `snapshot()` is what
 * `/api/state` and the `state:snapshot` event both serve.
 *
 * WHY THE RING BUFFER EXISTS
 * --------------------------
 * v0.6.0 settles a turn in seconds. A user who alt-tabs to the dashboard after
 * dispatching therefore arrives *after* the turn already finished — with only
 * live events they would see an empty stage and conclude the run vanished.
 * Keeping the last N settled turns means "open the page later" still shows what
 * happened (REQ-05 / §3.2-D).
 *
 * @module antigravity-executor/lib/telemetry
 */

/** Lifecycle phases the stepper renders (PRD §3.2-A). */
export const PHASES = Object.freeze(['idle', 'queued', 'pacing', 'running', 'settling'])

/** Ring-buffer default: the PRD's §3.2-D "recent 10 turns". */
export const DEFAULT_RECENT_TURNS = 10

/** How many steps one turn keeps in memory. A runaway loop must not grow forever. */
const MAX_STEPS_PER_TURN = 600

/** Default `hangingCommandTimeoutSeconds`, mirrored so the UI can read a limit. */
const DEFAULT_HANGING_TIMEOUT_SECONDS = 60

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Coerce to a finite number, else `undefined`. */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** First `n` characters, newline-collapsed, with an ellipsis when cut. */
function head(value, n = 600) {
  const text = String(value ?? '').replace(/\r/g, '')
  if (text.length <= n) return text
  return `${text.slice(0, n)}…`
}

/** Trim a string, or `undefined` when it is empty. */
function trimmed(value) {
  const text = String(value ?? '').trim()
  return text === '' ? undefined : text
}

/**
 * Normalise one audited step into the wire shape the dashboard renders.
 *
 * Kept pure and exported so `index.js` (which builds the verdict) and the
 * tests agree on one representation. `summary` is deliberately truncated: a
 * `run_command` step can carry a multi-kilobyte PowerShell prelude, and the
 * timeline row shows one ellipsised line. The full text is dropped, not
 * silently kept in memory, because nothing else reads it.
 *
 * @param {object} step transcript / trajectory step
 * @param {object} [verdict] auditor verdict for this step
 * @returns {object}
 */
export function normalizeStep(step, verdict = {}) {
  const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : []
  const first = calls[0] ?? {}
  const toolName = String(first?.name ?? step?.type ?? 'step')
  const summary =
    trimmed(first?.arguments?.command) ??
    trimmed(first?.arguments?.TargetFile) ??
    trimmed(first?.arguments?.AbsolutePath) ??
    trimmed(first?.arguments?.path) ??
    trimmed(first?.arguments?.query) ??
    trimmed(first?.content) ??
    trimmed(step?.content) ??
    toolName

  const status = verdict?.status
  return {
    stepIndex: num(step?.step_index) ?? 0,
    type: String(step?.type ?? 'unknown'),
    toolName,
    summary: head(summary, 400),
    virtualCwd: trimmed(verdict?.virtualCwd) ?? null,
    isOutsideWorkspace: verdict?.isOutsideWorkspace === true,
    verdict: {
      status:
        status === 'warn_hanging' || status === 'escape' || status === 'destructive'
          ? status
          : 'clean',
      ...(trimmed(verdict?.kind) === undefined ? {} : { kind: String(verdict.kind) }),
      ...(num(verdict?.elapsedMs) === undefined ? {} : { elapsedMs: num(verdict.elapsedMs) }),
    },
    timestamp: num(verdict?.timestamp) ?? Date.now(),
  }
}

// ---------------------------------------------------------------------------
// the bus
// ---------------------------------------------------------------------------

/**
 * Create one telemetry bus.
 *
 * @param {object} [options]
 * @param {number} [options.recentTurnsLimit] ring-buffer depth (PRD default 10)
 * @param {() => number} [options.now] injectable clock (tests)
 * @param {() => number} [options.nextId] turn-id generator (tests)
 */
export function createTelemetryBus({
  recentTurnsLimit = DEFAULT_RECENT_TURNS,
  now = () => Date.now(),
  nextId,
} = {}) {
  const limit = Math.max(1, Math.trunc(Number(recentTurnsLimit) || DEFAULT_RECENT_TURNS))

  /** Subscribers: one callback per attached sink (the SSE server is one). */
  const listeners = new Set()

  let counter = 0
  const makeTurnId = typeof nextId === 'function' ? nextId : () => `turn-${++counter}`

  // --- the snapshot ------------------------------------------------------
  const bridge = {
    online: false,
    pid: null,
    port: null,
    plan: null,
    email: null,
    error: null,
    checkedAt: null,
  }
  const quota = {
    buckets: [],
    bucketsByFamily: { fiveHour: null, weekly: null },
    activeFallback: false,
    cachedAt: null,
    error: null,
  }
  const lifecycle = {
    phase: 'idle',
    queueLength: 0,
    pacingRemainingMs: null,
    runningTurnId: null,
    elapsedMs: null,
  }
  /** The turn currently executing (or settling), or null. */
  let activeTurn = null
  /** Settled turns, newest first. */
  const recentTurns = []
  let sessions = []
  let artifacts = []
  let runtimeConfig = {}
  /** Which workspace the preview endpoint is allowed to serve (REQ-04 guard). */
  let activeWorkspaceDir = null

  // --- emission ----------------------------------------------------------

  /**
   * Publish one event to every subscriber.
   *
   * A throwing subscriber must never break the executor, so each call is
   * isolated. With no subscribers this is one `Set.size` read — the REQ-04
   * "zero overhead with no client" path.
   */
  function emit(type, data) {
    if (listeners.size === 0) return
    for (const listener of listeners) {
      try {
        listener(type, data)
      } catch {
        // A broken consumer is not a broken turn.
      }
    }
  }

  /** Subscribe to every event; returns the unsubscribe function. */
  function subscribe(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** Current subscriber count (the SSE server reports this). */
  function subscriberCount() {
    return listeners.size
  }

  /**
   * The full snapshot `/api/state` and `state:snapshot` serve.
   *
   * Deep-copied on the way out so a consumer cannot mutate live state by
   * accident, and so two SSE clients cannot observe each other's edits.
   */
  function snapshot() {
    return JSON.parse(
      JSON.stringify({
        bridge,
        quota,
        lifecycle,
        activeTurn,
        recentTurns,
        sessions,
        artifacts,
        runtimeConfig,
        workspaceDir: activeWorkspaceDir,
        generatedAt: now(),
      }),
    )
  }

  // --- bridge / quota ----------------------------------------------------

  /**
   * Record a bridge probe result.
   *
   * @param {{online: boolean, pid?: number, port?: number, plan?: string,
   *          email?: string, error?: string}} status
   */
  function setBridge(status = {}) {
    bridge.online = status.online === true
    bridge.pid = num(status.pid) ?? null
    bridge.port = num(status.port) ?? null
    bridge.plan = trimmed(status.plan) ?? null
    bridge.email = trimmed(status.email) ?? null
    bridge.error = trimmed(status.error) ?? null
    bridge.checkedAt = now()
    emit('bridge:status', { ...bridge })
    return bridge
  }

  /**
   * Record one quota read.
   *
   * `bucketsByFamily` is computed here rather than in the page: the
   * "which bucket is the 5h window" rule already exists in `quota.js`
   * (`pickBillingBuckets`), and duplicating that judgement in browser code is
   * how the two drift apart.
   *
   * @param {object} read result of `readQuota`
   * @param {{bucketsByFamily?: object, activeFallback?: boolean}} [extra]
   */
  function setQuota(read, { bucketsByFamily, activeFallback } = {}) {
    quota.buckets = Array.isArray(read?.buckets) ? read.buckets : []
    quota.bucketsByFamily = {
      fiveHour: bucketsByFamily?.fiveHour ?? null,
      weekly: bucketsByFamily?.weekly ?? null,
    }
    quota.activeFallback = activeFallback === true
    quota.cachedAt = num(read?.readAt) ?? now()
    quota.error = trimmed(read?.error) ?? null
    emit('quota:updated', { ...quota })
    return quota
  }

  /** Mark the low-quota downgrade badge on/off without re-reading quota. */
  function setActiveFallback(active) {
    const next = active === true
    if (quota.activeFallback === next) return quota
    quota.activeFallback = next
    emit('quota:updated', { ...quota })
    return quota
  }

  // --- lifecycle ---------------------------------------------------------

  /**
   * Move the lifecycle stepper.
   *
   * @param {'idle'|'queued'|'pacing'|'running'|'settling'} phase
   * @param {object} [extra] `pacingRemainingMs`, `queueLength`, `elapsedMs`
   */
  function setPhase(phase, extra = {}) {
    const next = PHASES.includes(phase) ? phase : 'idle'
    lifecycle.phase = next
    if (num(extra.queueLength) !== undefined) lifecycle.queueLength = num(extra.queueLength)
    if (extra.pacingRemainingMs === null) lifecycle.pacingRemainingMs = null
    else if (num(extra.pacingRemainingMs) !== undefined) {
      lifecycle.pacingRemainingMs = num(extra.pacingRemainingMs)
    }
    if (num(extra.elapsedMs) !== undefined) lifecycle.elapsedMs = num(extra.elapsedMs)
    if (next === 'idle') {
      lifecycle.runningTurnId = null
      lifecycle.elapsedMs = null
      lifecycle.pacingRemainingMs = null
    }
    emit('lifecycle:change', { ...lifecycle })
    return lifecycle
  }

  /** Set the waiting-delegation count without changing the phase. */
  function setQueueLength(length) {
    const next = Math.max(0, Math.trunc(Number(length) || 0))
    if (lifecycle.queueLength === next) return
    lifecycle.queueLength = next
    emit('lifecycle:change', { ...lifecycle })
  }

  // --- turns -------------------------------------------------------------

  /**
   * Adopt a newly started turn as the active one.
   *
   * @param {object} info `{sessionId, conversationId, workspaceDir, effectiveMode,
   *   requestedTier, effectiveTier, downgradedReason, taskSpecHead, turnCount, turnLimit}`
   * @returns {object} the active-turn record (with its generated `turnId`)
   */
  function startTurn(info = {}) {
    const turn = {
      turnId: String(info.turnId ?? makeTurnId()),
      sessionId: trimmed(info.sessionId) ?? '?',
      conversationId: trimmed(info.conversationId) ?? null,
      workspaceDir: trimmed(info.workspaceDir) ?? null,
      effectiveMode: trimmed(info.effectiveMode) ?? 'surgical',
      requestedTier: trimmed(info.requestedTier) ?? null,
      effectiveTier: trimmed(info.effectiveTier) ?? null,
      ...(trimmed(info.downgradedReason) === undefined
        ? {}
        : { downgradedReason: String(info.downgradedReason) }),
      taskSpecHead: head(info.taskSpecHead ?? '', 300),
      startedAt: now(),
      virtualCwd: null,
      cwdEscaped: false,
      steps: [],
      ...(num(info.turnCount) === undefined ? {} : { turnCount: num(info.turnCount) }),
      ...(num(info.turnLimit) === undefined ? {} : { turnLimit: num(info.turnLimit) }),
    }
    activeTurn = turn
    lifecycle.runningTurnId = turn.turnId
    lifecycle.phase = 'running'
    lifecycle.elapsedMs = 0
    if (turn.workspaceDir !== null) activeWorkspaceDir = turn.workspaceDir
    emit('turn:started', JSON.parse(JSON.stringify(turn)))
    emit('lifecycle:change', { ...lifecycle })
    return turn
  }

  /**
   * Append one audited step to the active turn.
   *
   * Late steps for a turn that already settled are dropped: the transcript can
   * flush a step after settlement (v0.4.5 measured it), and resurrecting a
   * finished turn in the UI would show a permanent "running" badge.
   *
   * @param {string} turnId
   * @param {object} step already normalised by {@link normalizeStep}
   */
  function pushStep(turnId, step) {
    if (activeTurn === null || activeTurn.turnId !== String(turnId)) return false
    if (activeTurn.steps.length >= MAX_STEPS_PER_TURN) return false
    activeTurn.steps.push(step)
    if (step?.virtualCwd !== null && step?.virtualCwd !== undefined) {
      activeTurn.virtualCwd = step.virtualCwd
      activeTurn.cwdEscaped = step.isOutsideWorkspace === true
    } else if (step?.isOutsideWorkspace === true) {
      activeTurn.cwdEscaped = true
    }
    emit('turn:step', { turnId: activeTurn.turnId, step })
    return true
  }

  /**
   * Record a kill-switch / manual abort on the active turn.
   *
   * @param {string} turnId
   * @param {{trigger?: string, reason?: string, cancelLatencyMs?: number,
   *          stepIndex?: number}} [info]
   */
  function abortTurn(turnId, info = {}) {
    if (activeTurn === null || activeTurn.turnId !== String(turnId)) return false
    const trigger = ['manual', 'auto_destructive', 'auto_escape', 'auto_hanging'].includes(
      info.trigger,
    )
      ? info.trigger
      : 'manual'
    activeTurn.aborted = {
      trigger,
      reason: head(info.reason ?? '人工紧急熔断', 400),
      cancelLatencyMs: num(info.cancelLatencyMs) ?? 0,
    }
    lifecycle.phase = 'settling'
    emit('turn:aborted', {
      turnId: activeTurn.turnId,
      trigger,
      reason: activeTurn.aborted.reason,
      cancelLatencyMs: activeTurn.aborted.cancelLatencyMs,
      ...(num(info.stepIndex) === undefined ? {} : { stepIndex: num(info.stepIndex) }),
    })
    emit('lifecycle:change', { ...lifecycle })
    return true
  }

  /**
   * Settle the active turn into the ring buffer.
   *
   * @param {string} turnId
   * @param {{status?: string, finalReportHead?: string, gitSummary?: string|null,
   *          artifacts?: any[], sessionRecreated?: boolean, turnCount?: number,
   *          durationMs?: number}} [result]
   * @returns {object|null} the settled record, or null when it was not active
   */
  function settleTurn(turnId, result = {}) {
    if (activeTurn === null || activeTurn.turnId !== String(turnId)) return null
    const settledAt = now()
    const record = {
      ...activeTurn,
      settledAt,
      durationMs: num(result.durationMs) ?? Math.max(0, settledAt - Number(activeTurn.startedAt)),
      status: ['ok', 'failed', 'aborted', 'timeout'].includes(result.status)
        ? result.status
        : 'ok',
      finalReportHead: head(result.finalReportHead ?? '', 4000),
      gitSummary: trimmed(result.gitSummary) ?? null,
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
      sessionRecreated: result.sessionRecreated === true,
      turnCount: num(result.turnCount) ?? activeTurn.turnCount ?? 0,
    }
    recentTurns.unshift(record)
    if (recentTurns.length > limit) recentTurns.length = limit
    activeTurn = null
    lifecycle.phase = 'idle'
    lifecycle.runningTurnId = null
    lifecycle.elapsedMs = null
    lifecycle.pacingRemainingMs = null
    emit('turn:settled', {
      turnId: record.turnId,
      durationMs: record.durationMs,
      status: record.status,
      finalReportHead: record.finalReportHead,
      gitSummary: record.gitSummary,
      artifacts: record.artifacts,
      sessionRecreated: record.sessionRecreated,
      turnCount: record.turnCount,
    })
    emit('lifecycle:change', { ...lifecycle })
    return record
  }

  // --- sessions / artifacts / config -------------------------------------

  /**
   * Replace the session list.
   *
   * @param {Array<object>} rows records in the shape `sessions.list()` returns,
   *   already projected to the wire shape by the caller
   */
  function setSessions(rows) {
    sessions = Array.isArray(rows) ? rows : []
    emit('sessions:updated', { sessions })
  }

  /** Replace the artifact list. */
  function setArtifacts(rows) {
    artifacts = Array.isArray(rows) ? rows : []
    emit('artifacts:updated', { artifacts })
  }

  /**
   * Record the effective runtime config.
   *
   * `pacingEnabled` is flattened from the nested `pacing.enabled` block because
   * the toggle switch is one control; everything else is passed through.
   */
  function setRuntimeConfig(config = {}) {
    runtimeConfig = {
      thinkingLevel: config.thinkingLevel ?? 'medium',
      allowOverride: config.allowOverride !== false,
      taskMode: config.taskMode ?? 'auto',
      failOnEscape: config.failOnEscape === true,
      realtimeKillSwitch: config.realtimeKillSwitch !== false,
      allowOutsideWorkspace: config.allowOutsideWorkspace === true,
      pacingEnabled: config?.pacing?.enabled !== false,
      audit: config.audit !== false,
      hangingCommandTimeoutSeconds:
        num(config.hangingCommandTimeoutSeconds) ?? DEFAULT_HANGING_TIMEOUT_SECONDS,
      longSessionTurns: num(config.longSessionTurns) ?? 8,
      quotaFallback: {
        enabled: config?.quotaFallback?.enabled !== false,
        proMinFraction: num(config?.quotaFallback?.proMinFraction) ?? 0.05,
        weeklyProMinFraction: num(config?.quotaFallback?.weeklyProMinFraction) ?? 0.15,
        weeklyReserveHours: num(config?.quotaFallback?.weeklyReserveHours) ?? 24,
      },
    }
    emit('config:updated', { runtimeConfig })
    return runtimeConfig
  }

  /** The directory the preview endpoint may serve (REQ-04 path-traversal guard). */
  function setWorkspaceDir(dir) {
    activeWorkspaceDir = trimmed(dir) ?? null
  }

  /** Read-only read of the current active workspace, for the preview route. */
  function workspaceDir() {
    return activeWorkspaceDir
  }

  /** The active turn, for the control routes (`abort`, `skip-pacing`). */
  function activeTurnId() {
    return activeTurn?.turnId ?? null
  }

  /** Drop every piece of turn state (used when the plugin unloads). */
  function reset() {
    activeTurn = null
    recentTurns.length = 0
    lifecycle.phase = 'idle'
    lifecycle.queueLength = 0
    lifecycle.pacingRemainingMs = null
    lifecycle.runningTurnId = null
    lifecycle.elapsedMs = null
    listeners.clear()
  }

  return {
    // emission
    emit,
    subscribe,
    subscriberCount,
    snapshot,
    // bridge / quota
    setBridge,
    setQuota,
    setActiveFallback,
    // lifecycle
    setPhase,
    setQueueLength,
    // turns
    startTurn,
    pushStep,
    abortTurn,
    settleTurn,
    // collections
    setSessions,
    setArtifacts,
    setRuntimeConfig,
    setWorkspaceDir,
    workspaceDir,
    activeTurnId,
    // teardown
    reset,
  }
}
