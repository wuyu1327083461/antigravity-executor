/**
 * Retry & complexity auto-escalation: spend `pro` only where `flash` already lost.
 *
 * WHY THIS EXISTS (v0.8.0 / REQ-01)
 * ---------------------------------
 * The plugin ships with `thinkingLevel: medium`, and `medium` runs on agentapi's
 * `flash` tier. That default is not an accident: most delegations are first-pass
 * edits, flash handles them at a fraction of pro's burn rate, and every turn that
 * does not need pro should not pay for it.
 *
 * The failure mode that default creates is a retry loop. `flash` returns a
 * plausible but incomplete fix, the planner sees the test still failing, and
 * re-dispatches — SAME `session_id`, same hard problem, same cheap tier, now
 * prefixed with "修复". Nothing about the second request is easier than the
 * first; the only new information is that we already know flash was not enough.
 * That is exactly the moment to buy pro: one expensive turn instead of a burn
 * loop, and it breaks the loop before it eats the 5h window.
 *
 * Two independent triggers produce the same answer:
 *
 *   A. retry       the plan says this is a rework of a session that already ran
 *                  (`turn_count >= 1`) AND either the last turn settled badly or
 *                  the task text is rework/error phrasing.
 *   B. complexity  `creative` mode: high-density generation work (3D scenes,
 *                  visual polish) where a skeletal first draft is the known
 *                  failure mode of a cheap tier, on the very first turn.
 *
 * WHY THIS MODULE DOES NOT READ QUOTA
 * -----------------------------------
 * It answers one question only: "would a bigger budget help this turn?". The
 * caller (`index.js`) hands that answer to `applyQuotaFallback`, which is free to
 * hand the tier straight back to `flash` when the pool is nearly empty
 * (CONTRACT §7.4 rule 5). Keeping the two decisions with two owners is what makes
 * both testable alone — and what stops a nearly-empty account from silently
 * losing either the escalation or the weekly-budget guard.
 *
 * ZERO DEPENDENCIES
 * -----------------
 * CONTRACT §7.1 makes every v0.8.0 module a pure module: `node:*` built-ins only,
 * no sibling `lib/` file. This module needs no imports at all, so its test runs
 * on its own file and a refactor of `config-schema.js` can never change an
 * escalation decision at load time.
 *
 * @module antigravity-executor/lib/escalation
 */

/**
 * The retry/rework phrasing detector (verbatim, CONTRACT §7.4).
 *
 * English markers are word-bounded so `prefix` does not read as `fix`; the
 * Chinese markers are matched bare because CJK characters are non-word in JS and
 * a `\b` next to them never fires. There is deliberately no `g` flag: a stateful
 * `lastIndex` would make the SAME spec match on one call and miss on the next.
 */
export const RETRY_SIGNAL_RE =
  /\b(fix|failing|failed|error|broken|regression|retry|still\s+not)\b|报错|失败|未通过|没改对|返工|修复/i

/**
 * Level -> tier table, mirroring `THINKING_TIERS` in `config-schema.js`.
 *
 * DUPLICATED ON PURPOSE: this module must stay importable on its own (CONTRACT
 * §7.1), so it cannot pull the table from `config-schema.js`. The tests pin both
 * the keys and the tier names the contract prints verbatim.
 */
const LEVELS = Object.freeze({
  minimal: 'flash_lite',
  low: 'flash_lite',
  medium: 'flash',
  high: 'pro',
  extra_high: 'pro',
})

/**
 * Tier strength, cheapest first.
 *
 * "Only ever move up" is measured in TIERS, not in level names, and that
 * distinction is load-bearing. `high` and `extra_high` are two spellings of the
 * SAME `pro` tier, so "high configured, extra_high target" buys nothing and must
 * not report `escalated: pro -> pro`. That also matches the requirement's
 * precondition — escalation only applies while the configured level is below
 * `high` (§2.1: 当…默认档位低于 high 时). Once a profile already runs on pro,
 * a bigger prompt-level budget is a different feature, not this module's.
 */
const TIER_RANK = Object.freeze({ flash_lite: 0, flash: 1, pro: 2 })

/** What an absent or unreadable `thinkingLevel` means (mirrors config-schema). */
const DEFAULT_LEVEL = 'medium'

/** Escalation target when `config.retryEscalationLevel` is absent or invalid. */
const DEFAULT_ESCALATION_LEVEL = 'high'

/** Only two targets are meaningful; both run on `pro` (see §7.2). */
const ESCALATION_LEVELS = ['high', 'extra_high']

