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
 * WHAT v0.8.0 ADDS, AND WHY IT IS ALL ADDITIVE
 * --------------------------------------------
 * The v0.8.0 dashboard has to explain *why* a turn cost what it cost and let the
 * user undo it, so three new kinds of state join the snapshot:
 *
 *   - `quota.burn` — how much of the bucket this turn drank. A quota gauge that
 *     only shows the level answers "how much is left", never "what did that
 *     just cost me", which is the question a user watching a burn rate is
 *     actually asking (REQ-02 / UI-REQ-03).
 *   - `recentTurns[].{commands, changedFiles, snapshotSha, burnedFraction,
 *     rolledBack, escalation}` — the terminal tab, the changed-file list, the
 *     rollback button and the escalation badge (REQ-01/02/03, UI-REQ-01/02/03).
 *   - `sessions[].{rolledOverAt, turnCount, rolloverBrief}` after a long-session
 *     rollover (REQ-04).
 *
 * The compatibility rule for all of it is the same and is not negotiable: **no
 * existing field and no existing event name may change or disappear.** The
 * dashboard, `ui-server.mjs` and the shipped tests all read this shape, so a
 * rename would fail silently in a browser rather than loudly in CI. Every new
 * field is therefore written only when a caller actually supplies it, via
 * conditional spread — a v0.7.0 caller produces a byte-identical snapshot.
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
 * Like {@link num}, but additionally treats `null` as "present but unknown".
 *
 * `Number(null)` is `0`, so a plain `num()` would silently turn "the command
 * exited with an unknown status" into "the command exited 0" — the exact lie the
 * v0.8.0 fake-success guard exists to prevent (CONTRACT §7.3: *never guess 0*).
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Is `value` a non-array object (the only shape we ever spread onto the wire)? */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Project one `run_command` record onto the terminal-tab wire shape (§7.3).
 *
 * The exit code is the whole point of this projection: the dashboard renders
 * "Exit 0 / Exit 1" and the report's fake-success warning keys off it, so a
 * missing code must stay `null` and never become `0`. `outputTail` is already
 * capped at 20 lines / 1500 chars by `commands.js`; the `head()` here is a
 * belt-and-braces bound in case a caller hands us a raw, untruncated blob.
 *
 * @param {object} entry `{command, cwd, exitCode, outputTail, failed}`
 * @returns {object|undefined} `undefined` when the entry is unusable
 */
function normalizeCommand(entry) {
  if (!isPlainObject(entry)) return undefined
  const command = trimmed(entry.command)
  if (command === undefined) return undefined
  const exitCode = finiteOrNull(entry.exitCode)
  return {
    command: head(command, 600),
    cwd: trimmed(entry.cwd) ?? null,
    exitCode,
    outputTail: head(entry.outputTail ?? '', 1500),
    // Trust an explicit flag; otherwise derive it from the exit code. A `null`
    // code is *not* a failure — it means "the trajectory did not say", and
    // marking it failed would turn every unknown into a red row.
    failed: entry.failed === true || (exitCode !== null && exitCode !== 0),
  }
}

/**
 * Project one changed-file record onto the wire shape the diff list renders.
 *
 * @param {object} entry `{path, added, removed}` (or a bare path string)
 * @returns {{path: string, added: number, removed: number}|undefined}
 */
function normalizeChangedFile(entry) {
  const path = trimmed(typeof entry === 'string' ? entry : entry?.path)
  if (path === undefined) return undefined
  return {
    path,
    added: finiteOrNull(entry?.added) ?? 0,
    removed: finiteOrNull(entry?.removed) ?? 0,
  }
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
 * WHY `command` IS OPTIONAL AND CONDITIONALLY SPREAD
 * --------------------------------------------------
 * `commands.js` extracts the real exit code, cwd and output tail from the RPC
 * trajectory; the dashboard's terminal tab must render those verbatim instead of
 * re-parsing the transcript in the browser (CONTRACT §7.7). But steps that are
 * not `run_command` have nothing to put there, and the v0.7.0 timeline reads
 * `verdict`/`summary` only. Emitting a `command: undefined` key would round-trip
 * through `JSON.stringify` as a dropped key anyway, yet it would still make the
 * in-process object shape differ per step — so the field is spread in only when
 * the auditor actually produced a usable record.
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
  const command = normalizeCommand(verdict?.command)
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
    ...(command === undefined ? {} : { command }),
  }
}

