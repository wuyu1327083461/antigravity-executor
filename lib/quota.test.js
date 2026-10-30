/**
 * Unit tests for quota reading, tier classification, fallback and rendering.
 *
 * The fixtures below are the *measured* shapes from Antigravity 2.28.0, not
 * invented ones: `GetUserStatus` reports thinking effort as a modelId suffix
 * (`gemini-3.8-flash-high|medium|low`) and `RetrieveUserQuotaSummary` reports
 * two groups (Gemini Models / Claude and GPT models) with 5h and weekly
 * buckets. The classification rule is the risky part of REQ-03 — a wrong
 * judgement downgrades a task the user asked for — so it is tested directly,
 * including the "cannot recognise -> never downgrade" case.
 *
 * Run: node --test lib/quota.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_CONFIG } from './config-schema.js'
import {
  applyQuotaFallback,
  classifyTier,
  classifyTiers,
  createQuotaCache,
  formatCountdown,
  formatFraction,
  normalizeQuotaSummary,
  normalizeUserStatus,
  pickBillingBuckets,
  quotaCacheUsable,
  readQuota,
  renderQuota,
  tierForLevel,
  weeklyGuardLevel,
} from './quota.js'

const NOW = Date.parse('2026-10-29T10:00:00.000Z')

/** Measured GetUserStatus reply, trimmed to the fields this plugin reads. */
const USER_STATUS = {
  userStatus: {
    name: 'Test User',
    email: 'test@example.com',
    planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } },
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          label: 'Gemini 3.8 Flash (High)',
          modelOrAlias: { model: 'gemini-3.8-flash-high' },
          modelId: 'gemini-3.8-flash-high',
          quotaInfo: { remainingFraction: 0.65, resetTime: '2026-10-29T11:42:00.000Z' },
        },
        {
          label: 'Gemini 3.8 Flash (Medium)',
          modelOrAlias: { model: 'gemini-3.8-flash-medium' },
          modelId: 'gemini-3.8-flash-medium',
          quotaInfo: { remainingFraction: 0.9, resetTime: '2026-10-29T11:42:00.000Z' },
        },
        {
          label: 'Gemini 3.8 Flash (Low)',
          modelOrAlias: { model: 'gemini-3.8-flash-low' },
          modelId: 'gemini-3.8-flash-low',
          quotaInfo: { remainingFraction: 1, resetTime: '2026-10-29T11:42:00.000Z' },
        },
        {
          label: 'Claude Sonnet 4.6',
          modelOrAlias: { model: 'claude-sonnet-4-6' },
          modelId: 'claude-sonnet-4-6',
          quotaInfo: { remainingFraction: 0.02, resetTime: '2026-10-29T11:42:00.000Z' },
        },
        {
          label: 'GPT-OSS 120B (Medium)',
          modelOrAlias: { model: 'gpt-oss-120b-medium' },
          modelId: 'gpt-oss-120b-medium',
          quotaInfo: { remainingFraction: 0.4, resetTime: '2026-10-29T11:42:00.000Z' },
        },
      ],
    },
  },
}

/** Measured RetrieveUserQuotaSummary reply: two groups, 5h + weekly each. */
const QUOTA_SUMMARY = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Gemini model usage',
        buckets: [
          {
            bucketId: 'gemini-5h',
            displayName: '5-hour window',
            window: '5h',
            remainingFraction: 0.65,
            resetTime: '2026-10-29T11:42:00.000Z',
            description: 'Gemini 5h rolling window',
          },
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly window',
            window: 'weekly',
            remainingFraction: 0.83,
            resetTime: '2026-11-02T09:00:00.000Z',
            description: 'Gemini weekly quota',
          },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Third-party model usage',
        buckets: [
          {
            bucketId: '3p-5h',
            displayName: '5-hour window',
            window: '5h',
            remainingFraction: 0.02,
            resetTime: '2026-10-29T11:42:00.000Z',
            description: 'Third-party 5h rolling window',
          },
          {
            bucketId: '3p-weekly',
            displayName: 'Weekly window',
            window: 'weekly',
            remainingFraction: 0.12,
            resetTime: '2026-11-02T09:00:00.000Z',
            description: 'Third-party weekly quota',
          },
        ],
      },
    ],
  },
}

const cfgWith = (overrides = {}) => ({
  ...DEFAULT_CONFIG,
  quotaFallback: { ...DEFAULT_CONFIG.quotaFallback, ...overrides },
})

/** A quota object shaped like readQuota's return value. */
const quotaWith = (tiers) => ({ plan: 'Pro', tiers, buckets: [], readAt: NOW })

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

