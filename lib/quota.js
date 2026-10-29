/**
 * Account quota reading, tier fallback, and rendering (REQ-03).
 *
 * WHY THE TIER CLASSIFICATION IS A SEPARATE PURE FUNCTION
 * ------------------------------------------------------
 * `agentapi --model=<flash_lite|flash|pro>` is the only reliable way to pick a
 * thinking tier, but `GetUserStatus` does **not** report a model called "pro".
 * Measured modelIds are `gemini-3.8-flash-high / -medium / -low`,
 * `claude-sonnet-4-6`, `gpt-oss-120b-medium`, with labels like
 * "Gemini 3.8 Flash (High)". So "which reported row corresponds to the `pro`
 * tier?" is a *judgement*, and a wrong judgement causes a wrong downgrade — the
 * exact failure mode this feature is supposed to prevent.
 *
 * The rule is therefore: classify by semantics, and when a row cannot be
 * classified, treat it as "quota sufficient" and do NOT downgrade. A parse
 * failure must never silently move a task off its requested tier.
 *
 * @module antigravity-executor/lib/quota
 */

import { DEFAULT_THINKING_LEVEL, THINKING_TIERS } from './config-schema.js'

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Coerce to a finite number in [0, 1]; undefined otherwise. */
function fractionOf(value) {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
  return n
}

/** A protobuf `Timestamp` may arrive as `{seconds, nanos}`; accept all three shapes. */
function parseResetAt(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds from the server are ~1.7e9; epoch ms are ~1.7e12.
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'object' && value.seconds !== undefined) {
    const s = Number(value.seconds)
    return Number.isFinite(s) ? s * 1000 : undefined
  }
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : undefined
}

/** `"Gemini Models"` -> `"gemini-models"`; used as the stable group id. */
function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// lazy RPC import
// ---------------------------------------------------------------------------

/**
 * `rpc.js` is owned by another module and may not exist yet while this module
 * is developed and tested. Loading it lazily keeps `import './quota.js'`
 * always valid, and lets tests inject a fake client via `opts.rpc` without any
 * network or module-resolution dependency.
 */
let rpcModulePromise

function loadRpcModule() {
  rpcModulePromise ??= import('./rpc.js')
  return rpcModulePromise
}

// ---------------------------------------------------------------------------
// normalisation of the two raw responses
// ---------------------------------------------------------------------------

/**
 * `GetUserStatus` -> `{ plan, email, tiers }`.
 * Accepts both the wrapped (`{userStatus: ...}`) and unwrapped shape.
 */
export function normalizeUserStatus(status) {
  const us = status?.userStatus ?? status ?? {}
  const plan = us?.planStatus?.planInfo?.planName
  const email = us?.email

  const configs = us?.cascadeModelConfigData?.clientModelConfigs
  const rows = Array.isArray(configs) ? configs : []

  const tiers = []
  for (const config of rows) {
    if (config === null || typeof config !== 'object') continue
    const modelId = config.modelId ?? config.modelOrAlias?.model ?? ''
    const id = String(modelId ?? '').trim()
    if (id === '') continue
    const label = String(config.label ?? id).trim()
    tiers.push({
      id,
      label,
      modelId: id,
      remainingFraction: fractionOf(config.quotaInfo?.remainingFraction),
      resetTime: config.quotaInfo?.resetTime,
    })
  }
  return { plan: plan === undefined ? undefined : String(plan), email: email, tiers }
}

/**
 * `RetrieveUserQuotaSummary` -> flat bucket list, each tagged with its group.
 * Accepts both the wrapped (`{response: ...}`) and unwrapped shape.
 */
