/**
 * Tests for the in-process serial mutex (REQ-02).
 *
 * The queue exists because a host model can emit several `delegate_coding_task`
 * calls in one reply. The acceptance case is therefore written the way the bug
 * happened: two bodies dispatched together must produce the strictly ordered log
 * `A:start, A:end, B:start, B:end`, and the second one's start must not predate
 * the first one's finish. Everything else here guards the two ways a lock like
 * this goes wrong in production: a rejected body welding the queue shut, and a
 * bad call corrupting the counters.
 *
 * Run: node --test lib/queue.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createSerialQueue, renderQueue } from './queue.js'

/** A queue plus a controllable monotonic clock, so ordering is asserted on ms. */
function makeQueue({ clock = 1_000 } = {}) {
  let current = clock
  const advance = (ms) => {
    current += ms
    return current
  }
  const queue = createSerialQueue({ now: () => current })
  return { queue, now: () => current, advance }
}

// ---------------------------------------------------------------------------
// REQ-02 acceptance: strict FIFO
// ---------------------------------------------------------------------------

test('two bodies dispatched together still run one at a time, in dispatch order', async () => {
  const { queue, now } = makeQueue()
  const events = []
  const startedAt = []
  const finishedAt = []

  const A = async () => {
    events.push('A:start')
    startedAt.push(now())
    await delay(5)
    events.push('A:end')
    finishedAt.push(now())
    return 'a'
  }
  const B = async () => {
    events.push('B:start')
    startedAt.push(now())
    await delay(5)
    events.push('B:end')
    finishedAt.push(now())
    return 'b'
  }

  const results = await Promise.all([queue.run(A), queue.run(B)])

  assert.deepEqual(results, ['a', 'b'])
  assert.deepEqual(events, ['A:start', 'A:end', 'B:start', 'B:end'])
  assert.ok(startedAt[1] >= finishedAt[0], 'B must not start before A finished')
})

test('a body that never yields to the event loop still cannot be interleaved', async () => {
  const { queue } = makeQueue()
  const events = []

  // A synchronous body: no await at all. A naive "did it await?" implementation
  // would let B start on the next microtask.
  const A = () => {
    events.push('A:start')
    events.push('A:end')
    return Promise.resolve('a')
  }
  const B = async () => {
    events.push('B:start')
    events.push('B:end')
    return 'b'
  }

  await Promise.all([queue.run(A), queue.run(B)])
  assert.deepEqual(events, ['A:start', 'A:end', 'B:start', 'B:end'])
})

test('three bodies queue in dispatch order', async () => {
  const { queue } = makeQueue()
  const events = []
  const body = (name) => async () => {
    events.push(`${name}:start`)
    await delay(1)
    events.push(`${name}:end`)
    return name
  }

  const results = await Promise.all([queue.run(body('A')), queue.run(body('B')), queue.run(body('C'))])

  assert.deepEqual(results, ['A', 'B', 'C'])
  assert.deepEqual(events, [
    'A:start',
    'A:end',
    'B:start',
    'B:end',
    'C:start',
    'C:end',
  ])
})

test('a slow first body delays the next one by exactly its runtime', async () => {
  const { queue, now } = makeQueue()
  const marks = []

  const A = async () => {
    marks.push(['A:start', now()])
    await delay(20)
    marks.push(['A:end', now()])
  }
  const B = async () => {
    marks.push(['B:start', now()])
  }

  await Promise.all([queue.run(A), queue.run(B)])
  // Each entry is `[label, timestamp]`; ignore the label position.
  const [[, aEnd], [, bStart]] = [marks[1], marks[2]]
  assert.ok(bStart >= aEnd)
})

// ---------------------------------------------------------------------------
// failure isolation
// ---------------------------------------------------------------------------

test('a rejected body does not stop the next body, and only its own caller sees the error', async () => {
  const { queue } = makeQueue()
  const events = []

  const failing = async () => {
    events.push('A:start')
    await delay(1)
    events.push('A:throw')
    throw new Error('delegation exploded')
  }
  const working = async () => {
    events.push('B:start')
    events.push('B:end')
    return 'ok'
  }

  const a = queue.run(failing)
  const b = queue.run(working)

  await assert.rejects(a, /delegation exploded/)
  assert.equal(await b, 'ok')
  assert.deepEqual(events, ['A:start', 'A:throw', 'B:start', 'B:end'])
})

test('a synchronously throwing body is contained the same way', async () => {
  const { queue } = makeQueue()
  const a = queue.run(() => {
    throw new Error('sync boom')
  })
  const b = queue.run(async () => 'fine')

  await assert.rejects(a, /sync boom/)
  assert.equal(await b, 'fine')
})

test('a rejection is counted as settled, not as an outage', async () => {
  const { queue } = makeQueue()
  await assert.rejects(queue.run(async () => Promise.reject(new Error('x'))), /x/)
  await queue.run(async () => undefined)
  assert.equal(queue.status().completed, 2)
  assert.equal(queue.status().queued, 0)
  assert.equal(queue.status().running, false)
})