test('normalizeUserStatus reads plan, email and every measured tier row', () => {
  const out = normalizeUserStatus(USER_STATUS)
  assert.equal(out.plan, 'Pro')
  assert.equal(out.email, 'test@example.com')
  assert.deepEqual(
    out.tiers.map((t) => t.id),
    [
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ],
  )
  assert.equal(out.tiers[0].label, 'Gemini 3.8 Flash (High)')
  assert.equal(out.tiers[0].remainingFraction, 0.65)
  assert.equal(out.tiers[0].resetTime, '2026-10-29T11:42:00.000Z')
})

test('normalizeUserStatus tolerates an unwrapped reply and missing fields', () => {
  const out = normalizeUserStatus({ planStatus: { planInfo: { planName: 'Free' } } })
  assert.equal(out.plan, 'Free')
  assert.deepEqual(out.tiers, [])
  assert.equal(out.email, undefined)
})

test('normalizeUserStatus falls back to modelOrAlias.model when modelId is absent', () => {
  const out = normalizeUserStatus({
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [{ label: 'X', modelOrAlias: { model: 'gemini-3.8-flash-medium' } }],
      },
    },
  })
  assert.equal(out.tiers[0].id, 'gemini-3.8-flash-medium')
  assert.equal(out.tiers[0].remainingFraction, undefined)
})

test('normalizeQuotaSummary flattens both measured groups into tagged buckets', () => {
  const buckets = normalizeQuotaSummary(QUOTA_SUMMARY)
  assert.equal(buckets.length, 4)
  assert.deepEqual(
    buckets.map((b) => `${b.groupId}/${b.bucketId}/${b.window}`),
    ['gemini-models/gemini-5h/5h', 'gemini-models/gemini-weekly/weekly', 'claude-and-gpt-models/3p-5h/5h', 'claude-and-gpt-models/3p-weekly/weekly'],
  )
  assert.equal(buckets[0].groupName, 'Gemini Models')
  assert.equal(buckets[0].remainingFraction, 0.65)
  assert.equal(buckets[2].remainingFraction, 0.02)
})

// ---------------------------------------------------------------------------
// readQuota: merge, partial failure, total failure
// ---------------------------------------------------------------------------

test('readQuota merges both endpoints into one object', async () => {
  const calls = []
  const rpc = {
    async getUserStatus(server, opts) {
      calls.push(['status', server, opts])
      return USER_STATUS
    },
    async retrieveQuotaSummary(server, opts) {
      calls.push(['summary', server, opts])
      return QUOTA_SUMMARY
    },
  }

  const server = { port: 58953, csrf: 'csrf-token' }
  const quota = await readQuota(server, { timeoutMs: 1234, rpc })

  assert.equal(quota.plan, 'Pro')
  assert.equal(quota.email, 'test@example.com')
  assert.equal(quota.tiers.length, 5)
  assert.equal(quota.buckets.length, 4)
  assert.equal(typeof quota.readAt, 'number')
  assert.equal(quota.error, undefined)
  // The timeout is forwarded to both calls.
  assert.deepEqual(calls.map(([name, srv, opts]) => [name, srv, opts.timeoutMs]), [
    ['status', server, 1234],
    ['summary', server, 1234],
  ])
})

test('readQuota keeps the partial result when one endpoint fails', async () => {
  const quota = await readQuota(
    { port: 1, csrf: 'x' },
    {
      rpc: {
        async getUserStatus() {
          return USER_STATUS
        },
        async retrieveQuotaSummary() {
          throw new Error('HTTP 500')
        },
      },
    },
  )
  assert.equal(quota.plan, 'Pro')
  assert.equal(quota.tiers.length, 5)
  assert.deepEqual(quota.buckets, [])
  assert.match(quota.error, /RetrieveUserQuotaSummary/)
})

test('readQuota reports an error instead of throwing when both endpoints fail', async () => {
  const quota = await readQuota(
    { port: 1, csrf: 'x' },
    {
      rpc: {
        async getUserStatus() {
          throw new Error('ECONNREFUSED')
        },
        async retrieveQuotaSummary() {
          throw new Error('network down')
        },
      },
    },
  )
  assert.equal(quota.plan, undefined)
  assert.deepEqual(quota.tiers, [])
  assert.match(quota.error, /GetUserStatus/)
  assert.match(quota.error, /RetrieveUserQuotaSummary/)
})

// ---------------------------------------------------------------------------
// tierForLevel
// ---------------------------------------------------------------------------

test('tierForLevel reuses the config-schema thinking map', () => {
  assert.equal(tierForLevel('minimal'), 'flash_lite')
  assert.equal(tierForLevel('low'), 'flash_lite')
  assert.equal(tierForLevel('medium'), 'flash')
  assert.equal(tierForLevel('high'), 'pro')
  assert.equal(tierForLevel('extra_high'), 'pro')
})