/**
 * Is this round a rework round? (CONTRACT §7.4 trigger A.)
 *
 * A rework round needs BOTH halves: evidence that this session already ran, and
 * a reason to believe the next attempt at the same tier would just fail again.
 * Either half alone is noise — a first turn on a bug report is a normal task, and
 * a second turn on a brand-new feature is normal iteration.
 *
 * `reusedSession` is the caller's own verdict when it has one; otherwise
 * `turnCount >= 1` stands in for it, so a caller that only has the persisted
 * record can pass that and nothing else. An explicit `reusedSession: false`
 * always wins, because the caller is closer to the truth than the counter.
 *
 * @param {object} [options]
 * @param {unknown} [options.taskSpec] the natural-language task, either language
 * @param {unknown} [options.lastTurnFailed] did the previous turn settle badly?
 * @param {unknown} [options.turnCount] turns already spent on this session
 * @param {unknown} [options.reusedSession] caller's own reuse verdict
 * @returns {boolean} never throws
 */
export function detectRetrySignal(options = {}) {
  try {
    const { taskSpec, lastTurnFailed, turnCount, reusedSession } = options ?? {}
    if (reusedSession === false) return false

    const turns = toCount(turnCount)
    const reused = reusedSession === true || (turns !== undefined && turns >= 1)
    if (!reused) return false

    // A failed settlement is the strongest possible signal: we do not have to
    // guess from the wording, the previous round told us.
    if (lastTurnFailed === true) return true
    return matchesRetrySignal(taskSpec)
  } catch {
    // A hostile input (throwing getter, exotic `taskSpec`) must never fail a
    // delegation: an unreadable signal simply means "no escalation".
    return false
  }
}

/**
 * Should this turn run one notch higher than configured?
 *
 * Precedence, in order (CONTRACT §7.4 rules 1-5):
 *
 *   1. an explicit `thinking_level` from the caller wins outright — a human or
 *      the planner deliberately picked that tier, so we never overrule it;
 *   2. `config.autoEscalateOnRetry === false` switches the whole behaviour off
 *      (absent means ON, so a v0.7.0 profile keeps working);
 *   3. a target at or below the current level is not an escalation (only ever
 *      move up — `high` configured against the default `high` target is a no-op);
 *   4. rework signal (retry) or `creative` mode (complexity) selects the reason;
 *   5. quota is not consulted here at all — `applyQuotaFallback` runs afterwards
 *      and may still put the tier back.
 *
 * When both triggers fire, `retry` wins: "the last attempt failed" is the more
 * actionable sentence in a report, and it is the one the acceptance criterion
 * asks for (§7.9-1).
 *
 * @param {object} [options]
 * @param {unknown} [options.explicitLevel] caller-supplied `thinking_level`
 * @param {unknown} [options.configuredLevel] the level this turn would use
 * @param {unknown} [options.effectiveMode] `surgical` | `creative`
 * @param {unknown} [options.session] persisted session record (see below)
 * @param {unknown} [options.taskSpec] the natural-language task
 * @param {unknown} [options.config] plugin config (`autoEscalateOnRetry`,
 *   `retryEscalationLevel`)
 * @returns {{escalate: boolean, from?: string, to?: string,
 *            reason?: 'retry'|'complexity', detail?: string}}
 *   `{escalate:false}` — and nothing else — when the turn must not move up.
 */
export function shouldEscalate(options = {}) {
  try {
    const { explicitLevel, configuredLevel, effectiveMode, session, taskSpec, config } =
      options ?? {}

    // --- rule 1: explicit caller choice is never second-guessed -------------
    if (isExplicitLevel(explicitLevel)) return noEscalation()

    // --- §7.2 kill switch; only a literal `false` disables it ---------------
    if (readConfig(config, 'autoEscalateOnRetry') === false) return noEscalation()

    const currentLevel = normaliseLevel(configuredLevel) ?? DEFAULT_LEVEL
    const targetLevel = normaliseTargetLevel(readConfig(config, 'retryEscalationLevel'))
    const from = LEVELS[currentLevel]
    const to = LEVELS[targetLevel]

    // --- rule 4: only ever move up ------------------------------------------
    // Compared by tier: `high` -> `extra_high` is the same `pro` tier, so it is
    // not an escalation and must never render `escalated: pro -> pro`.
    if (TIER_RANK[from] >= TIER_RANK[to]) return noEscalation()

    // --- rules 2/3: is there a reason to escalate at all? -------------------
    const signal = classifySignal({ effectiveMode, session, taskSpec })
    if (signal === undefined) return noEscalation()

    return {
      escalate: true,
      from,
      to,
      reason: signal.reason,
      detail: signal.detail(to),
    }
  } catch {
    // Escalation is an optimisation, never a precondition: any unreadable input
    // degrades to "run exactly as configured".
    return noEscalation()
  }
}

/**
 * Render the decision as one report line / UI status-bar string.
 *
 * The shape is a product requirement (CONTRACT §7.4, §7.9-1) and is asserted
 * verbatim by the tests:
 *
 *   escalated: flash -> pro (retry escalation)
 *   escalated: flash -> pro (complexity escalation)
 *
 * An unknown `reason` falls back to the contract's own `retry/complexity` label
 * rather than emitting an empty pair of parentheses.
 *
 * @param {unknown} decision value returned by {@link shouldEscalate}
 * @returns {string|undefined} the line, or `undefined` when nothing escalated
 */