export function normalizeQuotaSummary(summary) {
  const response = summary?.response ?? summary ?? {}
  const groups = Array.isArray(response?.groups) ? response.groups : []

  const buckets = []
  groups.forEach((group, index) => {
    if (group === null || typeof group !== 'object') return
    const groupName = String(group.displayName ?? group.name ?? `group-${index}`)
    const groupId = slug(group.displayName ?? group.name) || `group-${index}`
    const rows = Array.isArray(group.buckets) ? group.buckets : []
    for (const bucket of rows) {
      if (bucket === null || typeof bucket !== 'object') continue
      buckets.push({
        groupId,
        groupName,
        bucketId: String(bucket.bucketId ?? ''),
        window: String(bucket.window ?? ''),
        remainingFraction: fractionOf(bucket.remainingFraction),
        resetTime: bucket.resetTime,
        description: bucket.description ?? group.description,
      })
    }
  })
  return buckets
}

// ---------------------------------------------------------------------------
// bucket-level billing (v0.5.0 / REQ-03)
// ---------------------------------------------------------------------------

/**
 * Bucket families, matched against `bucketId` / `window` / `displayName`.
 *
 * WHY `pro` CANNOT BE MATCHED BY NAME
 * -----------------------------------
 * Measured on a Pro account, `RetrieveUserQuotaSummary` reports **no bucket
 * called "pro"**. What it reports is:
 *
 *     Gemini Models / gemini-5h      (5h)
 *     Gemini Models / gemini-weekly  (weekly)
 *
 * `pro` and `flash` share that single `Gemini Models` pool — `pro` merely burns
 * it far faster per task. So "is there pro budget left?" is really "is the
 * Gemini pool healthy?", and a fallback to `flash` is a *burn-rate* reduction,
 * not a move to a different bucket. Matching a bucket literally named `pro`
 * would find nothing on every real account and silently disable the guard.
 */
const BUCKET_WINDOW_PATTERNS = [
  { window: 'weekly', re: /weekly|week/i },
  { window: '5h', re: /\b5\s*h|5-hour|five[-\s]?hour/i },
]

/** Gemini family (the shared pro+flash pool), as opposed to the 3p pool. */
const GEMINI_BUCKET_RE = /gemini/i

/** 3rd-party family (Claude / GPT), never the pro fallback source. */
const THIRD_PARTY_BUCKET_RE = /3p|claude|gpt|third[-\s]?party/i

/**
 * Pick the Gemini billing buckets out of a quota read.
 *
 * @param {object} quota result of {@link readQuota}
 * @returns {{gemini: object[], weekly?: object, fiveHour?: object, thirdParty: object[]}}
 */
export function pickBillingBuckets(quota) {
  const buckets = Array.isArray(quota?.buckets) ? quota.buckets : []
  const gemini = []
  const thirdParty = []
  for (const bucket of buckets) {
    const text = `${bucket?.groupId ?? ''} ${bucket?.groupName ?? ''} ${bucket?.bucketId ?? ''} ${bucket?.description ?? ''}`
    if (THIRD_PARTY_BUCKET_RE.test(text)) {
      thirdParty.push(bucket)
      continue
    }
    if (GEMINI_BUCKET_RE.test(text)) gemini.push(bucket)
  }

  const weekly = gemini.find((b) => matchesWindow(b, 'weekly'))
  const fiveHour = gemini.find((b) => matchesWindow(b, '5h'))
  return {
    gemini,
    weekly,
    fiveHour,
    // Unclassifiable buckets fall back to "the whole Gemini pool" so a future
    // rename cannot silently disable the guard.
    thirdParty,
  }
}

/** Does one bucket belong to the given window family? */
function matchesWindow(bucket, window) {
  const family = BUCKET_WINDOW_PATTERNS.find((entry) => entry.window === window)
  if (family === undefined) return false
  const text = `${bucket?.bucketId ?? ''} ${bucket?.window ?? ''} ${bucket?.displayName ?? ''}`
  return family.re.test(text)
}

// ---------------------------------------------------------------------------
// readQuota
// ---------------------------------------------------------------------------

/**
 * Read both quota endpoints and merge them.
 *
 * Neither endpoint is fatal: a partial read is still useful, and a total read
 * failure returns an `error` instead of throwing, so the caller can decide.
 *
 * @param {object} server `{ port, csrf }`
 * @param {{timeoutMs?: number, rpc?: {getUserStatus: Function, retrieveQuotaSummary: Function}}} [opts]
 */