test('tierForLevel falls back to the default level for an unknown input', () => {
  // Unknown levels must not invent a tier; medium is the schema default.
  assert.equal(tierForLevel('ultra'), tierForLevel('medium'))
  assert.equal(tierForLevel(undefined), 'flash')
})

// ---------------------------------------------------------------------------
// classification rule (the risky part)
// ---------------------------------------------------------------------------

test('classifyTier maps measured flash effort suffixes to tiers', () => {
  assert.equal(classifyTier({ modelId: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }), 'pro')
  assert.equal(classifyTier({ modelId: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' }), 'flash')
  assert.equal(classifyTier({ modelId: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' }), 'flash_lite')
})

test('classifyTier honours an explicit pro token', () => {
  assert.equal(classifyTier({ modelId: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro' }), 'pro')
  assert.equal(classifyTier({ label: 'Claude Pro' }), 'pro')
})

test('classifyTier treats bare flash as flash and flash-lite as flash_lite', () => {
  assert.equal(classifyTier({ modelId: 'gemini-3.8-flash' }), 'flash')
  assert.equal(classifyTier({ modelId: 'gemini-3.8-flash-lite' }), 'flash_lite')
})

test('classifyTier does not let "prompt" or "provider" masquerade as pro', () => {
  assert.equal(classifyTier({ label: 'Provider prompt model' }), undefined)
  assert.equal(classifyTier({ modelId: 'gemini-3.8-flash-medium', label: 'Prompt helper' }), 'flash')
})

test('classifyTier returns undefined for models with no tier meaning', () => {
  // Measured rows that must NOT be read as "pro is low": claude and gpt-oss.
  assert.equal(classifyTier({ modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }), undefined)
  assert.equal(classifyTier({ modelId: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }), undefined)
  assert.equal(classifyTier({ modelId: 'some-future-model' }), undefined)
  assert.equal(classifyTier(null), undefined)
  assert.equal(classifyTier({}), undefined)
})

test('classifyTiers groups the measured tier list', () => {
  const grouped = classifyTiers(quotaWith(normalizeUserStatus(USER_STATUS).tiers))
  assert.deepEqual(grouped.pro.map((t) => t.id), ['gemini-3.8-flash-high'])
  assert.deepEqual(grouped.flash.map((t) => t.id), ['gemini-3.8-flash-medium'])
  assert.deepEqual(grouped.flash_lite.map((t) => t.id), ['gemini-3.8-flash-low'])
})

// ---------------------------------------------------------------------------
// applyQuotaFallback
// ---------------------------------------------------------------------------

test('applyQuotaFallback keeps pro when its quota is healthy', () => {
  const quota = quotaWith([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.65 },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.9 },
  ])
  const decision = applyQuotaFallback('pro', quota, cfgWith())
  assert.deepEqual(decision, { tier: 'pro' })
})

test('applyQuotaFallback downgrades pro -> flash when pro is below the threshold', () => {
  const quota = quotaWith([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.02 },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.8 },
  ])
  const decision = applyQuotaFallback('pro', quota, cfgWith({ proMinFraction: 0.05 }))
  assert.equal(decision.tier, 'flash')
  assert.equal(decision.downgraded, 'pro -> flash (low quota)')
  assert.match(decision.note, /2%/)
  assert.match(decision.note, /flash/)
})

test('applyQuotaFallback keeps pro when flash has no quota left', () => {
  const quota = quotaWith([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.01 },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0 },
  ])
  const decision = applyQuotaFallback('pro', quota, cfgWith())
  assert.equal(decision.tier, 'pro')
  assert.equal(decision.downgraded, undefined)
  assert.match(decision.note, /flash 没有可用额度/)
})

test('applyQuotaFallback never downgrades when the pro tier cannot be identified', () => {
  // Only claude/gpt-oss rows: nothing maps to pro, so quota is "unjudgeable".
  // Treating that as low would wrongly move a healthy task off pro.
  const quota = quotaWith([
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', remainingFraction: 0.02 },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', remainingFraction: 0.4 },
  ])
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith()), { tier: 'pro' })
})

test('applyQuotaFallback never downgrades on an empty or errored quota read', () => {
  const errored = { plan: undefined, tiers: [], buckets: [], readAt: NOW, error: 'network down' }
  assert.deepEqual(applyQuotaFallback('pro', errored, cfgWith()), { tier: 'pro' })
  assert.deepEqual(applyQuotaFallback('pro', undefined, cfgWith()), { tier: 'pro' })
})

