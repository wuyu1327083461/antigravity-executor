/**
 * Tests for retry & complexity auto-escalation (REQ-01).
 *
 * The module's job is a single sentence, so the tests are written the way the
 * acceptance criteria read: "a second round that looks like rework must buy
 * pro, and nothing else must". Every rule of CONTRACT §7.4 gets its own block,
 * plus the edges that actually bite in production — an empty `task_spec`, a
 * session record that was never persisted, a target of `extra_high`, a profile
 * already sitting on `high`, and a creative turn with an explicit level.
 *
 * Two properties are asserted as hard invariants rather than as cases:
 *   - the decision never throws, whatever garbage arrives;
 *   - no escalation ever moves money — the module must not consult quota, which
 *     is `applyQuotaFallback`'s job (rule 5).
 *
 * Run: node --test lib/escalation.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RETRY_SIGNAL_RE,
  detectRetrySignal,
  renderEscalation,
  shouldEscalate,
} from './escalation.js'

/** Config = the v0.8.0 defaults this module cares about. */
const cfgWith = (overrides = {}) => ({ autoEscalateOnRetry: true, ...overrides })

/** A session record that has already completed one turn on the same thread. */
const REUSED_SESSION = { turn_count: 1 }
/** The same thread, but the previous round settled badly. */
const FAILED_SESSION = { turn_count: 1, lastTurnFailed: true }

/** The verbatim shape from the contract, used by several assertions. */
const RETRY_ANSWER = {
  escalate: true,
  from: 'flash',
  to: 'pro',
  reason: 'retry',
}

// ---------------------------------------------------------------------------
// RETRY_SIGNAL_RE (the regex is a product constant: it is quoted by the contract)
// ---------------------------------------------------------------------------

test('RETRY_SIGNAL_RE matches the English and Chinese rework vocabulary', () => {
  const hits = [
    'please fix the failing test',
    'failed again in lib/quota.js',
    'there is an error on startup',
    'the build is broken',
    'regression from the last commit',
    'retry the whole thing',
    'it still not working',
    '这里报错了，再看一下',
    '上一次失败的地方',
    '测试未通过',
    '上次没改对',
    '需要返工',
    '修复这个并发问题',
  ]
  for (const spec of hits) {
    // A fresh `lastIndex` check: the regex must not be a stateful `g` one, or
    // the second call below would silently miss.
    assert.equal(RETRY_SIGNAL_RE.test(spec), true, `expected a match for: ${spec}`)
    assert.equal(RETRY_SIGNAL_RE.test(spec), true, `expected a stable match for: ${spec}`)
    assert.equal(detectRetrySignal({ taskSpec: spec, reusedSession: true }), true)
  }
})

test('RETRY_SIGNAL_RE ignores words that merely contain a marker', () => {
  const misses = ['add a prefix to the logger', 'prefixes are fine', '后缀处理', 'fixup helper name']
  for (const spec of misses) {
    assert.equal(RETRY_SIGNAL_RE.test(spec), false, `unexpected match for: ${spec}`)
  }
})

// ---------------------------------------------------------------------------
// detectRetrySignal — trigger A, both halves required
// ---------------------------------------------------------------------------

test('detectRetrySignal needs a reused session', () => {
  // First turn on a bug report is a normal delegation, not a rework round.
  assert.equal(detectRetrySignal({ taskSpec: '修复这个 bug' }), false)
  assert.equal(detectRetrySignal({ taskSpec: '修复这个 bug', turnCount: 0 }), false)
  assert.equal(detectRetrySignal({ taskSpec: '修复这个 bug', reusedSession: false }), false)
  // An explicit `false` from the caller beats a stale counter.
  assert.equal(
    detectRetrySignal({ taskSpec: '修复这个 bug', reusedSession: false, turnCount: 5 }),
    false,
  )
  // The counter alone is enough when the caller has no own verdict.
  assert.equal(detectRetrySignal({ taskSpec: '修复这个 bug', turnCount: 1 }), true)
  assert.equal(detectRetrySignal({ taskSpec: '修复这个 bug', reusedSession: true }), true)
})

