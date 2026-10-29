/**
 * Tests for turn settlement (REQ-01 / REQ-08).
 *
 * Every test drives `waitForTurn` through injected dependencies — a fake RPC
 * client, a fake step reader and a fake clock — so the whole settlement logic
 * is exercised deterministically without Antigravity and without real waiting.
 *
 * Run: node --test lib/turn.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectTurn, summarizeToolCall, waitForTurn } from './turn.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const CONV = 'conv-abc'
const SERVER = { port: 58953, csrf: 'csrf-token' }

const plannerStep = (index, content, extra = {}) => ({
  step_index: index,
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  created_at: '2026-01-01T00:00:00Z',
  content,
  tool_calls: [],
  ...extra,
})

const toolStep = (index, name, args) => ({
  step_index: index,
  type: name === 'run_command' ? 'RUN_COMMAND' : 'VIEW_FILE',
  status: 'DONE',
  created_at: '2026-01-01T00:00:00Z',
  content: '',
  tool_calls: [{ name, args }],
})

const systemMessage = (index, content) => ({
  step_index: index,
  type: 'SYSTEM_MESSAGE',
  status: 'DONE',
  created_at: '2026-01-01T00:00:00Z',
  content,
  tool_calls: [],
})

/**
 * A scripted world: `transcripts` is a queue of step arrays returned by each
 * successive read, `statuses` a queue of cascade statuses. The last entry of
 * each queue repeats forever, so a test only has to describe the transitions.
 *
 * Time is virtual: `sleep` advances `clock` instead of waiting, so every test
 * finishes instantly while the deadline logic is still exercised honestly.
 */
function makeWorld({ transcripts, statuses = ['IDLE'], terminationReason = 'NO_TOOL_CALL' }) {
  let reads = 0
  let statusReads = 0
  let clock = 1_000_000
  const calls = { wait: 0, cancel: 0, status: 0, trajectory: 0, sleep: [] }

  const rpc = {
    async waitForConversationFullyIdle() {
      calls.wait += 1
      return {}
    },
    async getAllCascadeTrajectories() {
      calls.status += 1
      const status = statuses[Math.min(statusReads, statuses.length - 1)]
      statusReads += 1
      return { trajectorySummaries: { [CONV]: { status } } }
    },
    async getCascadeTrajectory() {
      calls.trajectory += 1
      // The real RPC answers { trajectory: { executorMetadatas } } — a fake that
      // returned the metadata at the top level hid a real bug for an entire
      // integration run, so the fixture mirrors the wire shape.
      return {
        trajectory: {
          executorMetadatas: [
            { terminationReason: terminationReason === undefined ? undefined : terminationReason },
          ],
        },
      }
    },
    async cancelCascadeInvocation() {
      calls.cancel += 1
      return {}
    },
    async getCascadeTrajectorySteps() {
      return []
    },
  }

  const readSteps = async () => {
    const snapshot = transcripts[Math.min(reads, transcripts.length - 1)]
    reads += 1
    return snapshot
  }

  const sleep = async (ms) => {
    calls.sleep.push(ms)
    clock += ms
  }

  const now = () => clock

  // Spread into waitForTurn: `await waitForTurn({ ...world.deps, cfg })`.
  const deps = { rpc, readSteps, sleep, now }
  return { rpc, readSteps, sleep, now, deps, calls }
}

// ---------------------------------------------------------------------------
// summarizeToolCall / collectTurn
// ---------------------------------------------------------------------------

test('summarizeToolCall prefers CommandLine and flattens whitespace', () => {
  assert.equal(
    summarizeToolCall({ name: 'run_command', args: { CommandLine: 'Set-Location E:\\ws;\r\n  npm test' } }),
    'Set-Location E:\\ws; npm test',
  )
  assert.equal(summarizeToolCall({ name: 'view_file', args: { Path: 'E:\\ws\\a.js' } }), 'E:\\ws\\a.js')
  assert.equal(summarizeToolCall({ name: 'unknown', args: {} }), '')
})