test('applyQuotaFallback never downgrades a tier that is not pro', () => {
  const quota = quotaWith([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0 },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.8 },
  ])
  // flash is the fallback target itself; flash_lite has no lower tier to take.
  assert.deepEqual(applyQuotaFallback('flash', quota, cfgWith()), { tier: 'flash' })
  assert.deepEqual(applyQuotaFallback('flash_lite', quota, cfgWith()), { tier: 'flash_lite' })
})

test('applyQuotaFallback is a no-op when the feature is disabled', () => {
  const quota = quotaWith([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0 },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.8 },
  ])
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith({ enabled: false })), { tier: 'pro' })
})

test('applyQuotaFallback respects a custom threshold', () => {
  const quota = quotaWith([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.3 },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.8 },
  ])
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith({ proMinFraction: 0.2 })), { tier: 'pro' })
  assert.equal(applyQuotaFallback('pro', quota, cfgWith({ proMinFraction: 0.5 })).tier, 'flash')
})

test('applyQuotaFallback anchors its reset countdown to quota.readAt', () => {
  // Same quota object must always produce the same note, or the text would
  // drift with the wall clock between the read and the render.
  const quota = {
    ...quotaWith([
      {
        id: 'gemini-3.8-flash-high',
        label: 'Gemini 3.8 Flash (High)',
        remainingFraction: 0.01,
        resetTime: '2026-10-29T11:42:00.000Z',
      },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.8 },
    ]),
    readAt: NOW,
  }
  const first = applyQuotaFallback('pro', quota, cfgWith())
  const second = applyQuotaFallback('pro', quota, cfgWith())
  assert.equal(first.note, second.note)
  assert.match(first.note, /额度将在 1h 42m后重置/)
})

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('formatFraction renders percentages and the sub-1% floor', () => {
  assert.equal(formatFraction(0.65), '65%')
  assert.equal(formatFraction(1), '100%')
  assert.equal(formatFraction(0), '0%')
  assert.equal(formatFraction(0.004), '<1%')
  assert.equal(formatFraction(undefined), 'n/a')
})

test('formatCountdown is minutes under an hour, h+m under a day, d+h above', () => {
  const MIN = 60_000
  assert.equal(formatCountdown(42 * MIN), '42m')
  assert.equal(formatCountdown(102 * MIN), '1h 42m')
  assert.equal(formatCountdown(60 * MIN), '1h')
  assert.equal(formatCountdown(26 * 60 * MIN), '1d 2h')
  assert.equal(formatCountdown(24 * 60 * MIN), '1d')
  assert.equal(formatCountdown(0), undefined)
  assert.equal(formatCountdown(-5), undefined)
  assert.equal(formatCountdown(undefined), undefined)
})

test('renderQuota renders the measured tiers and buckets with countdowns', () => {
  const quota = {
    plan: 'Pro',
    email: 'test@example.com',
    tiers: normalizeUserStatus(USER_STATUS).tiers,
    buckets: normalizeQuotaSummary(QUOTA_SUMMARY),
    readAt: NOW,
  }
  const text = renderQuota(quota, { now: NOW })

  assert.match(text, /plan=Pro \(test@example.com\)/)
  // 0.65 and a reset 1h42m out — the shape required by the contract.
  assert.match(text, /gemini-3\.8-flash-high — Gemini 3\.8 Flash \(High\): 65%, resets in 1h 42m/)
  assert.match(text, /claude-sonnet-4-6 — Claude Sonnet 4\.6: 2%, resets in 1h 42m/)
  // Both measured bucket groups and both windows appear.
  assert.match(text, /Gemini Models \/ gemini-5h \(5h\): 65%, resets in 1h 42m/)
  assert.match(text, /Gemini Models \/ gemini-weekly \(weekly\): 83%, resets in 3d 23h/)
  assert.match(text, /Claude and GPT models \/ 3p-5h \(5h\): 2%, resets in 1h 42m/)
  // The tier map makes a surprising "no downgrade" explainable.
  assert.match(text, /tier map: pro←gemini-3\.8-flash-high/)
})

test('renderQuota omits the countdown for a past reset time', () => {
  const quota = quotaWith([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.5, resetTime: '2026-10-29T09:00:00.000Z' },
  ])
  const text = renderQuota(quota, { now: NOW })
  assert.match(text, /: 50%$/m)
  assert.doesNotMatch(text, /resets in/)
})

test('renderQuota reports unavailability rather than printing an empty block', () => {
  assert.match(renderQuota({ tiers: [], buckets: [], error: 'network down' }), /不可用（network down）/)
  assert.match(renderQuota(undefined), /不可用/)
})