/**
 * Project an escalation decision onto the wire shape the badge renders (§7.4).
 *
 * `reason` is kept as the caller's short token (`retry` / `complexity`) rather
 * than being pre-rendered into English: `escalation.js` owns the sentence
 * (`renderEscalation`) and the page owns the locale, so baking either in here
 * would give the dashboard two sources of truth for the same line.
 *
 * @param {object} value `{from, to, reason}`
 * @returns {{from: string, to: string, reason: string|null}|undefined}
 */
function normalizeEscalation(value) {
  if (!isPlainObject(value)) return undefined
  const from = trimmed(value.from)
  const to = trimmed(value.to)
  if (from === undefined && to === undefined) return undefined
  return {
    from: from ?? null,
    to: to ?? null,
    reason: trimmed(value.reason) ?? null,
  }
}

/**
 * Project a rollover brief onto the wire shape the banner renders (§7.6).
 *
 * Only the file list is truncated (at 15, the same cap `session-brief.js`
 * enforces) — the count is kept as the caller reported it so the banner can say
 * "承自前 8 轮" even when the file list itself was trimmed.
 *
 * @param {object} value `{previousTurnCount, files}`
 * @returns {{previousTurnCount: number, files: string[]}|undefined}
 */
function normalizeRolloverBrief(value) {
  if (!isPlainObject(value)) return undefined
  const files = Array.isArray(value.files)
    ? value.files.map((file) => trimmed(file)).filter((file) => file !== undefined)
    : Array.isArray(value.cumulativeTouchedFiles)
      ? value.cumulativeTouchedFiles
          .map((file) => trimmed(file))
          .filter((file) => file !== undefined)
      : []
  return {
    previousTurnCount: num(value.previousTurnCount) ?? 0,
    files: files.slice(0, 15),
  }
}

/**
 * Project a per-turn burn onto the wire shape the turn card's badge renders.
 *
 * `fraction` is a POSITIVE magnitude ("this turn used 1.3% of the bucket"); the
 * page prefixes the minus sign, because a burn is a loss from the user's point
 * of view. Storing it positive keeps every threshold comparison in one
 * convention. `label` is pre-rendered by the caller when it has the bucket name,
 * so the page never re-derives "which window is this".
 *
 * @param {object} value `{fraction, label}`
 * @returns {{fraction: number, label: string|null}|undefined}
 */
function normalizeBurn(value) {
  if (!isPlainObject(value)) return undefined
  const fraction = finiteOrNull(value.fraction)
  if (fraction === null) return undefined
  return { fraction, label: trimmed(value.label) ?? null }
}

/**
 * Project the `summarizeCommands()` result (§7.3) onto the wire shape.
 *
 * `lastVerification` is the last verification-shaped command, which the terminal
 * tab highlights. `verificationFailed` is what makes the report's fake-success
 * warning legible in the UI, so it defaults to `false` rather than being
 * dropped: unlike the other new fields this one is a *boolean fact about a set
 * of commands that did exist*, and its absence would read as "healthy".
 *
 * @param {object} value `{total, failed, lastVerification, verificationFailed}`
 * @returns {object|undefined} `undefined` when there is nothing to say
 */
function normalizeCommandSummary(value) {
  if (!isPlainObject(value)) return undefined
  const total = finiteOrNull(value.total)
  const failed = finiteOrNull(value.failed)
  const lastVerification = normalizeCommand(value.lastVerification)
  if (total === null && failed === null && lastVerification === undefined) return undefined
  return {
    total: total ?? 0,
    failed: failed ?? 0,
    ...(lastVerification === undefined ? {} : { lastVerification }),
    verificationFailed: value.verificationFailed === true,
  }
}

/**
 * Project a changed-file list, dropping unusable entries.
 *
 * @param {any} value array of `{path, added, removed}` or bare path strings
 * @returns {Array<object>|undefined} `undefined` for an empty/absent list
 */