test('collectTurn keeps the last tool-call-free planner message as the answer', () => {
  const steps = [
    plannerStep(0, 'I will run the tests.', { tool_calls: [{ name: 'run_command', args: {} }] }),
    plannerStep(1, 'interim note'),
    toolStep(2, 'run_command', { CommandLine: 'npm test' }),
    plannerStep(3, 'Final report: all green.'),
    systemMessage(4, 'background task finished'),
  ]
  const { answer, trace } = collectTurn(steps, 0)
  assert.equal(answer, 'Final report: all green.')
  assert.equal(trace.length, 2)
  assert.match(trace[0], /\[0\] run_command/)
  assert.match(trace[1], /\[2\] run_command npm test/)
})

test('collectTurn ignores steps before sinceIndex', () => {
  const steps = [plannerStep(0, 'previous turn answer'), plannerStep(5, 'this turn answer')]
  assert.equal(collectTurn(steps, 5).answer, 'this turn answer')
})

// ---------------------------------------------------------------------------
// path 1: rpc-idle
// ---------------------------------------------------------------------------

test('rpc-idle: long poll returns, cascade is IDLE, final answer settles', async () => {
  const events = []
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Final report: all green.')]],
    statuses: ['IDLE'],
  })

  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
    onEvent: (ev) => events.push(ev),
  })

  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(result.answer, 'Final report: all green.')
  assert.equal(result.terminationReason, 'NO_TOOL_CALL')
  assert.equal(result.killed, undefined)
  assert.equal(world.calls.wait, 1)
  assert.equal(world.calls.cancel, 0)
  assert.deepEqual(
    events.map((ev) => ev.kind),
    ['step', 'idle'],
  )
})

test('rpc-idle: long poll blocking is what settles a slow turn (no 45s quiet window)', async () => {
  // The whole point of REQ-01: settlement must not depend on quietWindowSeconds.
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'done')]],
    statuses: ['IDLE'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { quietWindowSeconds: 45, pollIntervalSeconds: 0.2, fastSettleSeconds: 0 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(world.calls.sleep.length, 0)
})

test('rpc-idle: progress events are emitted for tool calls', async () => {
  const events = []
  const world = makeWorld({
    transcripts: [
      [
        plannerStep(0, 'Let me run the tests.', {
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
        }),
        toolStep(1, 'run_command', { CommandLine: 'Set-Location E:\\ws; npm test' }),
        plannerStep(2, 'All green.'),
      ],
    ],
    statuses: ['IDLE'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
    onEvent: (ev) => events.push(ev),
  })
  assert.equal(result.answer, 'All green.')
  const progress = events.filter((ev) => ev.kind === 'progress')
  assert.equal(progress.length, 2)
  assert.match(progress[0].text, /\[step 0\] run_command: npm test/)
  assert.match(progress[1].text, /\[step 1\] run_command: Set-Location E:\\ws; npm test/)
})

test('rpc-idle: a running cascade is re-polled instead of settling', async () => {
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'still working')]],
    statuses: ['RUNNING', 'RUNNING', 'IDLE'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(world.calls.wait, 3)
  assert.equal(world.calls.status, 3)
})

