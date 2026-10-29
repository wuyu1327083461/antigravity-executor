/**
 * Tests for the inter-turn pacer.
 *
 * The pacer exists to remove the "zero-think-time" signature from consecutive
 * delegations without slowing down any single turn, so the two properties that
 * matter are tested directly: a turn that just finished is followed by a delay
 * inside the configured band, and a turn that finished long ago is not delayed
 * at all.
 *
 * Run: node --test lib/pacing.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPacer, renderPacing } from './pacing.js'

const CFG = {
  pacing: {
    enabled: true,
    minGapSeconds: 15,
    jitterMinSeconds: 6,
    jitterMaxSeconds: 15,
  },
}

/** A pacer with a controllable clock, RNG and sleep. */
function makePacer({ clock = 1_000_000, random = () => 0.5, failSleep = false } = {}) {
  const slept = []
  let current = clock
  const pacer = createPacer({
    now: () => current,
    random,
    sleep: async (ms) => {
      if (failSleep) throw new Error('cancelled')
      slept.push(ms)
      current += ms
    },
  })
  return {
    pacer,
    slept,
    advance: (ms) => {
      current += ms
    },
    now: () => current,
  }
}

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

test('plan imposes no delay on the very first delegation', () => {
  const { pacer } = makePacer()
  assert.equal(pacer.plan(CFG).delayMs, 0)
})

test('plan is a no-op when pacing is disabled', () => {
  const { pacer, advance } = makePacer()
  pacer.noteTurnFinished()
  advance(100)
  const decision = pacer.plan({ pacing: { ...CFG.pacing, enabled: false } })
  assert.equal(decision.delayMs, 0)
})

test('plan is a no-op when the gap is already long enough', () => {
  const { pacer, advance } = makePacer()
  pacer.noteTurnFinished()
  advance(20_000)
  const decision = pacer.plan(CFG)
  assert.equal(decision.delayMs, 0)
  assert.equal(decision.sinceLastMs, 20_000)
})

test('plan tops the remaining floor up with jitter, so the total gap reaches the floor', () => {
  const { pacer, advance } = makePacer({ random: () => 0.5 })
  pacer.noteTurnFinished()
  advance(2_000) // 2s after the last turn: 13s of floor still owed.
  const decision = pacer.plan(CFG)

  // Jitter range is 6-15s; at random()=0.5 that is 10.5s.
  const jitter = 6_000 + 0.5 * (15_000 - 6_000)
  assert.equal(decision.delayMs, 13_000 + Math.round(jitter))
  assert.match(decision.reason, /上一轮结束仅 2\.0s/)
})

test('plan keeps the total gap inside [minGap, minGap + jitterMax]', () => {
  const cases = [
    { elapsed: 0, random: 0 },
    { elapsed: 0, random: 0.999 },
    { elapsed: 5_000, random: 0.25 },
    { elapsed: 14_000, random: 0.75 },
  ]
  for (const { elapsed, random } of cases) {
    const { pacer, advance } = makePacer({ random: () => random })
    pacer.noteTurnFinished()
    advance(elapsed)
    const { delayMs } = pacer.plan(CFG)
    const total = elapsed + delayMs
    assert.ok(total >= 15_000, `gap ${total}ms must reach the 15s floor`)
    assert.ok(total <= 15_000 + 15_000, `gap ${total}ms must not exceed floor+jitterMax`)
  }
})

test('plan draws different delays for different RNG values', () => {
  const a = makePacer({ random: () => 0 })
  a.pacer.noteTurnFinished()
  const b = makePacer({ random: () => 0.99 })
  b.pacer.noteTurnFinished()
  assert.notEqual(a.pacer.plan(CFG).delayMs, b.pacer.plan(CFG).delayMs)
})

test('plan uses documented defaults when the config omits the numbers', () => {
  const { pacer } = makePacer({ random: () => 0 })
  pacer.noteTurnFinished()
  // Defaults: floor 15s, jitter 6s (random()=0 -> the low end).
  assert.equal(pacer.plan({ pacing: { enabled: true } }).delayMs, 21_000)
})

test('plan tolerates a missing or malformed config', () => {
  const { pacer } = makePacer()
  pacer.noteTurnFinished()
  assert.equal(pacer.plan(undefined).delayMs, 0)
  assert.equal(pacer.plan({}).delayMs, 0)
  assert.equal(pacer.plan({ pacing: { enabled: false } }).delayMs, 0)
})

// ---------------------------------------------------------------------------
// waitForTurnStart()
// ---------------------------------------------------------------------------

test('waitForTurnStart sleeps exactly the planned delay', async () => {
  const { pacer, slept, advance } = makePacer({ random: () => 0 })
  pacer.noteTurnFinished()
  advance(1_000)
  const result = await pacer.waitForTurnStart(CFG)
  // 14s of floor owed + 6s low jitter.
  assert.equal(result.waitedMs, 20_000)
  assert.deepEqual(slept, [20_000])
})

test('waitForTurnStart does not sleep when nothing is owed', async () => {
  const { pacer, slept } = makePacer()
  const result = await pacer.waitForTurnStart(CFG)
  assert.deepEqual(result, { waitedMs: 0 })
  assert.deepEqual(slept, [])
})

test('waitForTurnStart survives a cancelled sleep', async () => {
  const { pacer, advance } = makePacer({ failSleep: true })
  pacer.noteTurnFinished()
  advance(500)
  const result = await pacer.waitForTurnStart(CFG)
  // A cancelled wait reports 0 waited rather than throwing: the caller's signal
  // handling is what decides the delegation's fate.
  assert.equal(result.waitedMs, 0)
  assert.match(result.reason, /冷却/)
})

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

test('noteTurnFinished records the clock, and reset forgets it', () => {
  const { pacer, now } = makePacer()
  pacer.noteTurnFinished()
  assert.deepEqual(pacer.status(), { lastTurnFinishedAt: now() })
  pacer.reset()
  assert.deepEqual(pacer.status(), { lastTurnFinishedAt: undefined })
})

test('a delegation started long after the last turn is never delayed twice', async () => {
  const { pacer, advance, slept } = makePacer({ random: () => 0 })
  pacer.noteTurnFinished()
  advance(60_000)
  assert.equal((await pacer.waitForTurnStart(CFG)).waitedMs, 0)
  pacer.noteTurnFinished() // that turn finished too
  advance(60_000)
  assert.equal((await pacer.waitForTurnStart(CFG)).waitedMs, 0)
  assert.deepEqual(slept, [])
})

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('renderPacing shows the configured band and the last gap', () => {
  const now = 1_000_000
  const line = renderPacing(CFG, { lastTurnFinishedAt: now - 4_500 }, now)
  assert.match(line, /min gap 15s \+ jitter 6-15s/)
  assert.match(line, /last turn ended 4\.5s ago/)
})

test('renderPacing copes with no previous turn and a disabled setting', () => {
  assert.match(renderPacing(CFG, {}, 1_000_000), /no turn yet/)
  assert.match(renderPacing({ pacing: { enabled: false } }), /off/)
})

test('renderPacing renders a single-valued jitter band without a range dash', () => {
  const cfg = { pacing: { enabled: true, minGapSeconds: 15, jitterMinSeconds: 8, jitterMaxSeconds: 8 } }
  assert.match(renderPacing(cfg, {}), /jitter 8s/)
})