export async function readQuota(server, { timeoutMs = 8000, rpc, now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now()
  const readAt = clock()
  const result = { plan: undefined, email: undefined, tiers: [], buckets: [], readAt }
  const problems = []

  let api = rpc
  if (api === undefined) {
    try {
      api = await loadRpcModule()
    } catch (error) {
      result.error = `RPC 模块不可用：${error.message}`
      return result
    }
  }

  if (typeof api?.getUserStatus === 'function') {
    try {
      const status = await api.getUserStatus(server, { timeoutMs })
      const normalized = normalizeUserStatus(status)
      result.plan = normalized.plan
      result.email = normalized.email
      result.tiers = normalized.tiers
    } catch (error) {
      problems.push(`GetUserStatus 读取失败：${error.message}`)
    }
  } else {
    problems.push('GetUserStatus 不可用（rpc 客户端缺少该方法）')
  }

  if (typeof api?.retrieveQuotaSummary === 'function') {
    try {
      const summary = await api.retrieveQuotaSummary(server, { timeoutMs })
      result.buckets = normalizeQuotaSummary(summary)
    } catch (error) {
      problems.push(`RetrieveUserQuotaSummary 读取失败：${error.message}`)
    }
  } else {
    problems.push('RetrieveUserQuotaSummary 不可用（rpc 客户端缺少该方法）')
  }

  if (problems.length > 0) result.error = problems.join('；')
  return result
}

// ---------------------------------------------------------------------------
// quota caching (v0.5.0)
// ---------------------------------------------------------------------------

/**
 * Decide whether a previous quota read may be reused for a delegation's tier
 * decision, instead of hitting `GetUserStatus` + `RetrieveUserQuotaSummary`
 * again.
 *
 * WHY CACHE AT ALL
 * ----------------
 * With the 45s quiet window gone, a planner that rejects a diff can re-dispatch
 * within a second or two. Reading quota on every one of those produces a dense
 * burst of account calls that buys no information — the account's remaining
 * fraction does not move by a measurable amount in two seconds — and adds its
 * own automated-traffic signature.
 *
 * WHY NOT ALWAYS CACHE
 * --------------------
 * Near the threshold the cached value is exactly what is dangerous: if the
 * cached read says 6% and the live value has since fallen to 3%, reusing it
 * would keep sending `pro` tasks into a nearly-empty pool. So the cache is
 * abandoned once the value is close to the threshold, and a caller can force a
 * fresh read (`check_environment` always does).
 *
 * @param {object|undefined} cached previous {@link readQuota} result
 * @param {object} cfg plugin config
 * @param {{now?: number, force?: boolean}} [options]
 * @returns {{usable: boolean, reason?: string}}
 */
export function quotaCacheUsable(cached, cfg, { now = Date.now(), force = false } = {}) {
  if (force === true) return { usable: false, reason: 'forcing a fresh read' }
  if (cached === null || typeof cached !== 'object') return { usable: false, reason: 'no cached read' }
  if (cached.error !== undefined) return { usable: false, reason: 'the cached read was incomplete' }

  const settings = cfg?.quotaFallback ?? {}
  const ttlSeconds = Number(settings.cacheTtlSeconds)
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return { usable: false, reason: 'caching disabled' }

  const readAt = Number(cached.readAt)
  if (!Number.isFinite(readAt)) return { usable: false, reason: 'the cached read has no timestamp' }

  const ageMs = Math.max(0, now - readAt)
  if (ageMs > ttlSeconds * 1000) {
    return { usable: false, reason: `the cached read is ${Math.round(ageMs / 1000)}s old` }
  }

  // Near the guard threshold, a stale value can be wrong in the expensive
  // direction: 6% cached vs 3% live keeps sending pro tasks into a dry pool.
  const guard = Number(settings.proMinFraction)
  const warnBand = 0.05
  const grouped = classifyTiers(cached)
  const proFraction = minFraction(grouped.pro)
  if (Number.isFinite(guard) && proFraction !== undefined && proFraction < guard + warnBand) {
    return { usable: false, reason: 'pro 额度已逼近警戒线，强制刷新' }
  }

  return { usable: true, ageMs }
}

/**
 * Create a tiny memo for one quota read.
 *
 * Kept as a factory (rather than module state) so a test — or two dsh profiles
 * in one process — cannot leak a cached quota into each other.
 */
export function createQuotaCache() {
  let cached
  let lastReadAt

  return {
    /** The cached result, if any. */
    get() {
      return cached
    },
    /** Should the cached value be reused for this call? */
    usable(cfg, options) {
      return quotaCacheUsable(cached, cfg, options)
    },
    /**
     * Read quota, reusing the cache when it is safe.
     *
     * @param {object} server `{ port, csrf }`
     * @param {object} cfg plugin config
     * @param {{force?: boolean, timeoutMs?: number, rpc?: object, now?: number}} [options]
     * @returns {Promise<{quota: object|undefined, cached: boolean, reason?: string}>}
     */
    async read(server, cfg, { force = false, timeoutMs, rpc, now = Date.now() } = {}) {
      const decision = quotaCacheUsable(cached, cfg, { now, force })
      if (decision.usable) return { quota: cached, cached: true, reason: decision.reason }

      try {
        // Stamp the read with the caller's clock, so a test (or a caller with a
        // virtual clock) sees a cache age that matches its own notion of time.
        const fresh = await readQuota(server, { timeoutMs, rpc, now: () => now })
        const usable = (fresh?.tiers?.length ?? 0) + (fresh?.buckets?.length ?? 0) > 0
        // `readQuota` reports failures in-band (`error`) rather than throwing, so
        // an empty result means "nothing was readable" — which is exactly when a
        // stale cache beats a blind guard.
        if (!usable && cached !== undefined) {
          lastReadAt = now
          return { quota: cached, cached: true, reason: `读取失败，沿用缓存：${fresh?.error ?? '无数据'}` }
        }
        // Only a complete read is worth caching; a partial one would keep the
        // guard blind for the whole TTL.
        if (fresh?.error === undefined && usable) {
          cached = fresh
        }
        lastReadAt = now
        return { quota: fresh, cached: false, reason: decision.reason }
      } catch (error) {
        return { quota: cached, cached: cached !== undefined, reason: `读取失败，沿用缓存：${error.message}` }
      }
    },
    /** Drop the cache (a manual `check_environment` does this). */
    invalidate() {
      cached = undefined
      lastReadAt = undefined
    },
    /** When the cache was last written, if ever. */
    readAt() {
      return lastReadAt
    },
  }
}

// ---------------------------------------------------------------------------
// tier mapping
// ---------------------------------------------------------------------------

/**
 * Map a friendly thinking level onto the three tiers `agentapi` accepts.
 * Reuses `config-schema.js`'s map — the single source of truth — and falls back
 * to the default level for an unknown value rather than guessing a tier.
 */
export function tierForLevel(level) {
  const known = THINKING_TIERS[level]
  if (known !== undefined) return known
  return THINKING_TIERS[DEFAULT_THINKING_LEVEL]
}

// ---------------------------------------------------------------------------
// tier classification — the rule that decides whether a downgrade may happen
// ---------------------------------------------------------------------------

/**
 * Classify one reported model row as `pro` / `flash` / `flash_lite`, or
 * `undefined` when the row carries no recognisable tier meaning.
 *
 * RULE (measured against Antigravity 2.28.0):
 *  1. An explicit `pro` token wins. (No such modelId exists today, but a future
 *     one — or a "Claude Pro" label — would be honoured.)
 *  2. Otherwise the row must be a Gemini *flash* model to say anything at all.
 *     Antigravity exposes thinking effort as a suffix, so:
 *       `flash-high` / `(High)`            -> `pro`        (high effort == pro)
 *       `flash-medium` / `(Medium)`        -> `flash`
 *       `flash-low` / `flash-lite` / `(Low)` -> `flash_lite`
 *       bare `flash` (no suffix)           -> `flash`
 *  3. Anything else — `claude-*`, `gpt-oss-*`, an unrecognised id — is
 *     `undefined`. Unknown means "cannot judge", which callers MUST read as
 *     "quota sufficient", never as "low".
 *
 * @param {{label?: string, modelId?: string, id?: string}} tier
 * @returns {'pro'|'flash'|'flash_lite'|undefined}
 */
export function classifyTier(tier) {
  if (tier === null || typeof tier !== 'object') return undefined
  const text = `${tier.label ?? ''} ${tier.modelId ?? ''} ${tier.id ?? ''}`.toLowerCase()
  if (text.trim() === '') return undefined

  // 1. explicit pro token (word-bounded so "prompt"/"provider" do not match)
  if (/\bpro\b/.test(text)) return 'pro'

  // 2. only flash-family rows carry tier meaning
  if (!/flash/.test(text)) return undefined

  if (/\b(lite|low|minimal)\b/.test(text)) return 'flash_lite'
  if (/\b(extra[_-]?high|high)\b/.test(text)) return 'pro'
  if (/\b(medium|mid)\b/.test(text)) return 'flash'
  return 'flash'
}

/** Human-readable explanation of {@link classifyTier}, for check_environment. */
export const TIER_CLASSIFICATION_RULE =
  'pro = 显式 pro 标记或 flash 高思考档；flash = flash 中思考档；flash_lite = flash 低/轻档；' +
  '其它（claude / gpt-oss / 无法识别）一律视为额度充足，不触发降级。'

/** Group `quota.tiers` by their classification; unclassified rows are dropped. */
export function classifyTiers(quota) {
  const out = { pro: [], flash: [], flash_lite: [] }
  const tiers = Array.isArray(quota?.tiers) ? quota.tiers : []
  for (const tier of tiers) {
    const kind = classifyTier(tier)
    if (kind === undefined) continue
    out[kind].push(tier)
  }
  return out
}

/** Smallest finite fraction of a tier list, or undefined. */
function minFraction(tiers) {
  const values = tiers.map((t) => t.remainingFraction).filter((f) => f !== undefined)
  return values.length === 0 ? undefined : Math.min(...values)
}

/** Largest finite fraction of a tier list, or undefined. */
function maxFraction(tiers) {
  const values = tiers.map((t) => t.remainingFraction).filter((f) => f !== undefined)
  return values.length === 0 ? undefined : Math.max(...values)
}

// ---------------------------------------------------------------------------
// fallback decision
// ---------------------------------------------------------------------------

/**
 * Decide the tier a delegation should actually run on.
 *
 * TWO GUARDS, TWO HORIZONS (v0.5.0)
 * --------------------------------
 * `pro` and `flash` share one `Gemini Models` billing pool (see
 * {@link pickBillingBuckets}), split into a 5-hour window and a weekly one. The
 * two windows are not equally precious: exhausting the 5h window costs hours,
 * while exhausting the weekly window can cost days. So the guard runs twice:
 *
 *   1. **5h window** against `proMinFraction` — the original rule. When the
 *      pool is nearly empty, run `flash` to cut the per-task burn rate.
 *   2. **weekly window** against `weeklyProMinFraction` (higher, default 0.15),
 *      only while its reset is still far away. Rationing the weekly budget
 *      early is far cheaper than running out of it and waiting days.
 *
 * Both guards keep the same safety property as before: an unreadable or
 * unclassifiable quota never triggers a downgrade, because "cannot judge" must
 * never silently move a task off its requested tier.
 *
 * @param {'flash_lite'|'flash'|'pro'} desiredTier
 * @param {object} quota result of {@link readQuota}
 * @param {object} cfg plugin config
 * @returns {{tier: string, downgraded?: string, note?: string}}
 */
export function applyQuotaFallback(desiredTier, quota, cfg) {
  const keep = { tier: desiredTier }
  if (cfg?.quotaFallback?.enabled !== true) return keep
  if (desiredTier !== 'pro') return keep

  const settings = cfg.quotaFallback
  const grouped = classifyTiers(quota)
  const proFraction = minFraction(grouped.pro)

  // Anchor the countdown to the read time when the caller has one, so the same
  // quota object always produces the same note (deterministic and testable).
  const anchor = Number.isFinite(Number(quota?.readAt)) ? Number(quota.readAt) : Date.now()

  const fiveHourThreshold = fractionSetting(settings.proMinFraction, 0.05)
  const weeklyThreshold = fractionSetting(settings.weeklyProMinFraction, 0.15)

  // --- guard 1: the 5h window (tier rows when present, buckets as a fallback) --
  const billing = pickBillingBuckets(quota)
  const fiveHourBucketFraction = billing.fiveHour?.remainingFraction
  // The tier rows and the 5h bucket describe the same pool; take the tighter of
  // the two so neither view can hide a nearly-empty window.
  const candidates = [proFraction, fiveHourBucketFraction].filter((f) => f !== undefined)
  const fiveHourFraction = candidates.length === 0 ? undefined : Math.min(...candidates)

  if (fiveHourFraction !== undefined && fiveHourFraction < fiveHourThreshold) {
    const resetAt = parseResetAt(billing.fiveHour?.resetTime ?? grouped.pro.find((t) => t.remainingFraction === proFraction)?.resetTime)
    const resetHint =
      resetAt === undefined ? '' : `，额度将在 ${formatCountdown(resetAt - anchor) ?? '不久后'}后重置`
    return downgradeOrKeep({
      desiredTier,
      grouped,
      reason: `pro 额度仅剩 ${formatFraction(fiveHourFraction)}（阈值 ${formatFraction(fiveHourThreshold)}）`,
      resetHint,
      downgraded: 'pro -> flash (low quota)',
    })
  }

  // --- guard 2: the weekly window ------------------------------------------
  if (settings.weeklyGuard !== false) {
    const weeklyFraction = billing.weekly?.remainingFraction
    if (weeklyFraction !== undefined && weeklyFraction < weeklyThreshold) {
      const resetAt = parseResetAt(billing.weekly?.resetTime)
      const msToReset = resetAt === undefined ? undefined : resetAt - anchor
      const horizonHours = fractionSetting(settings.weeklyReserveHours, 24) 
      const reserveMs = horizonHours * 3_600_000
      // Only ration while the reset is genuinely far away: inside the last
      // hours of the window there is nothing left to protect.
      if (msToReset === undefined || msToReset > reserveMs) {
        const horizon = msToReset === undefined ? '' : `，距重置还有 ${formatCountdown(msToReset) ?? '很久'}`
        return downgradeOrKeep({
          desiredTier,
          grouped,
          reason:
            `周限额仅剩 ${formatFraction(weeklyFraction)}` +
            `（weekly 保护水位 ${formatFraction(weeklyThreshold)}${horizon}）`,
          resetHint: '',
          downgraded: 'pro -> flash (weekly quota reserve)',
        })
      }
    }
  }

  return keep
}

/** Read a fraction setting, falling back when it is absent or not a number. */
function fractionSetting(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback
}

/**
 * Shared tail of both guards: downgrade to `flash` when it has budget, else keep
 * `pro` with an explanatory note.
 *
 * The note matters as much as the decision — a silent "no downgrade" while the
 * account is nearly dry is indistinguishable from a working guard.
 */
function downgradeOrKeep({ desiredTier, grouped, reason, resetHint, downgraded }) {
  const flashFraction = maxFraction(grouped.flash)
  if (flashFraction === undefined || flashFraction <= 0) {
    // Flash is exhausted or unreadable: downgrading would only fail differently.
    return {
      tier: desiredTier,
      note: `${reason}，但 flash 没有可用额度${resetHint}，保持 pro`,
    }
  }
  return {
    tier: 'flash',
    downgraded,
    note: `${reason}，flash 仍有 ${formatFraction(flashFraction)}，已自动降级为 flash${resetHint}`,
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** `0.65` -> `"65%"`; very small non-zero values render as `"<1%"`. */
export function formatFraction(fraction) {
  if (fraction === undefined) return 'n/a'
  const clamped = Math.min(1, Math.max(0, fraction))
  const pct = clamped * 100
  if (clamped > 0 && pct < 1) return '<1%'
  return `${Math.round(pct)}%`
}

/**
 * Human countdown: `42m` under an hour, `1h 42m` under a day, `3d 4h` above.
 * Returns `undefined` for a missing or already-past timestamp so callers can
 * omit the clause entirely instead of printing "resets in 0m".
 */
export function formatCountdown(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}

/** Render the `65%, resets in 1h 42m` tail of a row (no leading name). */
function renderValue(fraction, resetTime, now) {
  const resetAt = parseResetAt(resetTime)
  const countdown = resetAt === undefined ? undefined : formatCountdown(resetAt - now)
  return `${formatFraction(fraction)}${countdown === undefined ? '' : `, resets in ${countdown}`}`
}

/** Render one `label: 65%, resets in 1h 42m` clause. */
function renderRow(name, fraction, resetTime, now) {
  return `${name}: ${renderValue(fraction, resetTime, now)}`
}

/**
 * Text block for `check_environment`.
 *
 * @param {object} quota result of {@link readQuota}
 * @param {{now?: number}} [opts]
 */
export function renderQuota(quota, { now = Date.now() } = {}) {
  const q = quota ?? {}
  const tiers = Array.isArray(q.tiers) ? q.tiers : []
  const buckets = Array.isArray(q.buckets) ? q.buckets : []

  if (tiers.length === 0 && buckets.length === 0) {
    return `quota        : 不可用（${q.error ?? '服务未返回额度数据'}）`
  }

  const lines = []
  const account = q.plan === undefined ? 'unknown plan' : String(q.plan)
  lines.push(`quota        : plan=${account}${q.email ? ` (${q.email})` : ''}`)

  if (tiers.length > 0) {
    lines.push('  tiers:')
    for (const tier of tiers) {
      const name =
        tier.label !== undefined && tier.label !== tier.id
          ? `${tier.id} — ${tier.label}`
          : tier.id
      lines.push(`    ${renderRow(name, tier.remainingFraction, tier.resetTime, now)}`)
    }
  }

  if (buckets.length > 0) {
    // Keep the server's group order; show the group name once, then its buckets.
    const groups = new Map()
    for (const bucket of buckets) {
      const key = bucket.groupId ?? bucket.groupName ?? 'group'
      if (!groups.has(key)) groups.set(key, { name: bucket.groupName ?? key, buckets: [] })
      groups.get(key).buckets.push(bucket)
    }
    lines.push('  buckets:')
    for (const { name, buckets: rows } of groups.values()) {
      for (const bucket of rows) {
        const label = bucket.bucketId || bucket.displayName || 'bucket'
        const window = bucket.window ? ` (${bucket.window})` : ''
        lines.push(
          `    ${name} / ${label}${window}: ${renderValue(bucket.remainingFraction, bucket.resetTime, now)}`,
        )
      }
    }
  }

  // Surface the classification so a surprising "no downgrade" is explainable.
  const grouped = classifyTiers(q)
  const mapping = Object.entries(grouped)
    .filter(([, rows]) => rows.length > 0)
    .map(([kind, rows]) => `${kind}←${rows.map((t) => t.id).join('|')}`)
  if (mapping.length > 0) lines.push(`  tier map: ${mapping.join(', ')}`)

  if (q.error !== undefined) lines.push(`  partial read: ${q.error}`)
  return lines.join('\n')
}