test('renderQuota surfaces a partial read without hiding the good half', () => {
  const quota = {
    plan: 'Pro',
    tiers: normalizeUserStatus(USER_STATUS).tiers,
    buckets: [],
    readAt: NOW,
    error: 'RetrieveUserQuotaSummary 读取失败：HTTP 500',
  }
  const text = renderQuota(quota, { now: NOW })
  assert.match(text, /gemini-3\.8-flash-high/)
  assert.match(text, /partial read: RetrieveUserQuotaSummary/)
})


// ---------------------------------------------------------------------------
// v0.5.0: billing buckets (pro and flash share one Gemini pool)
// ---------------------------------------------------------------------------

test('pickBillingBuckets binds the shared Gemini pool, not a bucket named "pro"', () => {
  // The measured shape has NO bucket called "pro": pro and flash share the
  // Gemini Models pool. A literal-name lookup would find nothing on any real
  // account and silently disable the guard.
  const quota = { buckets: normalizeQuotaSummary(QUOTA_SUMMARY) }
  const picked = pickBillingBuckets(quota)

  assert.deepEqual(picked.gemini.map((b) => b.bucketId), ['gemini-5h', 'gemini-weekly'])
  assert.equal(picked.fiveHour.bucketId, 'gemini-5h')
  assert.equal(picked.weekly.bucketId, 'gemini-weekly')
  assert.equal(picked.fiveHour.remainingFraction, 0.65)
  assert.equal(picked.weekly.remainingFraction, 0.83)
  // The 3p pool is recognised separately and never used as a pro source.
  assert.deepEqual(picked.thirdParty.map((b) => b.bucketId), ['3p-5h', '3p-weekly'])
})

test('pickBillingBuckets tolerates a missing or empty bucket list', () => {
  const empty = { gemini: [], weekly: undefined, fiveHour: undefined, thirdParty: [] }
  assert.deepEqual(pickBillingBuckets(undefined), empty)
  assert.deepEqual(pickBillingBuckets({ buckets: [] }), empty)
})

test('a low Gemini 5h bucket is a pro signal even without a tier row named pro', () => {
  // Only claude/gpt tier rows (unclassifiable) plus a nearly-empty Gemini pool:
  // the bucket is the only signal, and it must be enough to decide.
  const quota = {
    tiers: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', remainingFraction: 0.9 }],
    buckets: [
      { groupId: 'gemini-models', groupName: 'Gemini Models', bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.02, resetTime: '2026-10-29T11:42:00.000Z' },
      { groupId: 'gemini-models', groupName: 'Gemini Models', bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-02T09:00:00.000Z' },
      { groupId: 'claude-and-gpt-models', groupName: 'Claude and GPT models', bucketId: '3p-5h', window: '5h', remainingFraction: 0.9 },
    ],
    readAt: NOW,
  }
  // No classifiable flash row exists, so flash is not a usable target: the guard
  // keeps pro but must say why rather than staying silent.
  const decision = applyQuotaFallback('pro', quota, cfgWith())
  assert.equal(decision.tier, 'pro')
  assert.match(decision.note, /flash 没有可用额度/)
  assert.match(decision.note, /2%/)
})

test('a low Gemini 5h bucket downgrades pro when flash budget exists', () => {
  const quota = {
    tiers: [{ id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.8 }],
    buckets: [
      { groupId: 'gemini-models', bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.02 },
      { groupId: 'gemini-models', bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 },
    ],
    readAt: NOW,
  }
  const decision = applyQuotaFallback('pro', quota, cfgWith())
  assert.equal(decision.tier, 'flash')
  assert.equal(decision.downgraded, 'pro -> flash (low quota)')
})

test('the tighter of the tier row and the 5h bucket wins', () => {
  // Tier row says 60% but the 5h bucket says 1%: the bucket is authoritative for
  // the shared pool, so the guard must fire.
  const quota = {
    tiers: [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.6 },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.9 },
    ],
    buckets: [{ groupId: 'gemini-models', bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.01 }],
    readAt: NOW,
  }
  assert.equal(applyQuotaFallback('pro', quota, cfgWith()).tier, 'flash')
})

// ---------------------------------------------------------------------------
// v0.5.0: weekly reserve guard
// ---------------------------------------------------------------------------

test('a healthy 5h pool but a nearly-dry weekly pool rations pro to flash', () => {
  const quota = {
    tiers: [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.9 },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.9 },
    ],
    buckets: [
      { groupId: 'gemini-models', bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-10-29T11:42:00.000Z' },
      // 10% weekly left, resetting in ~2 days: worth rationing.
      { groupId: 'gemini-models', bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.1, resetTime: '2026-11-01T10:00:00.000Z' },
    ],
    readAt: NOW,
  }
  const decision = applyQuotaFallback('pro', quota, cfgWith({ weeklyProMinFraction: 0.15 }))
  assert.equal(decision.tier, 'flash')
  assert.equal(decision.downgraded, 'pro -> flash (weekly quota reserve)')
  assert.match(decision.note, /周限额仅剩 10%/)
})