test('detectRetrySignal needs a reason to believe flash failed again', () => {
  const clean = 'refactor the quota guard'
  assert.equal(detectRetrySignal({ taskSpec: clean, turnCount: 1 }), false)
  // A failed settlement is evidence enough on its own.
  assert.equal(detectRetrySignal({ taskSpec: clean, turnCount: 1, lastTurnFailed: true }), true)
  // So is rework wording.
  assert.equal(detectRetrySignal({ taskSpec: 'fix the build', turnCount: 1 }), true)
})

test('detectRetrySignal normalises stringified turn counts', () => {
  assert.equal(detectRetrySignal({ taskSpec: 'fix it', turnCount: '2' }), true)
  assert.equal(detectRetrySignal({ taskSpec: 'fix it', turnCount: '0' }), false)
  assert.equal(detectRetrySignal({ taskSpec: 'fix it', turnCount: 'n/a' }), false)
})

test('detectRetrySignal treats an empty or non-string task_spec as no signal', () => {
  assert.equal(detectRetrySignal({ taskSpec: '', turnCount: 1 }), false)
  assert.equal(detectRetrySignal({ taskSpec: undefined, turnCount: 1 }), false)
  assert.equal(detectRetrySignal({ taskSpec: null, turnCount: 1 }), false)
  assert.equal(detectRetrySignal({ taskSpec: 42, turnCount: 1 }), false)
  assert.equal(detectRetrySignal({ taskSpec: ['fix'], turnCount: 1 }), false)
})

test('detectRetrySignal survives a missing or hostile argument object', () => {
  for (const bad of [undefined, null, {}, [], 'nope', 0, false]) {
    assert.equal(detectRetrySignal(bad), false)
  }
  const hostile = {
    get taskSpec() {
      throw new Error('boom')
    },
    turnCount: 1,
  }
  assert.equal(detectRetrySignal(hostile), false)
})

// ---------------------------------------------------------------------------
// shouldEscalate — rule 1: an explicit thinking_level is never overruled
// ---------------------------------------------------------------------------

test('rule 1: an explicit thinking_level blocks escalation', () => {
  // Every level spelling, including one that does not parse: rule 1 is about who
  // decided, so an unknown explicit value also wins.
  for (const explicitLevel of ['minimal', 'low', 'medium', 'high', 'extra_high', 'Flash', 'bogus']) {
    assert.deepEqual(
      shouldEscalate({
        explicitLevel,
        configuredLevel: 'medium',
        effectiveMode: 'creative',
        session: FAILED_SESSION,
        taskSpec: '修复登录',
        config: cfgWith(),
      }),
      { escalate: false },
      `explicit level ${explicitLevel} must not be escalated`,
    )
  }
})

test('rule 1: an empty explicit level counts as absent', () => {
  const base = {
    configuredLevel: 'medium',
    session: FAILED_SESSION,
    taskSpec: '修复登录',
    config: cfgWith(),
  }
  for (const explicitLevel of [undefined, null, '', '   ']) {
    assert.equal(shouldEscalate({ ...base, explicitLevel }).escalate, true)
  }
})

test('rule 1 + creative: an explicit level still blocks the complexity trigger', () => {
  assert.deepEqual(
    shouldEscalate({
      explicitLevel: 'medium',
      configuredLevel: 'medium',
      effectiveMode: 'creative',
      session: undefined,
      taskSpec: '做一个三维便利店场景',
      config: cfgWith(),
    }),
    { escalate: false },
  )
})

// ---------------------------------------------------------------------------
// shouldEscalate — rule 2: creative mode escalates as 'complexity'
// ---------------------------------------------------------------------------

test('rule 2: creative mode escalates on the very first turn as complexity', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    effectiveMode: 'creative',
    session: undefined,
    taskSpec: '做一个三维便利店场景',
    config: cfgWith(),
  })
  assert.equal(decision.escalate, true)
  assert.equal(decision.from, 'flash')
  assert.equal(decision.to, 'pro')
  assert.equal(decision.reason, 'complexity')
  assert.equal(typeof decision.detail, 'string')
  assert.ok(decision.detail.length > 0)
  assert.equal(renderEscalation(decision), 'escalated: flash -> pro (complexity escalation)')
})

