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
export async function readQuota(server, { timeoutMs = 8000, rpc } = {}) {
  const readAt = Date.now()
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
 * Downgrade only when ALL of these hold:
 *   - `cfg.quotaFallback.enabled`
 *   - the desired tier is exactly `pro`
 *   - at least one row is classified `pro` (otherwise we cannot judge -> keep)
 *   - the pro fraction is below `proMinFraction`
 *   - at least one row is classified `flash` with a positive fraction
 *     (flash_lite does not count: the fallback target is `--model=flash`)
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

  const grouped = classifyTiers(quota)
  const proFraction = minFraction(grouped.pro)

  // Cannot identify a pro-equivalent row: not a low-quota signal, so keep pro.
  if (proFraction === undefined) return keep

  const minRaw = Number(cfg?.quotaFallback?.proMinFraction)
  const min = Number.isFinite(minRaw) ? minRaw : 0.05
  if (!(proFraction < min)) return keep

  const proTier = grouped.pro.find((t) => t.remainingFraction === proFraction)
  const resetAt = parseResetAt(proTier?.resetTime)
  // Anchor the countdown to the read time when the caller has one, so the same
  // quota object always produces the same note (deterministic and testable).
  const anchor = Number.isFinite(Number(quota?.readAt)) ? Number(quota.readAt) : Date.now()
  const resetHint =
    resetAt === undefined ? '' : `，额度将在 ${formatCountdown(resetAt - anchor) ?? '不久后'}后重置`

  const flashFraction = maxFraction(grouped.flash)
  if (flashFraction === undefined || flashFraction <= 0) {
    // Flash is exhausted or unreadable: downgrading would only fail differently.
    return {
      tier: desiredTier,
      note:
        `pro 额度仅剩 ${formatFraction(proFraction)}（阈值 ${formatFraction(min)}）` +
        `，但 flash 没有可用额度${resetHint}，保持 pro`,
    }
  }

  return {
    tier: 'flash',
    downgraded: 'pro -> flash (low quota)',
    note:
      `pro 额度仅剩 ${formatFraction(proFraction)}（阈值 ${formatFraction(min)}）` +
      `，flash 仍有 ${formatFraction(flashFraction)}，已自动降级为 flash${resetHint}`,
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