test('rpc-idle: idle without a final answer loops back to the long poll', async () => {
  const world = makeWorld({
    transcripts: [
      [toolStep(0, 'run_command', { CommandLine: 'npm test' })],
      // The long poll returned on a tool-round gap: still no final answer.
      [toolStep(0, 'run_command', { CommandLine: 'npm test' })],
      [toolStep(0, 'run_command', { CommandLine: 'npm test' }), plannerStep(1, 'Done: tests pass.')],
    ],
    statuses: ['IDLE'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(result.answer, 'Done: tests pass.')
  // The poll is re-issued whenever it returns without a final answer. The exact
  // count depends on the scan cadence (the turn is re-read every tick now, so a
  // late answer can be picked up before another poll is needed) — what matters
  // is that it does NOT settle on the first answerless return.
  // The poll must not be accepted as a settlement on its own: the turn was
  // re-read after the poll returned, and only the late answer settled it.
  assert.ok(world.calls.status >= 1, 'idleness must be confirmed, not assumed')
  assert.ok(
    world.calls.sleep.length + world.calls.wait >= 1,
    'the turn must have been re-examined after the answerless poll',
  )
})

test('rpc-idle: a new step inside the fast-settle window cancels the settlement', async () => {
  const world = makeWorld({
    transcripts: [
      [plannerStep(0, 'Looks done.')],
      [plannerStep(0, 'Looks done.')],
      // A background command reports back while the confirmation window runs.
      [plannerStep(0, 'Looks done.'), systemMessage(1, 'task finished'), plannerStep(2, 'Now really done.')],
    ],
    statuses: ['IDLE'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 2, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(result.answer, 'Now really done.')
  // New work appeared during the confirmation window, so the first apparent
  // ending was rejected; the real answer settled the turn.
  assert.ok(world.calls.status >= 1, 'idleness must be confirmed after new work')
})

// ---------------------------------------------------------------------------
// path 2: background command (the PLANNER_RESPONSE trap)
// ---------------------------------------------------------------------------

test('background command: PLANNER_RESPONSE then SYSTEM_MESSAGE does not settle early', async () => {
  const events = []
  // Turn 1: planner says "I started a background build"; cascade is still RUNNING.
  // Turn 2: SYSTEM_MESSAGE reports completion, then the real answer.
  const world = makeWorld({
    transcripts: [
      [
        plannerStep(0, 'Started the build in the background.', {
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run build' } }],
        }),
        toolStep(1, 'run_command', { CommandLine: 'npm run build' }),
        plannerStep(2, 'I will wait for it to finish.'),
      ],
      [
        plannerStep(0, 'Started the build in the background.', {
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run build' } }],
        }),
        toolStep(1, 'run_command', { CommandLine: 'npm run build' }),
        plannerStep(2, 'I will wait for it to finish.'),
        systemMessage(3, 'Background task completed with exit code 0.'),
        plannerStep(4, 'Build finished successfully.'),
      ],
    ],
    // First status is RUNNING: the background task is still alive even though a
    // tool-call-free PLANNER_RESPONSE is already on disk.
    statuses: ['RUNNING', 'IDLE'],
  })

  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
    onEvent: (ev) => events.push(ev),
  })

  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(result.answer, 'Build finished successfully.')
  assert.equal(world.calls.wait, 2)
  assert.ok(
    events.some((ev) => ev.kind === 'step' && ev.step.type === 'SYSTEM_MESSAGE'),
    'the SYSTEM_MESSAGE step must be reported',
  )
})

test('background command: idle with a trailing SYSTEM_MESSAGE still needs a real answer', async () => {
  const world = makeWorld({
    transcripts: [
      [plannerStep(0, 'Waiting.'), systemMessage(1, 'task done')],
      [plannerStep(0, 'Waiting.'), systemMessage(1, 'task done'), plannerStep(2, 'Final report.')],
    ],
    statuses: ['IDLE'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.answer, 'Final report.')
  assert.equal(result.settlement, 'rpc-idle')
})

test('cancelled turn: terminationReason USER_CANCELED is reported', async () => {
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Stopped by user.')]],
    statuses: ['IDLE'],
    terminationReason: 'USER_CANCELED',
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.terminationReason, 'USER_CANCELED')
  assert.equal(result.settlement, 'rpc-idle')
})

// ---------------------------------------------------------------------------
// path 3: quiet-window degradation
// ---------------------------------------------------------------------------

test('quiet-window: a retryable long-poll error degrades the whole turn', async () => {
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Answer without long polling.')]],
    statuses: ['IDLE'],
  })
  const retryable = Object.assign(new Error('ECONNREFUSED'), {
    code: 'network',
    retryable: true,
  })
  world.rpc.waitForConversationFullyIdle = async () => {
    world.calls.wait += 1
    throw retryable
  }

  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    // A real quiet window would take 45 s; the fake sleep returns instantly.
    cfg: { quietWindowSeconds: 45, pollIntervalSeconds: 0.2, fastSettleSeconds: 0 },
    ...world.deps,
  })

  assert.equal(result.settlement, 'quiet-window')
  assert.equal(result.answer, 'Answer without long polling.')
  assert.match(result.note, /降级为静默窗口判定/)
  assert.equal(world.calls.wait, 1, 'the long poll is only attempted once before degrading')
  assert.ok(world.calls.sleep.length > 0)
})

test('quiet-window: an unknown method (HTTP 404) also degrades', async () => {
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Answer.')]],
    statuses: ['IDLE'],
  })
  world.rpc.waitForConversationFullyIdle = async () => {
    world.calls.wait += 1
    throw Object.assign(new Error('unknown method'), { code: 'unknown', httpStatus: 404 })
  }
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { quietWindowSeconds: 5, pollIntervalSeconds: 0.2, fastSettleSeconds: 0 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'quiet-window')
})