export function renderEscalation(decision) {
  try {
    if (decision === null || typeof decision !== 'object') return undefined
    if (decision.escalate !== true) return undefined

    const from = toTier(decision.from)
    const to = toTier(decision.to)
    // Without both endpoints the line would be a lie or a puzzle; say nothing.
    if (from === undefined || to === undefined) return undefined

    return `escalated: ${from} -> ${to} (${reasonLabel(decision.reason)} escalation)`
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// signal classification
// ---------------------------------------------------------------------------

/**
 * Pick the trigger that applies, if any.
 *
 * @param {{effectiveMode: unknown, session: unknown, taskSpec: unknown}} input
 * @returns {{reason: 'retry'|'complexity', detail: (to: string) => string}|undefined}
 */
function classifySignal({ effectiveMode, session, taskSpec }) {
  const turnCount = toCount(readSession(session, 'turn_count') ?? readSession(session, 'turnCount'))
  const reusedSession =
    readSession(session, 'reusedSession') === true ||
    (turnCount !== undefined && turnCount >= 1)
  const lastTurnFailed = readSession(session, 'lastTurnFailed') === true

  if (detectRetrySignal({ taskSpec, lastTurnFailed, turnCount, reusedSession })) {
    const round = turnCount === undefined ? '≥1' : String(turnCount)
    return {
      reason: 'retry',
      detail: (to) =>
        lastTurnFailed
          ? `上一轮结算异常（中断 / 验收命令非零退出 / 无文件变更告警），本轮按返工处理，请求档位升到 ${to}（仍受配额守卫约束）`
          : `任务描述命中返工/报错关键词，且这是同一会话的第 ${round} 轮以上，请求档位升到 ${to}（仍受配额守卫约束）`,
    }
  }

  if (normaliseMode(effectiveMode) === 'creative') {
    return {
      reason: 'complexity',
      detail: (to) =>
        `creative 高密度生成模式需要更强模型才能出稿，请求档位升到 ${to}（仍受配额守卫约束）`,
    }
  }

  return undefined
}

/** True when `taskSpec` is a non-empty string mentioning a rework signal. */
function matchesRetrySignal(taskSpec) {
  if (typeof taskSpec !== 'string' || taskSpec.length === 0) return false
  return RETRY_SIGNAL_RE.test(taskSpec)
}

// ---------------------------------------------------------------------------
// small normalisers (every one of them is total: no throws, no surprises)
// ---------------------------------------------------------------------------

/** The "nothing to do" answer. Fresh object: callers may keep or mutate it. */
function noEscalation() {
  return { escalate: false }
}

/**
 * Is `thinking_level` present?
 *
 * Absent means `undefined`/`null`/`''` — the three spellings callers use for "I
 * did not pass this". Anything else, including an unknown spelling, counts as
 * explicit: rule 1 is about *who* decided, not about whether the value parses.
 */
function isExplicitLevel(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

/** Lower-case a level name and keep it only if it is one we know. */
function normaliseLevel(value) {
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? key : undefined
}

/** The escalation target, defaulting to `high` for absent/unknown values. */
function normaliseTargetLevel(value) {
  const key = normaliseLevel(value)
  if (key !== undefined && ESCALATION_LEVELS.includes(key)) return key
  return DEFAULT_ESCALATION_LEVEL
}

/** `creative` / `Creative ` / `surgical` -> the spacing/case-free word. */
function normaliseMode(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined
}

/**
 * Resolve any level or tier spelling to an agentapi tier name.
 *
 * Used by {@link renderEscalation}, which must also survive a hand-written
 * decision: a level name is accepted as a courtesy, an unknown string is not.
 */
function toTier(value) {
  const level = normaliseLevel(value)
  if (level !== undefined) return LEVELS[level]
  if (typeof value !== 'string') return undefined
  const tier = value.trim().toLowerCase()
  if (tier === 'flash_lite' || tier === 'flash' || tier === 'pro') return tier
  return undefined
}

/** The parenthetical word in the rendered line. */
function reasonLabel(reason) {
  if (reason === 'retry' || reason === 'complexity') return reason
  return 'retry/complexity'
}

/** Read one field of the session record; `undefined` for a missing record. */
function readSession(session, field) {
  if (session === null || typeof session !== 'object') return undefined
  return session[field]
}

/** Read one config key; a missing or non-object config reads as `undefined`. */
function readConfig(config, key) {
  if (config === null || typeof config !== 'object') return undefined
  return config[key]
}

/** Turn counts arrive from RPC payloads and are often stringified. */
function toCount(value) {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}