test('rule 2: mode matching is case and whitespace insensitive', () => {
  for (const mode of ['creative', 'CREATIVE', ' Creative ']) {
    const decision = shouldEscalate({ configuredLevel: 'medium', effectiveMode: mode })
    assert.equal(decision.reason, 'complexity', `mode ${JSON.stringify(mode)}`)
  }
  assert.deepEqual(shouldEscalate({ configuredLevel: 'medium', effectiveMode: 'surgical' }), {
    escalate: false,
  })
})

// ---------------------------------------------------------------------------
// shouldEscalate — rule 3: retry detection
// ---------------------------------------------------------------------------

test('rule 3: a reused failing session escalates as retry', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    effectiveMode: 'surgical',
    session: FAILED_SESSION,
    taskSpec: 'refactor the quota guard',
    config: cfgWith(),
  })
  assert.equal(decision.escalate, true)
  assert.equal(decision.reason, 'retry')
  assert.equal(decision.from, 'flash')
  assert.equal(decision.to, 'pro')
  assert.equal(renderEscalation(decision), 'escalated: flash -> pro (retry escalation)')
})

test('rule 3: rework wording escalates a reused session even when it settled ok', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    session: REUSED_SESSION,
    taskSpec: '还是报错，继续修',
    config: cfgWith(),
  })
  assert.equal(decision.escalate, true)
  assert.equal(decision.reason, 'retry')
})

test('rule 3: the persisted record is enough (turn_count, no reusedSession flag)', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    session: { turn_count: 3, lastTurnFailed: true },
    taskSpec: '任何任务',
    config: cfgWith(),
  })
  assert.equal(decision.escalate, true)
  assert.equal(decision.reason, 'retry')
})

test('rule 3: a first turn on a clean task stays on flash', () => {
  assert.deepEqual(
    shouldEscalate({
      configuredLevel: 'medium',
      effectiveMode: 'surgical',
      session: { turn_count: 0 },
      taskSpec: 'add a unit test for the pacer',
      config: cfgWith(),
    }),
    { escalate: false },
  )
})

test('rule 3: an undefined session does not escalate a clean first turn', () => {
  assert.deepEqual(
    shouldEscalate({ configuredLevel: 'medium', taskSpec: 'add a log line' }),
    { escalate: false },
  )
  // ...but creative still does, independently of any session state.
  assert.equal(
    shouldEscalate({ configuredLevel: 'medium', effectiveMode: 'creative' }).reason,
    'complexity',
  )
})

test('rule 3: retry wins over complexity when both apply', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    effectiveMode: 'creative',
    session: FAILED_SESSION,
    taskSpec: '场景还是报错，重做',
    config: cfgWith(),
  })
  assert.equal(decision.reason, 'retry')
})

test('rule 3: the detail line names the target tier in Chinese', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    session: FAILED_SESSION,
    taskSpec: 'fix it',
    config: cfgWith(),
  })
  assert.match(decision.detail, /pro/)
  assert.match(decision.detail, /配额/)
})

// ---------------------------------------------------------------------------
// shouldEscalate — rule 4: target level from config, and only ever move up
// ---------------------------------------------------------------------------

test('rule 4: the target defaults to high when the key is absent', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    session: FAILED_SESSION,
    config: {},
  })
  assert.equal(decision.escalate, true)
  assert.equal(decision.to, 'pro')

  // No config at all behaves identically.
  const bare = shouldEscalate({ configuredLevel: 'medium', session: FAILED_SESSION })
  assert.equal(bare.to, 'pro')
  assert.equal(bare.reason, 'retry')
})

test('rule 4: retryEscalationLevel extra_high is accepted and still maps to pro', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    session: FAILED_SESSION,
    taskSpec: 'fix the failing build',
    config: cfgWith({ retryEscalationLevel: 'extra_high' }),
  })
  assert.equal(decision.escalate, true)
  assert.equal(decision.from, 'flash')
  assert.equal(decision.to, 'pro')
  assert.equal(renderEscalation(decision), 'escalated: flash -> pro (retry escalation)')
})

