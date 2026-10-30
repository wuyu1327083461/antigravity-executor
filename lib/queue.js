/**
 * In-process serial mutex around the whole delegation (v0.6.0 / REQ-02).
 *
 * WHY THIS EXISTS
 * ---------------
 * A host model can emit several `delegate_coding_task` calls in one reply
 * (Parallel Tool Calls). Two of those delegations are not a throughput win, they
 * are two bugs:
 *
 *   1. Both read the same "last turn finished at" timestamp within the same
 *      millisecond, so neither one sees a gap and both skip the inter-turn
 *      pacing delay entirely. The anti-automation signature comes straight
 *      back, with none of the code looking wrong.
 *   2. Both create an Antigravity conversation against the same workspace.
 *      Antigravity edits files through tools, not transactions, so concurrent
 *      writes clobber each other and two workers racing for `.git/index.lock`
 *      turn a delegation into a confusing git failure.
 *
 * The fix is one FIFO lock for the whole process. The granularity is
 * deliberately global rather than per-`workspace_dir`: the pacing state that
 * parallel calls defeat is global too, so keying the lock by workspace would
 * still let two different directories fire in the same millisecond. The cost —
 * a second delegation waits instead of running in parallel — is exactly the
 * behaviour the plugin wants anyway.
 *
 * A rejected body must never poison the queue: the rejection is carried only by
 * that body's own returned promise, the next waiter arms itself on an already
 * settled link, and the caller-side bookkeeping happens in a `finally`. One
 * failing delegation followed by a working one is the normal repair flow, so it
 * has to be safe by construction.
 *
 * @module antigravity-executor/lib/queue
 */

/**
 * Create the serial queue.
 *
 * Implemented as a promise-chain link rather than an array plus a worker loop: a
 * link has no "is a body running?" branch to get wrong, starts the next body the
 * instant the previous one settles (no polling, no timers), and books the
 * counters in a `finally` that also runs on rejection.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] injectable clock (tests)
 * @returns {{run: (fn: () => Promise<any>) => Promise<any>,
 *            status: () => {running: boolean, queued: number, completed: number,
 *                            currentStartedAt?: number, lastFinishedAt?: number},
 *            reset: () => void}}
 */
export function createSerialQueue({ now = () => Date.now() } = {}) {
  /** The last body's completion. New bodies chain onto this. */
  let tail = Promise.resolve()
  let running = false
  let queued = 0
  let completed = 0
  let currentStartedAt
  let lastFinishedAt

  /**
   * Queue one body and resolve with its result.
   *
   * The argument check happens before the chain is touched, so a bad call
   * cannot leave a broken link or a stale counter behind. It throws
   * synchronously, matching the usual `run(fn)` contract in Node.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>} resolves/rejects with this body only
   */
  function run(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError(`createSerialQueue().run(fn) 需要一个函数，收到 ${describe(fn)}`)
    }

    queued += 1
    // Settle onto a link that is *always fulfilled*: the previous body may have
    // rejected, and an unhandled rejection on an intermediate link is a
    // process-level warning even when the caller correctly awaited its own run().
    const previous = tail.then(
      () => undefined,
      () => undefined,
    )

    // The returned promise deliberately carries this body's rejection: that is
    // how the error reaches the caller of *this* run() and nobody else. The next
    // run() absorbs it again through `previous`, so the chain never breaks.
    const current = previous.then(async () => {
      queued -= 1
      running = true
      currentStartedAt = now()
      try {
        return await fn()
      } finally {
        running = false
        completed += 1
        lastFinishedAt = now()
      }
    })

    tail = current
    return current
  }

  /**
   * Snapshot of the queue, for `check_environment` and tests.
   *
   * A body starts on the microtask after `run()`, so a snapshot taken in the
   * same synchronous frame still counts it as waiting (`running: false`). Every
   * caller here samples between tool calls, never mid-frame, so this is
   * documented rather than papered over with a synchronous first start.
   */
  function status() {
    return { running, queued, completed, currentStartedAt, lastFinishedAt }
  }

  /**
   * Test/ops hook: forget all counters and the in-flight chain.
   *
   * Only safe while idle — this is dropped state, not a cancellation: a body
   * already executing keeps running, it just is no longer visible here.
   */
  function reset() {
    tail = Promise.resolve()
    running = false
    queued = 0
    completed = 0
    currentStartedAt = undefined
    lastFinishedAt = undefined
  }

  return { run, status, reset }
}

/**
 * Render the queue as one `check_environment` line.
 *
 * @param {{running?: boolean, queued?: number, completed?: number,
 *          currentStartedAt?: number, lastFinishedAt?: number}} [state]
 * @param {number} [now] clock for the "running N s" tail (tests inject it)
 * @returns {string}
 */
export function renderQueue(state, now = Date.now()) {
  const s = state ?? {}
  const waiting = nonNegative(s.queued)
  const settled = nonNegative(s.completed)
  const counts = `${waiting} waiting, ${settled} settled`

  if (s.running !== true) return `queue        : idle (${counts})`

  const started = Number(s.currentStartedAt)
  const elapsed = Number.isFinite(started)
    ? `, running ${((Math.max(0, now - started)) / 1000).toFixed(1)}s`
    : ''
  return `queue        : busy (${counts}${elapsed})`
}

/** Counter coercion: a missing/garbage count renders as 0, never `NaN`. */
function nonNegative(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Type label for the `TypeError` message; never throws. */
function describe(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value
}