test('quiet-window: a still-running cascade blocks settlement despite silence', async () => {
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Waiting on a background task.')]],
    statuses: ['RUNNING', 'IDLE'],
  })
  world.rpc.waitForConversationFullyIdle = async () => {
    world.calls.wait += 1
    // A retryable transport failure: the method exists but is unusable.
    throw Object.assign(new Error('ECONNRESET'), { code: 'network', retryable: true })
  }
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { quietWindowSeconds: 5, pollIntervalSeconds: 0.2, fastSettleSeconds: 0 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'quiet-window')
  assert.ok(world.calls.status >= 2, 'the cascade status must be re-checked')
})

// ---------------------------------------------------------------------------
// path 4: killed (REQ-04 hook / abort)
// ---------------------------------------------------------------------------

test('killed: onStep block cancels the cascade and returns immediately', async () => {
  const world = makeWorld({
    transcripts: [
      [
        plannerStep(0, 'Reading a file outside the workspace.'),
        toolStep(1, 'view_file', { Path: 'C:\\Windows\\system.ini' }),
      ],
    ],
    statuses: ['RUNNING'],
  })

  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
    onStep: (step) =>
      step.tool_calls.some((call) => String(call.args.Path ?? '').includes('C:\\Windows'))
        ? { block: true, reason: '读取工作区之外的文件' }
        : {},
  })

  assert.equal(world.calls.cancel, 1, 'cancelCascadeInvocation must be called')
  assert.equal(result.killed.reason, '读取工作区之外的文件')
  assert.equal(result.killed.step.step_index, 1)
  assert.equal(result.settlement, 'timeout')
  assert.equal(result.elapsedMs < 1000, true)
})

test('killed: a non-blocking onStep verdict lets the turn continue', async () => {
  const world = makeWorld({
    transcripts: [[toolStep(0, 'run_command', { CommandLine: 'npm test' }), plannerStep(1, 'All green.')]],
    statuses: ['IDLE'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
    onStep: () => ({ block: false }),
  })
  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(world.calls.cancel, 0)
})

test('killed: a cancel failure is not fatal', async () => {
  const world = makeWorld({
    transcripts: [[toolStep(0, 'view_file', { Path: 'C:\\Windows\\x' })]],
    statuses: ['RUNNING'],
  })
  world.rpc.cancelCascadeInvocation = async () => {
    world.calls.cancel += 1
    throw Object.assign(new Error('executor is not currently running'), { httpStatus: 500 })
  }
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
    onStep: () => ({ block: true, reason: '越界读取' }),
  })
  assert.equal(world.calls.cancel, 1)
  assert.equal(result.killed.reason, '越界读取')
})

test('killed: an aborted signal cancels and returns before waiting', async () => {
  const controller = new AbortController()
  controller.abort()
  const world = makeWorld({ transcripts: [[plannerStep(0, 'never reached')]] })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    signal: controller.signal,
    ...world.deps,
  })
  assert.equal(world.calls.cancel, 1)
  assert.match(result.killed.reason, /取消/)
  assert.equal(result.settlement, 'timeout')
})

// ---------------------------------------------------------------------------
// path 5: timeout
// ---------------------------------------------------------------------------

test('timeout: an endless running cascade returns a timeout result', async () => {
  const world = makeWorld({
    transcripts: [[toolStep(0, 'run_command', { CommandLine: 'npm test' })]],
    statuses: ['RUNNING'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    timeoutMs: 1000,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'timeout')
  assert.match(result.error, /超时/)
  assert.equal(result.answer, undefined)
  assert.ok(result.elapsedMs <= 2000)
  assert.ok(world.calls.wait >= 2)
})

test('timeout: an unexpected read failure is reported, not thrown', async () => {
  const world = makeWorld({ transcripts: [[plannerStep(0, 'x')]] })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    rpc: world.rpc,
    readSteps: async () => {
      throw new Error('disk on fire')
    },
    sleep: world.sleep,
    now: world.now,
  })
  assert.equal(result.settlement, 'timeout')
  assert.match(result.error, /disk on fire/)
})