test('rule 4: an unknown retryEscalationLevel degrades to high', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    session: FAILED_SESSION,
    config: cfgWith({ retryEscalationLevel: 'turbo' }),
  })
  assert.equal(decision.to, 'pro')
})

test('rule 4: a level already at the target is not escalated', () => {
  // high == the default target: nothing to buy.
  assert.deepEqual(
    shouldEscalate({
      configuredLevel: 'high',
      session: FAILED_SESSION,
      taskSpec: 'fix it',
      config: cfgWith(),
    }),
    { escalate: false },
  )
  // extra_high is above high: still nothing.
  assert.deepEqual(
    shouldEscalate({
      configuredLevel: 'extra_high',
      effectiveMode: 'creative',
      session: FAILED_SESSION,
      config: cfgWith(),
    }),
    { escalate: false },
  )
  // ...and with an extra_high target, an exactly-high profile is also a no-op:
  // `high` and `extra_high` are the same `pro` tier, so there is nothing to buy
  // (and a report line would otherwise read `escalated: pro -> pro`).
  assert.deepEqual(
    shouldEscalate({
      configuredLevel: 'high',
      session: FAILED_SESSION,
      config: cfgWith({ retryEscalationLevel: 'extra_high' }),
    }),
    { escalate: false },
  )
})

test('rule 4: a below-default configured level is escalated by tier, not by name', () => {
  const decision = shouldEscalate({
    configuredLevel: 'low',
    session: FAILED_SESSION,
    config: cfgWith(),
  })
  assert.equal(decision.escalate, true)
  assert.equal(decision.from, 'flash_lite')
  assert.equal(decision.to, 'pro')
})

test('rule 4: an unknown configured level degrades to the documented default', () => {
  const decision = shouldEscalate({
    configuredLevel: 'super-fast',
    session: FAILED_SESSION,
    config: cfgWith(),
  })
  assert.equal(decision.escalate, true)
  assert.equal(decision.from, 'flash')
})

test('rule 4: autoEscalateOnRetry false disables both triggers', () => {
  for (const config of [cfgWith({ autoEscalateOnRetry: false }), { autoEscalateOnRetry: false }]) {
    assert.deepEqual(
      shouldEscalate({
        configuredLevel: 'medium',
        session: FAILED_SESSION,
        taskSpec: '修复',
        config,
      }),
      { escalate: false },
    )
    assert.deepEqual(
      shouldEscalate({ configuredLevel: 'medium', effectiveMode: 'creative', config }),
      { escalate: false },
    )
  }
  // Absent key means ON, so a v0.7.0 profile keeps the new behaviour.
  assert.equal(
    shouldEscalate({ configuredLevel: 'medium', effectiveMode: 'creative', config: {} }).escalate,
    true,
  )
})

// ---------------------------------------------------------------------------
// shouldEscalate — rule 5: quota is somebody else's decision
// ---------------------------------------------------------------------------

test('rule 5: the decision never consults quota', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    session: FAILED_SESSION,
    taskSpec: 'fix it',
    // A nearly-empty pool and an enabled guard: still a plain "yes, escalate".
    quota: { tiers: [], buckets: [] },
    config: cfgWith({ quotaFallback: { enabled: true, proMinFraction: 0.05 } }),
  })
  assert.deepEqual(Object.keys(decision).sort(), ['detail', 'escalate', 'from', 'reason', 'to'])
  assert.equal(decision.escalate, true)
  // No tier decision is returned: `index.js` applies `applyQuotaFallback` after.
  assert.equal('tier' in decision, false)
  assert.equal('downgraded' in decision, false)
})

// ---------------------------------------------------------------------------
// shouldEscalate — the "never throws" invariant
// ---------------------------------------------------------------------------