test('the weekly guard does not fire inside the last hours before reset', () => {
  const quota = {
    tiers: [{ id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.9 }],
    buckets: [
      { groupId: 'gemini-models', bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9 },
      // 10% left but it resets in 3 hours: nothing left to protect.
      { groupId: 'gemini-models', bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.1, resetTime: '2026-10-29T13:00:00.000Z' },
    ],
    readAt: NOW,
  }
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith({ weeklyProMinFraction: 0.15 })), { tier: 'pro' })
})

test('the weekly guard can be disabled by config', () => {
  const quota = {
    tiers: [{ id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.9 }],
    buckets: [
      { groupId: 'gemini-models', bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9 },
      { groupId: 'gemini-models', bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.05, resetTime: '2026-11-05T10:00:00.000Z' },
    ],
    readAt: NOW,
  }
  assert.equal(applyQuotaFallback('pro', quota, cfgWith({ weeklyGuard: false })).tier, 'pro')
})

test('a weekly pool above its reserve level leaves pro alone', () => {
  const quota = {
    tiers: [{ id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.9 }],
    buckets: [
      { groupId: 'gemini-models', bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9 },
      { groupId: 'gemini-models', bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: '2026-11-05T10:00:00.000Z' },
    ],
    readAt: NOW,
  }
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith({ weeklyProMinFraction: 0.15 })), { tier: 'pro' })
})

// ---------------------------------------------------------------------------
// REQ-06: the weekly guard keeps a 5% floor inside the last 24h
// ---------------------------------------------------------------------------

/** Just enough tiers/buckets for a weekly-only decision, with a chosen reset. */
const weeklyQuota = (weekly, resetTime, { flash = 0.9, fiveHour = 0.9 } = {}) => ({
  tiers: [{ id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: flash }],
  buckets: [
    { groupId: 'gemini-models', bucketId: 'gemini-5h', window: '5h', remainingFraction: fiveHour },
    {
      groupId: 'gemini-models',
      bucketId: 'gemini-weekly',
      window: 'weekly',
      remainingFraction: weekly,
      ...(resetTime === undefined ? {} : { resetTime }),
    },
  ],
  readAt: NOW,
})

test('weeklyGuardLevel releases the reserve and holds the floor inside the horizon', () => {
  const settings = cfgWith().quotaFallback
  // 10h to go: inside the 24h horizon -> the 5% floor, not the 15% reserve.
  assert.deepEqual(weeklyGuardLevel(settings, { resetAt: NOW + 10 * 3_600_000, anchor: NOW }), {
    threshold: 0.05,
    hoursUntilReset: 10,
    nearReset: true,
  })
  // 30h to go: outside the horizon -> the full reserve.
  assert.deepEqual(weeklyGuardLevel(settings, { resetAt: NOW + 30 * 3_600_000, anchor: NOW }), {
    threshold: 0.15,
    hoursUntilReset: 30,
    nearReset: false,
  })
})

test('weeklyGuardLevel treats a missing or unreadable reset as far away', () => {
  const settings = cfgWith().quotaFallback
  // "Cannot read when it resets" must never weaken the guard.
  const missing = weeklyGuardLevel(settings, { resetAt: undefined, anchor: NOW })
  assert.equal(missing.threshold, 0.15)
  assert.equal(missing.hoursUntilReset, null)
  assert.equal(missing.nearReset, false)

  assert.equal(weeklyGuardLevel(settings, { resetAt: Number.NaN, anchor: NOW }).nearReset, false)
  // Even a totally absent options object degrades to the reserve.
  assert.deepEqual(weeklyGuardLevel(settings), { threshold: 0.15, hoursUntilReset: null, nearReset: false })
})

test('weeklyGuardLevel honours custom settings and degrades garbage to the defaults', () => {
  const custom = weeklyGuardLevel(
    { weeklyProMinFraction: 0.3, proMinFraction: 0.1, weeklyReserveHours: 48 },
    { resetAt: NOW + 30 * 3_600_000, anchor: NOW },
  )
  // 30h is inside a 48h horizon, so the custom 10% floor applies.
  assert.equal(custom.threshold, 0.1)
  assert.equal(custom.nearReset, true)

  // Garbage in every field still yields the documented defaults, never a throw.
  const garbage = weeklyGuardLevel(
    { weeklyProMinFraction: 'nonsense', proMinFraction: null, weeklyReserveHours: -3 },
    { resetAt: NOW + 10 * 3_600_000, anchor: NOW },
  )
  assert.equal(garbage.threshold, 0.05)
  assert.equal(garbage.nearReset, true)
  // No settings at all still reads as "far away": the reserve applies.
  assert.equal(
    weeklyGuardLevel(undefined, { resetAt: NOW + 30 * 3_600_000, anchor: NOW }).threshold,
    0.15,
  )
})