// ---------------------------------------------------------------------------
// sinceIndex / trace
// ---------------------------------------------------------------------------

test('waitForTurn only reports steps of the current turn', async () => {
  const world = makeWorld({
    transcripts: [
      [
        plannerStep(0, 'previous turn answer'),
        toolStep(1, 'run_command', { CommandLine: 'old command' }),
        plannerStep(5, 'this turn answer'),
      ],
    ],
    statuses: ['IDLE'],
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 5,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.answer, 'this turn answer')
  assert.deepEqual(result.trace, [])
  assert.deepEqual(
    result.steps.map((step) => step.step_index),
    [5],
  )
})

test('waitForTurn degrades when the long-poll method is missing entirely', async () => {
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Answer.')]],
    statuses: ['IDLE'],
  })
  delete world.rpc.waitForConversationFullyIdle
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { quietWindowSeconds: 5, pollIntervalSeconds: 0.2, fastSettleSeconds: 0 },
    ...world.deps,
  })
  // A missing method throws TypeError -> degrade, never crash the turn.
  assert.equal(result.settlement, 'quiet-window')
  assert.equal(result.answer, 'Answer.')
})

test('rpc-idle: a terminal terminationReason confirms idleness when the status lookup fails', async () => {
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Answer despite a status outage.')]],
    terminationReason: 'MAX_TOKEN_BUDGET_EXCEEDED',
  })
  world.rpc.getAllCascadeTrajectories = async () => {
    world.calls.status += 1
    throw Object.assign(new Error('503'), { httpStatus: 503 })
  }
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(result.answer, 'Answer despite a status outage.')
  assert.equal(result.terminationReason, 'MAX_TOKEN_BUDGET_EXCEEDED')
})

test('rpc-idle: an empty terminationReason list leaves the turn waiting', async () => {
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Answer.')]],
    statuses: ['RUNNING'],
  })
  world.rpc.getCascadeTrajectory = async () => ({ executorMetadatas: [] })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    timeoutMs: 1000,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'timeout')
  assert.equal(result.answer, 'Answer.')
})

test('rpc-idle: a long-poll transport timeout re-polls instead of degrading', async () => {
  // The turn is simply longer than one poll budget: mode must stay rpc-idle,
  // otherwise every long turn would lose the fast path for its whole duration.
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Answer after a long turn.')]],
    statuses: ['IDLE'],
  })
  let polls = 0
  world.rpc.waitForConversationFullyIdle = async () => {
    world.calls.wait += 1
    polls += 1
    if (polls === 1) {
      throw Object.assign(new Error('连接 Antigravity Language Server 超时（180000ms 内没有响应）。'), {
        code: 'ETIMEDOUT',
        name: 'TimeoutError',
      })
    }
    return {}
  }
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(result.answer, 'Answer after a long turn.')
  assert.equal(world.calls.wait, 2)
  assert.equal(result.note, undefined, 'a poll timeout must not trigger degradation')
})

test('REQ-01 acceptance: a 39.9s turn settles at the turn end, not after a 45s quiet window', async () => {
  // The regression this module exists to kill: the old implementation added a
  // full quietWindowSeconds (45s) to every turn, so 39.9s cost ~85s.
  const TURN_MS = 39_900
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'Final report.')]],
    statuses: ['IDLE'],
  })
  // Model the long poll: it blocks for the whole turn (the measured behaviour).
  world.rpc.waitForConversationFullyIdle = async () => {
    world.calls.wait += 1
    await world.sleep(TURN_MS)
    return {}
  }
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    // Production defaults: the quiet window must be irrelevant here.
    cfg: { quietWindowSeconds: 45, pollIntervalSeconds: 2, fastSettleSeconds: 2 },
    ...world.deps,
  })

  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(result.answer, 'Final report.')
  // Turn + fastSettle confirmation window only; the 45s quiet window is absent.
  assert.equal(result.elapsedMs, TURN_MS + 2000)
  assert.ok(
    result.elapsedMs < TURN_MS + 45_000,
    `settled in ${result.elapsedMs}ms, must be far below turn + quietWindow(45s)`,
  )
})