test('shouldEscalate never throws on garbage input', () => {
  const garbage = [
    undefined,
    null,
    {},
    [],
    'nonsense',
    0,
    false,
    { config: null, session: null, taskSpec: null },
    { config: 'not-an-object', session: 'not-an-object', taskSpec: 12 },
    { configuredLevel: 42, effectiveMode: 42, session: [], config: [] },
  ]
  for (const input of garbage) {
    let decision
    assert.doesNotThrow(() => {
      decision = shouldEscalate(input)
    }, `input: ${JSON.stringify(input)}`)
    assert.equal(decision.escalate, false)
  }
})

test('shouldEscalate never throws on hostile getters', () => {
  const hostile = {
    get config() {
      throw new Error('boom')
    },
  }
  assert.deepEqual(shouldEscalate(hostile), { escalate: false })

  const hostileSession = {
    configuredLevel: 'medium',
    get session() {
      throw new Error('boom')
    },
  }
  assert.deepEqual(shouldEscalate(hostileSession), { escalate: false })
})

test('shouldEscalate returns a fresh object each call', () => {
  const first = shouldEscalate({ configuredLevel: 'high' })
  first.escalate = true
  assert.equal(shouldEscalate({ configuredLevel: 'high' }).escalate, false)
})

// ---------------------------------------------------------------------------
// renderEscalation
// ---------------------------------------------------------------------------

test('renderEscalation prints the contract line verbatim', () => {
  assert.equal(
    renderEscalation({ escalate: true, from: 'flash', to: 'pro', reason: 'retry' }),
    'escalated: flash -> pro (retry escalation)',
  )
  assert.equal(
    renderEscalation({ escalate: true, from: 'flash', to: 'pro', reason: 'complexity' }),
    'escalated: flash -> pro (complexity escalation)',
  )
})

test('renderEscalation returns undefined when nothing escalated', () => {
  for (const decision of [
    { escalate: false },
    { escalate: false, from: 'flash', to: 'pro' },
    undefined,
    null,
    'nope',
    42,
    [],
  ]) {
    assert.equal(renderEscalation(decision), undefined, `decision: ${String(decision)}`)
  }
})

test('renderEscalation refuses to print a half-answer', () => {
  assert.equal(renderEscalation({ escalate: true, from: 'flash' }), undefined)
  assert.equal(renderEscalation({ escalate: true, to: 'pro' }), undefined)
  assert.equal(renderEscalation({ escalate: true, from: 'flash', to: 'warp' }), undefined)
})

test('renderEscalation accepts level names as well as tier names', () => {
  // `index.js` may hand over a decision assembled from levels rather than tiers.
  assert.equal(
    renderEscalation({ escalate: true, from: 'medium', to: 'high', reason: 'retry' }),
    'escalated: flash -> pro (retry escalation)',
  )
  assert.equal(
    renderEscalation({ escalate: true, from: 'flash_lite', to: 'pro', reason: 'complexity' }),
    'escalated: flash_lite -> pro (complexity escalation)',
  )
})

test('renderEscalation tolerates an unexpected reason', () => {
  assert.equal(
    renderEscalation({ escalate: true, from: 'flash', to: 'pro' }),
    'escalated: flash -> pro (retry/complexity escalation)',
  )
  assert.equal(
    renderEscalation({ escalate: true, from: 'flash', to: 'pro', reason: 'quota' }),
    'escalated: flash -> pro (retry/complexity escalation)',
  )
})

test('renderEscalation never throws', () => {
  const hostile = {
    escalate: true,
    get from() {
      throw new Error('boom')
    },
  }
  assert.equal(renderEscalation(hostile), undefined)
})

// ---------------------------------------------------------------------------
// the two exports work together the way index.js will use them
// ---------------------------------------------------------------------------

test('the report line is a function of the decision only', () => {
  const decision = shouldEscalate({
    configuredLevel: 'medium',
    session: REUSED_SESSION,
    taskSpec: '测试还是失败，继续修',
    config: cfgWith(),
  })
  assert.deepEqual(decision, {
    ...RETRY_ANSWER,
    detail: decision.detail,
  })
  assert.equal(renderEscalation(decision), 'escalated: flash -> pro (retry escalation)')
})