function normalizeChangedFileList(value) {
  if (!Array.isArray(value)) return undefined
  const files = value.map((entry) => normalizeChangedFile(entry)).filter((f) => f !== undefined)
  return files.length === 0 ? undefined : files
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
    /**
     * Last observed per-turn burn (v0.8.0 REQ-02). `null` — not `undefined`, and
     * not an absent key — because the snapshot is deep-copied through
     * `JSON.stringify`, which silently drops `undefined` properties. A missing
     * key and an explicit `null` mean the same thing to the page ("no burn
     * measured yet") but only `null` *survives* the round-trip, so the browser
     * can branch on it without a `'burn' in quota` dance.
     */
    burn: null,
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
   *
   * Note that this round-trip through JSON is also *why* new optional fields are
   * omitted rather than set to `undefined`: the copy would drop them anyway, and
   * keeping the in-memory shape faithful to the wire shape means a test that
   * inspects `snapshot()` sees exactly what the browser sees.
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

  /**
   * Record how much of the quota bucket the *last* turn burned (v0.8.0 REQ-02).
   *
   * WHY A SEPARATE SIGNAL FROM THE QUOTA READ
   * -----------------------------------------
   * `setQuota` answers "how full is the bucket right now". That is a level, and a
   * level cannot tell the user which turn emptied it — two consecutive reads an
   * hour apart look identical whether the time went into one expensive turn or
   * ten cheap ones. The War Room's turn card needs the *delta*, so the caller
   * measures the bucket before and after a turn and hands it here.
   *
   * `deltaFraction` is a POSITIVE magnitude — `0.013` means "this turn spent
   * 1.3% of the bucket", and the page renders it as `-1.3%` because from the
   * user's point of view a burn is a loss. Keeping the stored value positive
   * means every consumer (badge, threshold check, log line) compares against a
   * bound rather than remembering a sign convention.
   *
   * Burn is *not* part of `setQuota`: a quota read arrives on its own schedule
   * (and may fail), while a burn is known exactly once, when the turn settles.
   * Coupling them would either lose the burn on a failed read or invent one on a
   * read that never saw this turn.
   *
   * @param {{deltaFraction?: number, cumulativeFraction?: number,
   *          window?: 'fiveHour'|'weekly'|string}} [info]
   * @returns {object|null} the recorded burn, or null when there was nothing to record
   */
  function recordBurn({ deltaFraction, cumulativeFraction, window } = {}) {
    const delta = finiteOrNull(deltaFraction)
    const cumulative = finiteOrNull(cumulativeFraction)
    const label = trimmed(window)
    // A burn with no magnitude is noise, not data: a turn that consumed nothing
    // measurable must leave the previous reading intact rather than reset it to
    // zero, otherwise the badge would blank out on every cheap turn.
    if (delta === null && cumulative === null) return null
    quota.burn = {
      deltaFraction: delta ?? 0,
      cumulativeFraction: cumulative ?? (quota.burn?.cumulativeFraction ?? null),
      window: label ?? 'fiveHour',
      at: now(),
    }
    emit('quota:burn', { ...quota.burn })
    return quota.burn
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
   * WHY THE v0.8.0 FIELDS ARRIVE HERE RATHER THAN AT SETTLEMENT
   * -----------------------------------------------------------
   * A turn's identity is decided *before* the first tool call, and the War Room
   * is populated at that instant (v0.7.0 did the same for mode and tier). Three
   * v0.8.0 facts are part of that identity:
   *
   *   - `escalation: {from, to, reason}` — the badge that tells the user why
   *     this turn is running on pro instead of flash (REQ-01). Learning it only
   *     at settlement means staring at a mislabelled header for the whole turn.
   *   - `rolloverBrief: {previousTurnCount, files}` — the header banner of a
   *     first turn that inherited a rolled-over session (REQ-04).
   *   - `snapshotSha` — the pre-turn git object this turn can be rolled back to
   *     (REQ-03). It is captured before the turn starts, so it exists now; the
   *     rollback button must be able to appear as soon as there is something to
   *     roll back to.
   *
   * All three are optional and spread conditionally, so a v0.7.0 caller gets the
   * exact same turn record it always got.
   *
   * @param {object} info `{sessionId, conversationId, workspaceDir, effectiveMode,
   *   requestedTier, effectiveTier, downgradedReason, taskSpecHead, turnCount, turnLimit,
   *   escalation, rolloverBrief, snapshotSha}`
   * @returns {object} the active-turn record (with its generated `turnId`)
   */
  function startTurn(info = {}) {
    const escalation = normalizeEscalation(info.escalation)
    const rolloverBrief = normalizeRolloverBrief(info.rolloverBrief)
    const snapshotSha = trimmed(info.snapshotSha)
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
      ...(escalation === undefined ? {} : { escalation }),
      ...(rolloverBrief === undefined ? {} : { rolloverBrief }),
      ...(snapshotSha === undefined ? {} : { snapshotSha }),
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
   * WHY THE v0.8.0 RESULT FIELDS ARE CONDITIONAL
   * --------------------------------------------
   * The settled record is what the history tab re-renders hours later, and v0.8.0
   * adds five things to it: the command execution summary (`commands`), the
   * per-turn burn (`burn`), the changed-file list with diff stats
   * (`changedFiles`), every file the turn touched (`touchedFiles`), and the
   * rollback flag. Each is spread in only when the caller supplied it, because:
   *
   *   - a turn that ran no commands must not grow an empty `commands` block that
   *     makes the terminal tab render an empty shell;
   *   - `rolledBack: false` is the *default* and the rollback button only reads
   *     a truthy value, so writing it unconditionally would add a key to every
   *     v0.7.0-shaped record for no behaviour.
   *
   * The event payload stays a deliberate subset (as it always was): it is what
   * the page needs to move the turn from "active" to "history", not a full
   * replay of the record.
   *
   * @param {string} turnId
   * @param {{status?: string, finalReportHead?: string, gitSummary?: string|null,
   *          artifacts?: any[], sessionRecreated?: boolean, turnCount?: number,
   *          durationMs?: number, commands?: object, burn?: {fraction: number, label?: string},
   *          changedFiles?: Array<{path: string, added: number, removed: number}>,
   *          touchedFiles?: string[], rolledBack?: boolean}} [result]
   * @returns {object|null} the settled record, or null when it was not active
   */
  function settleTurn(turnId, result = {}) {
    if (activeTurn === null || activeTurn.turnId !== String(turnId)) return null
    const settledAt = now()
    const commands = normalizeCommandSummary(result.commands)
    const burn = normalizeBurn(result.burn)
    const changedFiles = normalizeChangedFileList(result.changedFiles)
    const touchedFiles = Array.isArray(result.touchedFiles)
      ? result.touchedFiles.map((file) => trimmed(file)).filter((file) => file !== undefined)
      : undefined
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
      ...(commands === undefined ? {} : { commands }),
      ...(burn === undefined ? {} : { burn }),
      ...(changedFiles === undefined ? {} : { changedFiles }),
      ...(touchedFiles === undefined || touchedFiles.length === 0 ? {} : { touchedFiles }),
      ...(result.rolledBack === true ? { rolledBack: true } : {}),
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
      // Additive v0.8.0 fields: present only when they have a value, so a
      // v0.7.0-shaped subscriber sees the exact frame it always saw.
      ...(record.commands === undefined ? {} : { commands: record.commands }),
      ...(record.burn === undefined ? {} : { burn: record.burn }),
      ...(record.changedFiles === undefined ? {} : { changedFiles: record.changedFiles }),
      ...(record.touchedFiles === undefined ? {} : { touchedFiles: record.touchedFiles }),
      ...(record.escalation === undefined ? {} : { escalation: record.escalation }),
      ...(record.snapshotSha === undefined ? {} : { snapshotSha: record.snapshotSha }),
    })
    emit('lifecycle:change', { ...lifecycle })
    return record
  }

  /**
   * Flag a settled turn as rolled back and publish the undo (v0.8.0 REQ-03).
   *
   * WHY THE RING BUFFER IS THE TARGET, NOT THE ACTIVE TURN
   * ------------------------------------------------------
   * A rollback happens *after* settlement, by definition: the user reads the
   * report, decides the turn was wrong, and clicks undo — the turn is already in
   * history and the history tab is where its card lives. So the flag is applied
   * to the ring-buffer record and the event carries what the card needs to
   * render the "已回滚" state without re-fetching the whole snapshot.
   *
   * The turn may also have been evicted from the ring buffer already (the user
   * waited; other turns settled). That is not an error worth throwing over — the
   * filesystem rollback itself already succeeded — so this returns `false` and
   * the caller can still show its own result.
   *
   * @param {string} turnId
   * @param {{restoredFiles?: string[], removedUntracked?: string[],
   *          skipped?: string[], error?: string}} [info]
   * @returns {boolean} whether a ring-buffer record was found and flagged
   */
  function markRolledBack(turnId, info = {}) {
    const id = trimmed(turnId)
    if (id === undefined) return false
    const record = recentTurns.find((turn) => turn.turnId === id)
    if (record === undefined) return false
    const restoredFiles = Array.isArray(info.restoredFiles)
      ? info.restoredFiles.map((file) => trimmed(file)).filter((file) => file !== undefined)
      : []
    const removedUntracked = Array.isArray(info.removedUntracked)
      ? info.removedUntracked.map((file) => trimmed(file)).filter((file) => file !== undefined)
      : []
    record.rolledBack = true
    record.rollback = {
      restoredFiles,
      removedUntracked,
      ...(Array.isArray(info.skipped) && info.skipped.length > 0
        ? { skipped: info.skipped.map((file) => trimmed(file)).filter((f) => f !== undefined) }
        : {}),
      ...(trimmed(info.error) === undefined ? {} : { error: trimmed(info.error) }),
      at: now(),
    }
    emit('turn:rolled-back', {
      turnId: record.turnId,
      restoredFiles,
      removedUntracked,
      ...(trimmed(info.error) === undefined ? {} : { error: trimmed(info.error) }),
    })
    return true
  }

  /**
   * Record a long-session rollover and republish the affected session row
   * (v0.8.0 REQ-04).
   *
   * WHY BOTH THE ROW AND AN EVENT
   * -----------------------------
   * The session list is a full replacement (`setSessions`), so the row has to be
   * patched in place here or the page would keep showing a session pointing at
   * the dead `conversation_id` until the next `publishCollectionState`. The
   * event exists for the toast/banner: a rollover is a visible, slightly
   * alarming thing (the thread the user was talking to is gone), and it must not
   * be discoverable only by diffing a list.
   *
   * Only three fields change on the row — the new conversation, the fresh turn
   * count, and the brief/`rolledOverAt` stamp — everything else (workspace, tier,
   * last touched files) still describes the same session and is left alone. A
   * `sessionId` that is not in the list is a no-op: the row may simply not have
   * been published yet, and inventing one here would fabricate a session.
   *
   * @param {string} sessionId
   * @param {{toConversationId?: string, brief?: object,
   *          workspaceDir?: string}} [info]
   * @returns {object|null} the updated row, or null when it was not found
   */
  function markRolledOver(sessionId, info = {}) {
    const id = trimmed(sessionId)
    if (id === undefined) return null
    const index = sessions.findIndex((row) => String(row?.sessionId ?? '') === id)
    if (index === -1) return null
    const brief = normalizeRolloverBrief(info.brief)
    const toConversationId = trimmed(info.toConversationId) ?? null
    const previousConversationId = sessions[index].conversationId ?? null
    const rolledOverAt = now()
    sessions[index] = {
      ...sessions[index],
      conversationId: toConversationId,
      // The whole point of a rollover: the new thread starts at turn 0, while
      // the brief carries forward what the old thread knew.
      turnCount: 0,
      longSession: false,
      ...(brief === undefined ? {} : { rolloverBrief: brief }),
      rolledOverAt,
      previousConversationId,
    }
    emit('session:rollover', {
      sessionId: id,
      toConversationId,
      previousConversationId,
      rolledOverAt,
      ...(brief === undefined ? {} : { brief }),
    })
    emit('sessions:updated', { sessions })
    return sessions[index]
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
    // The burn is a fact about the last turn's consumption; once the turns are
    // gone it describes nothing, and a badge left showing a stale `-1.3%` after
    // a plugin unload is worse than no badge.
    quota.burn = null
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
    recordBurn,
    // lifecycle
    setPhase,
    setQueueLength,
    // turns
    startTurn,
    pushStep,
    abortTurn,
    settleTurn,
    markRolledBack,
    markRolledOver,
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
