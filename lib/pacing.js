/**
 * Human-like pacing between delegations (v0.5.0 / anti-automation-signal).
 *
 * WHY THIS EXISTS
 * ---------------
 * 0.4.0 dropped the per-turn cost from ~45s to ~8.4s. That is a real win for
 * the last step of a turn, but it also means back-to-back delegations can now
 * fire 1-2 seconds apart. A planner that rejects a diff and immediately
 * re-dispatches — or fans out several sub-tasks — produces a *minute-straight*
 * stream of perfectly-spaced requests, which is the shape of a bot rather than
 * a person, and the account behind this plugin is a real signed-in Google
 * account that must not be lost to automated-abuse heuristics.
 *
 * The fix is deliberately small and honest:
 *   - A single turn still settles as fast as it can. Pacing never delays the
 *     answer the planner is waiting for.
 *   - The delay is applied to the *start* of the next delegation, only when the
 *     previous one finished moments ago, and its length is drawn from a range
 *     so consecutive gaps are not metronome-regular.
 *
 * This is a mitigation, not a guarantee: it cannot make automation look organic,
 * it only removes the most obvious "zero-think-time" signature.
 *
 * @module antigravity-executor/lib/pacing
 */

/** Default floor: gaps shorter than this look machine-driven. */
export const DEFAULT_MIN_GAP_SECONDS = 15
/** Default jitter range, in seconds, applied when the floor is not met. */
export const DEFAULT_JITTER_MIN_SECONDS = 6
export const DEFAULT_JITTER_MAX_SECONDS = 15

/**
 * A pacer holding the timestamp of the last finished turn.
 *
 * State is in-memory on purpose: this models one conversation's rhythm, and a
 * dsh restart obviously begins a new session where the previous gap is
 * unknowable. Nothing here is written to disk.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]     injectable clock (tests)
 * @param {() => number} [options.random]  injectable RNG in [0, 1) (tests)
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable sleep (tests)
 */
export function createPacer({ now = () => Date.now(), random = Math.random, sleep } = {}) {
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms))

  /** Wall-clock time of the last delegation that finished, or undefined. */
  let lastTurnFinishedAt

  /**
   * Compute the delay owed before the next delegation starts.
   *
   * Pure with respect to the pacer's state, so it can be asserted directly.
   *
   * @param {object} cfg plugin config (`pacing.*`)
   * @returns {{delayMs: number, reason?: string, sinceLastMs?: number}}
   *   `delayMs` is 0 when pacing is disabled, the gap is already long enough,
   *   or this is the first delegation.
   */
  function plan(cfg) {
    const settings = cfg?.pacing ?? {}
    if (settings.enabled !== true) return { delayMs: 0 }

    if (lastTurnFinishedAt === undefined) return { delayMs: 0 }

    const sinceLastMs = Math.max(0, Number(now()) - Number(lastTurnFinishedAt))
    const floorMs = positiveSeconds(settings.minGapSeconds, DEFAULT_MIN_GAP_SECONDS) * 1000
    if (sinceLastMs >= floorMs) return { delayMs: 0, sinceLastMs }

    const lowMs = positiveSeconds(settings.jitterMinSeconds, DEFAULT_JITTER_MIN_SECONDS) * 1000
    const highMs = Math.max(
      lowMs,
      positiveSeconds(settings.jitterMaxSeconds, DEFAULT_JITTER_MAX_SECONDS) * 1000,
    )
    // The jitter is added on top of the remaining floor so the *total* gap is at
    // least `minGapSeconds`: without this the pacing could still leave a 6s gap.
    const remainingFloorMs = Math.max(0, floorMs - sinceLastMs)
    const jitterMs = Math.round(lowMs + random() * (highMs - lowMs))
    return {
      delayMs: Math.max(0, remainingFloorMs + jitterMs),
      sinceLastMs,
      reason: `上一轮结束仅 ${(sinceLastMs / 1000).toFixed(1)}s，补足拟人冷却`,
    }
  }

  /**
   * Wait out whatever {@link createPacer.plan} says is owed.
   *
   * @param {object} cfg plugin config
   * @returns {Promise<{waitedMs: number, reason?: string}>}
   */
  async function waitForTurnStart(cfg) {
    const decision = plan(cfg)
    if (!(decision.delayMs > 0)) return { waitedMs: 0 }
    try {
      await wait(decision.delayMs)
    } catch {
      // A cancelled sleep must not block the delegation: the caller's own
      // signal handling decides what happens next.
      return { waitedMs: 0, reason: decision.reason }
    }
    return { waitedMs: decision.delayMs, reason: decision.reason }
  }

  /** Record that a turn just finished; call this in a `finally` block. */
  function noteTurnFinished() {
    lastTurnFinishedAt = now()
  }

  /** Current state, for `check_environment` and tests. */
  function status() {
    return { lastTurnFinishedAt }
  }

  /** Test/ops hook: forget the last turn (e.g. after a blocked delegation). */
  function reset() {
    lastTurnFinishedAt = undefined
  }

  return { plan, waitForTurnStart, noteTurnFinished, status, reset }
}

/** Coerce to a positive seconds value, else the fallback. */
function positiveSeconds(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Render the pacing decision as one `check_environment` line.
 *
 * @param {object} cfg plugin config
 * @param {{lastTurnFinishedAt?: number}} [state]
 * @param {number} [now]
 */
export function renderPacing(cfg, state = {}, now = Date.now()) {
  const settings = cfg?.pacing ?? {}
  if (settings.enabled !== true) return 'pacing       : off (delegations start immediately)'

  const floor = positiveSeconds(settings.minGapSeconds, DEFAULT_MIN_GAP_SECONDS)
  const low = positiveSeconds(settings.jitterMinSeconds, DEFAULT_JITTER_MIN_SECONDS)
  const high = Math.max(low, positiveSeconds(settings.jitterMaxSeconds, DEFAULT_JITTER_MAX_SECONDS))
  const range = low === high ? `${low}s` : `${low}-${high}s`
  const last = Number(state?.lastTurnFinishedAt)
  const tail = Number.isFinite(last)
    ? `, last turn ended ${((Math.max(0, now - last)) / 1000).toFixed(1)}s ago`
    : ', no turn yet'
  return `pacing       : min gap ${floor}s + jitter ${range} between turns${tail}`
}