// ---------------------------------------------------------------------------
// Failure termination: a dead turn must fail fast, with its real cause
// ---------------------------------------------------------------------------
//
// Measured against a live 2.28.0 instance: a cascade that died with
// FAILED_PRECONDITION sat at CASCADE_RUN_STATUS_IDLE with terminationReason
// ERROR. Two bugs conspired to turn that into a 200s "timeout" with a CLEAN
// audit and no diagnostics:
//
//   1. readCascadeState read `executorMetadatas` off the top level, but the RPC
//      answers `{trajectory: {executorMetadatas}}` — so it was always undefined.
//   2. the brain log lags the server, so the on-disk transcript had only
//      USER_INPUT while the RPC already had the ERROR_MESSAGE.
//
// Both are pinned here.

test('a cascade that died with ERROR fails immediately instead of timing out', async () => {
  // The exact measured scenario: the server is IDLE with terminationReason ERROR,
  // and no planner answer was ever produced.
  const world = makeWorld({
    transcripts: [[toolStep(0, 'run_command', { CommandLine: 'npm test' })]],
    statuses: ['IDLE'],
    terminationReason: 'ERROR',
  })
  const t0 = Date.now()
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { quietWindowSeconds: 45, pollIntervalSeconds: 0.2, fastSettleSeconds: 0, maxSeconds: 60 },
    ...world.deps,
  })
  assert.equal(result.terminationReason, 'ERROR')
  assert.match(String(result.error), /ERROR/)
  assert.ok(result.settlement !== 'timeout', 'a dead turn must not be reported as a timeout')
  assert.ok(Date.now() - t0 < 5000, 'must not burn the whole budget')
})

test('the executor error text reaches the caller', async () => {
  const world = makeWorld({
    transcripts: [
      [
        toolStep(0, 'run_command', { CommandLine: 'npm test' }),
        {
          step_index: 1,
          type: 'ERROR_MESSAGE',
          status: 'DONE',
          content:
            'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
          tool_calls: [],
        },
      ],
    ],
    statuses: ['IDLE'],
    terminationReason: 'ERROR',
  })
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { quietWindowSeconds: 45, pollIntervalSeconds: 0.2, fastSettleSeconds: 0 },
    ...world.deps,
  })
  assert.match(String(result.error), /FAILED_PRECONDITION/)
})

test('readCascadeState unwraps the {trajectory:{...}} wire shape', async () => {
  // The exact regression: metadata at the top level would parse, but the wire
  // shape nests it, and the nesting must be honoured.
  const seen = []
  const rpc = {
    async getAllCascadeTrajectories() {
      return { trajectorySummaries: { [CONV]: { status: 'CASCADE_RUN_STATUS_IDLE' } } }
    },
    async getCascadeTrajectory() {
      return {
        trajectory: {
          executorMetadatas: [{ terminationReason: 'EXECUTOR_TERMINATION_REASON_USER_CANCELED' }],
        },
      }
    },
    async waitForConversationFullyIdle() {
      return {}
    },
    async cancelCascadeInvocation() {
      return {}
    },
    async getCascadeTrajectorySteps() {
      return []
    },
  }
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { quietWindowSeconds: 45, pollIntervalSeconds: 0.2, fastSettleSeconds: 0 },
    rpc,
    readSteps: async () => [{ step_index: 0, type: 'USER_INPUT', content: 'hi', tool_calls: [] }],
    sleep: async () => {},
  })
  assert.equal(result.terminationReason, 'USER_CANCELED')
})


// ---------------------------------------------------------------------------
// v0.5.0: mid-flight audit must not wait for the brain log to catch up
// ---------------------------------------------------------------------------
//
// The brain transcript is flushed asynchronously and lags the Language Server
// (CONTRACT §1: a conversation already IDLE with terminationReason=ERROR had
// only USER_INPUT on disk). 0.4.0 already merges the RPC view into every scan
// tick — these tests freeze that property, because losing it would silently
// turn the kill switch back into a post-hoc report: the violation would reach
// the auditor seconds after the executor had already run it.