test('every queued body rejects for itself when all of them fail', async () => {
  const { queue } = makeQueue()
  const results = await Promise.allSettled([
    queue.run(async () => {
      throw new Error('one')
    }),
    queue.run(async () => {
      throw new Error('two')
    }),
  ])

  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'rejected')
  assert.match(results[0].reason.message, /one/)
  assert.match(results[1].reason.message, /two/)
  assert.equal(queue.status().completed, 2)
})

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

test('status reports running, waiting and settled counts while a body is in flight', async () => {
  const { queue, advance } = makeQueue()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })

  const first = queue.run(async () => {
    await gate
    return 'a'
  })
  const second = queue.run(async () => 'b')

  // Let the first body reach its await.
  await delay(0)
  advance(1_500)
  const busy = queue.status()
  assert.equal(busy.running, true)
  assert.equal(busy.queued, 1, 'the waiting body is counted but the running one is not')
  assert.equal(busy.completed, 0)
  assert.equal(typeof busy.currentStartedAt, 'number')
  assert.equal(busy.lastFinishedAt, undefined)

  release()
  assert.equal(await first, 'a')
  assert.equal(await second, 'b')

  const settled = queue.status()
  assert.equal(settled.running, false)
  assert.equal(settled.queued, 0)
  assert.equal(settled.completed, 2)
  assert.equal(typeof settled.lastFinishedAt, 'number')
})

test('status is a snapshot, not a live view of the queue internals', async () => {
  const { queue } = makeQueue()
  const snapshot = queue.status()
  await queue.run(async () => 'x')
  assert.equal(snapshot.completed, 0, 'the earlier snapshot must not change')
  assert.equal(queue.status().completed, 1)
})

test('currentStartedAt and lastFinishedAt come from the injected clock', async () => {
  const { queue, now } = makeQueue({ clock: 5_000 })
  const at = now()
  await queue.run(async () => 'x')
  const state = queue.status()
  assert.equal(state.currentStartedAt, at)
  assert.equal(state.lastFinishedAt, at)
})

test('reset clears every counter so a test can start clean', async () => {
  const { queue } = makeQueue()
  await queue.run(async () => 'x')
  queue.reset()
  assert.deepEqual(queue.status(), {
    running: false,
    queued: 0,
    completed: 0,
    currentStartedAt: undefined,
    lastFinishedAt: undefined,
  })
  // Still usable afterwards.
  assert.equal(await queue.run(async () => 'y'), 'y')
})

// ---------------------------------------------------------------------------
// bad arguments
// ---------------------------------------------------------------------------

test('run rejects a non-function argument with a clear TypeError', () => {
  const { queue } = makeQueue()
  for (const bad of [undefined, null, 42, 'nope', {}, []]) {
    assert.throws(() => queue.run(bad), TypeError)
  }
})

test('a bad argument leaves the queue usable and its counters untouched', async () => {
  const { queue } = makeQueue()
  assert.throws(() => queue.run(null), TypeError)
  assert.throws(() => queue.run('delegate_coding_task'), /需要一个函数/)

  assert.deepEqual(queue.status(), {
    running: false,
    queued: 0,
    completed: 0,
    currentStartedAt: undefined,
    lastFinishedAt: undefined,
  })

  // The chain must not have been left in a rejected state by the throw.
  assert.equal(await queue.run(async () => 'still works'), 'still works')
  assert.equal(queue.status().completed, 1)
})

// ---------------------------------------------------------------------------
// renderQueue()
// ---------------------------------------------------------------------------

test('renderQueue shows an idle queue and its settled count', () => {
  assert.equal(
    renderQueue({ running: false, queued: 0, completed: 3 }),
    'queue        : idle (0 waiting, 3 settled)',
  )
})

test('renderQueue shows a busy queue with what is waiting', () => {
  const now = 10_000
  const line = renderQueue(
    { running: true, queued: 2, completed: 1, currentStartedAt: now - 4_500 },
    now,
  )
  assert.match(line, /^queue {8}: busy \(2 waiting, 1 settled, running 4\.5s\)$/)
})

test('renderQueue degrades instead of printing NaN for a malformed state', () => {
  assert.equal(renderQueue(), 'queue        : idle (0 waiting, 0 settled)')
  assert.equal(renderQueue(null), 'queue        : idle (0 waiting, 0 settled)')
  assert.equal(renderQueue({ queued: 'x', completed: -5 }), 'queue        : idle (0 waiting, 0 settled)')
  assert.match(renderQueue({ running: true }), /^queue {8}: busy \(0 waiting, 0 settled\)$/)
})

test('renderQueue matches the check_environment column width', () => {
  assert.match(renderQueue({ running: false }), /^queue {8}: /)
})