test('near the reset, 10% weekly keeps pro because it is above the 5% floor', () => {
  const quota = weeklyQuota(0.1, '2026-10-29T20:00:00.000Z')
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith()), { tier: 'pro' })
})

test('near the reset, 3% weekly downgrades with the weekly quota floor string', () => {
  const quota = weeklyQuota(0.03, '2026-10-29T20:00:00.000Z')
  const decision = applyQuotaFallback('pro', quota, cfgWith())

  assert.equal(decision.tier, 'flash')
  // A support ticket must not read "reserve" for a floor.
  assert.equal(decision.downgraded, 'pro -> flash (weekly quota floor)')
  assert.match(decision.note, /周限额仅剩 3%/)
  assert.match(decision.note, /< 24h 已放开 15% 水位/)
  assert.match(decision.note, /退守 5% 底线/)
  assert.match(decision.note, /距重置还有 10h/)
})

test('far from the reset, 10% weekly still downgrades with the reserve string', () => {
  // The v0.5.0 rule, unchanged: this is the regression that must not move.
  const quota = weeklyQuota(0.1, '2026-10-30T16:00:00.000Z')
  const decision = applyQuotaFallback('pro', quota, cfgWith())

  assert.equal(decision.tier, 'flash')
  assert.equal(decision.downgraded, 'pro -> flash (weekly quota reserve)')
  assert.match(decision.note, /周限额仅剩 10%/)
  assert.match(decision.note, /weekly 保护水位 15%/)
  assert.match(decision.note, /距重置还有 1d 6h/)
  assert.doesNotMatch(decision.note, /底线/)
})

test('a missing resetTime with 3% weekly downgrades as a reserve', () => {
  const quota = weeklyQuota(0.03, undefined)
  const decision = applyQuotaFallback('pro', quota, cfgWith())

  assert.equal(decision.tier, 'flash')
  assert.equal(decision.downgraded, 'pro -> flash (weekly quota reserve)')
  assert.match(decision.note, /weekly 保护水位 15%/)
  // Nothing is claimed about a reset the response did not carry.
  assert.doesNotMatch(decision.note, /距重置/)
})

test('weeklyGuard: false disables the floor too, not only the reserve', () => {
  const quota = weeklyQuota(0.01, '2026-10-29T20:00:00.000Z')
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith({ weeklyGuard: false })), { tier: 'pro' })
})

test('inside the horizon, a dry floor still keeps pro when flash is exhausted', () => {
  const quota = weeklyQuota(0.03, '2026-10-29T20:00:00.000Z', { flash: 0 })
  const decision = applyQuotaFallback('pro', quota, cfgWith())

  // Downgrading would only fail differently, so pro stays — but it must say why.
  assert.equal(decision.tier, 'pro')
  assert.equal(decision.downgraded, undefined)
  assert.match(decision.note, /flash 没有可用额度/)
  assert.match(decision.note, /退守 5% 底线/)
})

test('the floor is the configured proMinFraction, not a hard-coded 5%', () => {
  // 11% weekly, 10h to go, floor raised to 12%: the floor now bites.
  const quota = weeklyQuota(0.11, '2026-10-29T20:00:00.000Z')
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith()), { tier: 'pro' })
  assert.equal(applyQuotaFallback('pro', quota, cfgWith({ proMinFraction: 0.12 })).tier, 'flash')
})

test('a custom weeklyReserveHours moves the horizon boundary', () => {
  // 30h away is "far" at the default 24h horizon but "near" at 48h.
  const quota = weeklyQuota(0.1, '2026-10-30T16:00:00.000Z')
  assert.equal(applyQuotaFallback('pro', quota, cfgWith()).tier, 'flash')
  assert.deepEqual(applyQuotaFallback('pro', quota, cfgWith({ weeklyReserveHours: 48 })), { tier: 'pro' })
})

// ---------------------------------------------------------------------------
// v0.5.0: quota cache
// ---------------------------------------------------------------------------

test('quotaCacheUsable reuses a recent complete read', () => {
  const cached = { plan: 'Pro', tiers: normalizeUserStatus(USER_STATUS).tiers, buckets: [], readAt: NOW }
  assert.equal(quotaCacheUsable(cached, cfgWith({ cacheTtlSeconds: 180 }), { now: NOW + 60_000 }).usable, true)
})