test('mid-flight: a violation seen only by RPC is audited and kills the turn', async () => {
  // The on-disk transcript never contains the destructive command at all.
  const onDisk = [plannerStep(0, 'Starting work.')]

  let rpcCalls = 0
  const world = makeWorld({ transcripts: [onDisk], statuses: ['RUNNING'] })
  world.rpc.getCascadeTrajectorySteps = async () => {
    rpcCalls += 1
    return [
      {
        step_index: 0,
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        metadata: { stepIndex: 0 },
        plannerResponse: { response: 'Starting work.' },
      },
      {
        step_index: 1,
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          stepIndex: 1,
          toolCall: {
            name: 'run_command',
            argumentsJson: JSON.stringify({ CommandLine: 'reg delete HKCU\\Software\\Victim' }),
          },
        },
      },
    ]
  }

  const seen = []
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2, maxSeconds: 30 },
    ...world.deps,
    onStep: (step) => {
      seen.push(step.step_index)
      // Exactly what index.js does for a destructive finding.
      const destructive = step.tool_calls.some((call) =>
        String(call.args?.CommandLine ?? '').includes('reg delete'),
      )
      return destructive ? { block: true, reason: '事中熔断：reg delete' } : undefined
    },
  })

  assert.ok(rpcCalls > 0, 'the scan must consult the RPC step view')
  assert.ok(seen.includes(1), 'the RPC-only step must reach the auditor')
  assert.equal(world.calls.cancel, 1, 'the kill switch must cancel the cascade')
  assert.match(result.killed.reason, /reg delete/)
})

test('mid-flight: the RPC view is consulted repeatedly while a turn runs', async () => {
  // The cascade stays RUNNING for a few status reads: the disk log is stale the
  // whole time, so the RPC merge is the only source of new steps.
  const world = makeWorld({
    transcripts: [[plannerStep(0, 'working')]],
    statuses: ['RUNNING', 'RUNNING', 'IDLE'],
  })

  let rpcCalls = 0
  world.rpc.getCascadeTrajectorySteps = async () => {
    rpcCalls += 1
    // A stable answer on top of the step list: the content must not change every
    // tick, or the fast-settle window would keep rejecting the settlement.
    return [
      {
        step_index: 0,
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        metadata: { stepIndex: 0 },
        plannerResponse: { response: 'all done' },
      },
    ]
  }

  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2, maxSeconds: 30 },
    ...world.deps,
  })

  assert.ok(rpcCalls >= 2, `expected repeated RPC merges, saw ${rpcCalls}`)
  assert.equal(world.calls.cancel, 0)
})

test('mid-flight: an RPC failure degrades to the disk view instead of blocking the turn', async () => {
  const world = makeWorld({
    transcripts: [
      [toolStep(0, 'run_command', { CommandLine: 'npm test' }), plannerStep(1, 'All green.')],
    ],
    statuses: ['IDLE'],
  })
  world.rpc.getCascadeTrajectorySteps = async () => {
    throw new Error('rpc down')
  }

  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2, maxSeconds: 30 },
    ...world.deps,
  })
  assert.equal(result.settlement, 'rpc-idle')
  assert.equal(result.answer, 'All green.')
})

test('mid-flight: the RPC view extends the disk view without losing disk-only steps', async () => {
  // The disk log has a historical step the RPC slice happens not to return;
  // the merge must keep it, or the audit would lose that call entirely.
  const world = makeWorld({
    transcripts: [
      [
        toolStep(0, 'run_command', { CommandLine: 'npm test' }),
        plannerStep(1, 'Tests pass.'),
      ],
    ],
    statuses: ['IDLE'],
  })
  world.rpc.getCascadeTrajectorySteps = async () => [
    {
      step_index: 1,
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { stepIndex: 1 },
      plannerResponse: { response: 'Tests pass.' },
    },
  ]

  const seen = []
  const result = await waitForTurn({
    conversationId: CONV,
    sinceIndex: 0,
    server: SERVER,
    cfg: { fastSettleSeconds: 0, pollIntervalSeconds: 0.2, maxSeconds: 30 },
    ...world.deps,
    onStep: (step) => {
      seen.push(step.step_index)
      return undefined
    },
  })

  assert.ok(seen.includes(0), 'the disk-only step must survive the merge')
  assert.ok(seen.includes(1))
  assert.equal(result.answer, 'Tests pass.')
})