test('quotaCacheUsable rejects an expired read', () => {
  const cached = { tiers: normalizeUserStatus(USER_STATUS).tiers, buckets: [], readAt: NOW }
  const decision = quotaCacheUsable(cached, cfgWith({ cacheTtlSeconds: 180 }), { now: NOW + 181_000 })
  assert.equal(decision.usable, false)
  assert.match(decision.reason, /old/)
})

test('quotaCacheUsable refuses to cache near the guard threshold', () => {
  // 6% pro cached, threshold 5%: the live value could already be 3%, so the
  // cache is exactly what would be dangerous here.
  const cached = {
    tiers: [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.06 },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', remainingFraction: 0.9 },
    ],
    buckets: [],
    readAt: NOW,
  }
  const decision = quotaCacheUsable(cached, cfgWith({ proMinFraction: 0.05, cacheTtlSeconds: 180 }), { now: NOW + 1_000 })
  assert.equal(decision.usable, false)
  assert.match(decision.reason, /警戒线/)
})

test('quotaCacheUsable is bypassed by force, a bad read or a missing timestamp', () => {
  const healthy = { tiers: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', remainingFraction: 0.8 }], buckets: [], readAt: NOW }
  const cfg = cfgWith({ cacheTtlSeconds: 180 })

  assert.equal(quotaCacheUsable(healthy, cfg, { now: NOW + 1_000, force: true }).usable, false)
  assert.equal(quotaCacheUsable(undefined, cfg, { now: NOW }).usable, false)
  assert.equal(quotaCacheUsable({ ...healthy, error: 'partial' }, cfg, { now: NOW + 1_000 }).usable, false)
  assert.equal(quotaCacheUsable({ tiers: [], buckets: [] }, cfg, { now: NOW }).usable, false)
  assert.equal(quotaCacheUsable(healthy, cfgWith({ cacheTtlSeconds: 0 }), { now: NOW + 1_000 }).usable, false)
})

test('createQuotaCache reads once, then serves the cache within its TTL', async () => {
  let reads = 0
  const rpc = {
    async getUserStatus() {
      reads += 1
      return USER_STATUS
    },
    async retrieveQuotaSummary() {
      return QUOTA_SUMMARY
    },
  }
  const cfg = cfgWith({ cacheTtlSeconds: 180 })
  const cache = createQuotaCache()
  const server = { port: 58953, csrf: 'x' }

  const first = await cache.read(server, cfg, { rpc, now: NOW })
  assert.equal(first.cached, false)
  assert.equal(reads, 1)

  const second = await cache.read(server, cfg, { rpc, now: NOW + 30_000 })
  assert.equal(second.cached, true)
  assert.equal(reads, 1, 'the second read must come from the cache')

  // Forcing a refresh (manual check_environment) hits the account again.
  const forced = await cache.read(server, cfg, { rpc, now: NOW + 31_000, force: true })
  assert.equal(forced.cached, false)
  assert.equal(reads, 2)

  cache.invalidate()
  assert.equal(cache.get(), undefined)
  assert.equal(cache.readAt(), undefined)
})

test('createQuotaCache does not cache a partial read', async () => {
  let reads = 0
  const rpc = {
    async getUserStatus() {
      reads += 1
      return USER_STATUS
    },
    async retrieveQuotaSummary() {
      throw new Error('summary down')
    },
  }
  const cfg = cfgWith({ cacheTtlSeconds: 180 })
  const cache = createQuotaCache()
  const server = { port: 1, csrf: 'x' }

  await cache.read(server, cfg, { rpc, now: NOW })
  const second = await cache.read(server, cfg, { rpc, now: NOW + 1_000 })
  assert.equal(second.cached, false, 'a partial read must not be reused')
  assert.equal(reads, 2)
})

test('createQuotaCache falls back to the cache when a fresh read throws', async () => {
  const cfg = cfgWith({ cacheTtlSeconds: 180 })
  const cache = createQuotaCache()
  const server = { port: 1, csrf: 'x' }

  await cache.read(server, cfg, {
    now: NOW,
    rpc: {
      async getUserStatus() {
        return USER_STATUS
      },
      async retrieveQuotaSummary() {
        return QUOTA_SUMMARY
      },
    },
  })

  const result = await cache.read(server, cfg, {
    now: NOW + 400_000, // past the TTL, so a fresh read is attempted
    rpc: {
      async getUserStatus() {
        throw new Error('ECONNREFUSED')
      },
      async retrieveQuotaSummary() {
        throw new Error('ECONNREFUSED')
      },
    },
  })
  // The fallback read is the cached one; the delegation must never be blocked by
  // a quota read failure.
  assert.equal(result.cached, true)
  assert.match(result.reason, /读取失败/)
})
