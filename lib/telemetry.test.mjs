/**
 * `lib/telemetry.mjs` — the v0.8.0 bus increment, plus the compatibility promise.
 *
 * WHY THIS FILE IS MORE ABOUT SHAPES THAN ABOUT BEHAVIOUR
 * ------------------------------------------------------
 * The bus is the only seam between the executor and the War Room, and its
 * snapshot is read by `ui/index.html` through plain `JSON.parse` — no schema, no
 * types. That means a renamed or dropped field does not fail here or in CI; it
 * fails as a blank card in a browser. So half of these tests assert the *abs*ence
 * of change: a v0.7.0-shaped caller must still get a byte-identical snapshot and
 * the exact same event names, while a v0.8.0 caller gets the new fields.
 *
 * A fixed clock and a fixed turn-id generator are injected everywhere, so the
 * assertions can compare whole objects instead of poking at individual keys —
 * which is what makes "nothing else changed" actually checkable.
 *
 * Run with: `node --test lib/telemetry.test.mjs`
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createTelemetryBus, normalizeStep } from './telemetry.mjs'

/** A bus with a deterministic clock and turn ids, plus an event recorder. */
function makeBus(options = {}) {
  let clock = 1_000
  let counter = 0
  const bus = createTelemetryBus({
    now: () => (clock += 10),
    nextId: () => `turn-${(counter += 1)}`,
    ...options,
  })
  const events = []
  bus.subscribe((type, data) => events.push({ type, data }))
  return { bus, events, tick: () => (clock += 10) }
}

/** The exact top-level snapshot keys a v0.7.0 consumer relies on. */
const LEGACY_SNAPSHOT_KEYS = [
  'bridge',
  'quota',
  'lifecycle',
  'activeTurn',
  'recentTurns',
  'sessions',
  'artifacts',
  'runtimeConfig',
  'workspaceDir',
  'generatedAt',
]

/** Start + settle one turn, returning the settled record from the snapshot. */
function settleOne(bus, startInfo, settleInfo) {
  const turn = bus.startTurn({ sessionId: 's', workspaceDir: '/w', ...startInfo })
  bus.settleTurn(turn.turnId, settleInfo)
  return { turnId: turn.turnId, record: bus.snapshot().recentTurns[0] }
}

// ---------------------------------------------------------------------------
// normalizeStep().command — CONTRACT §7.7 / §7.3
// ---------------------------------------------------------------------------

describe('normalizeStep — the v0.8.0 `command` field', () => {
  const runCommandStep = {
    step_index: 3,
    type: 'step',
    tool_calls: [{ name: 'run_command', arguments: { command: 'npx vitest run' } }],
    content: 'npx vitest run',
  }

  test('is absent when the verdict carries no command (old shape preserved)', () => {
    const step = normalizeStep(runCommandStep, { status: 'clean', virtualCwd: '/w' })
    assert.equal('command' in step, false)
    // The v0.7.0 fields are all still there and unchanged.
    assert.equal(step.stepIndex, 3)
    assert.equal(step.toolName, 'run_command')
    assert.equal(step.summary, 'npx vitest run')
    assert.equal(step.virtualCwd, '/w')
    assert.equal(step.isOutsideWorkspace, false)
    assert.deepEqual(step.verdict, { status: 'clean' })
    assert.equal(typeof step.timestamp, 'number')
  })

  test('projects {command, cwd, exitCode, outputTail, failed} verbatim', () => {
    const step = normalizeStep(runCommandStep, {
      status: 'clean',
      command: {
        command: 'npx vitest run',
        cwd: 'F:\\work\\app',
        exitCode: 1,
        outputTail: 'AssertionError [ERR_ASSERTION]: expected 200 to equal 500',
        failed: true,
      },
    })
    assert.deepEqual(step.command, {
      command: 'npx vitest run',
      cwd: 'F:\\work\\app',
      exitCode: 1,
      outputTail: 'AssertionError [ERR_ASSERTION]: expected 200 to equal 500',
      failed: true,
    })
  })

  test('an unknown exit code stays null and is never guessed to 0 (§7.3)', () => {
    for (const exitCode of [null, undefined, '', 'not-a-number']) {
      const step = normalizeStep(runCommandStep, {
        command: { command: 'npm run build', cwd: null, exitCode, outputTail: '' },
      })
      assert.equal(step.command.exitCode, null, `exitCode ${String(exitCode)} became a number`)
      assert.equal(step.command.failed, false, 'an unknown exit code must not read as failure')
    }
  })

  test('exit 0 is a clean success, exit 2 is a failure even without an explicit flag', () => {
    const ok = normalizeStep(runCommandStep, { command: { command: 'ls', exitCode: 0 } })
    assert.equal(ok.command.failed, false)
    const bad = normalizeStep(runCommandStep, { command: { command: 'ls', exitCode: 2 } })
    assert.equal(bad.command.failed, true)
  })

  test('a command entry with no command text is dropped rather than half-written', () => {
    for (const command of [{}, { exitCode: 1 }, null, 'not-an-object']) {
      const step = normalizeStep(runCommandStep, { command })
      assert.equal('command' in step, false)
    }
  })

  test('outputTail is bounded so a runaway log cannot bloat the snapshot', () => {
    const step = normalizeStep(runCommandStep, {
      command: { command: 'ls', outputTail: 'x'.repeat(50_000) },
    })
    assert.ok(step.command.outputTail.length <= 1501, step.command.outputTail.length)
  })

  test('cwd falls back to null, not undefined', () => {
    const step = normalizeStep(runCommandStep, { command: { command: 'ls' } })
    assert.equal(step.command.cwd, null)
    assert.equal(step.command.outputTail, '')
  })
})

// ---------------------------------------------------------------------------
// backward compatibility
// ---------------------------------------------------------------------------

describe('backward compatibility with the v0.7.0 shape', () => {
  test('a bus that never hears about v0.8.0 produces the old snapshot key set', () => {
    const { bus } = makeBus()
    bus.setBridge({ online: true, pid: 1, port: 2 })
    bus.setQuota({ buckets: [], readAt: 500 })
    bus.setRuntimeConfig({ thinkingLevel: 'medium' })
    const turn = bus.startTurn({ sessionId: 's', workspaceDir: '/w' })
    bus.pushStep(turn.turnId, {
      stepIndex: 1,
      type: 'step',
      toolName: 'read_file',
      summary: 'a.txt',
      virtualCwd: '/w',
      isOutsideWorkspace: false,
      verdict: { status: 'clean' },
      timestamp: 0,
    })
    bus.settleTurn(turn.turnId, { status: 'ok', finalReportHead: 'done' })

    const snapshot = bus.snapshot()
    assert.deepEqual(Object.keys(snapshot).sort(), [...LEGACY_SNAPSHOT_KEYS].sort())
    // `quota.burn` is the one addition that is always present — it is null,
    // because `undefined` would vanish in the JSON the browser receives.
    assert.deepEqual(Object.keys(snapshot.quota).sort(), [
      'activeFallback',
      'buckets',
      'bucketsByFamily',
      'burn',
      'cachedAt',
      'error',
    ])
    assert.equal(snapshot.quota.burn, null)

    // The settled record grew no v0.8.0 key at all.
    const record = snapshot.recentTurns[0]
    for (const key of [
      'commands',
      'burn',
      'changedFiles',
      'touchedFiles',
      'rolledBack',
      'escalation',
      'rolloverBrief',
      'snapshotSha',
    ]) {
      assert.equal(key in record, false, `settled record grew an unexpected ${key}`)
    }
  })

  test('every pre-existing event name is still emitted with its old payload keys', () => {
    const { bus, events } = makeBus()
    bus.setBridge({ online: true, pid: 7, port: 8 })
    bus.setQuota({ buckets: [{ name: 'b' }], readAt: 100 })
    bus.setActiveFallback(true)
    bus.setPhase('pacing', { pacingRemainingMs: 5000 })
    bus.setQueueLength(2)
    const turn = bus.startTurn({ sessionId: 's', workspaceDir: '/w' })
    bus.pushStep(turn.turnId, {
      stepIndex: 1,
      type: 'step',
      toolName: 'read_file',
      summary: 'x',
      virtualCwd: null,
      isOutsideWorkspace: false,
      verdict: { status: 'clean' },
      timestamp: 0,
    })
    bus.abortTurn(turn.turnId, { trigger: 'manual', reason: 'stop' })
    bus.settleTurn(turn.turnId, { status: 'aborted' })
    bus.setSessions([{ sessionId: 's' }])
    bus.setArtifacts([{ name: 'a' }])
    bus.setRuntimeConfig({ thinkingLevel: 'high' })

    const names = [...new Set(events.map((event) => event.type))]
    for (const name of [
      'bridge:status',
      'quota:updated',
      'lifecycle:change',
      'turn:started',
      'turn:step',
      'turn:aborted',
      'turn:settled',
      'sessions:updated',
      'artifacts:updated',
      'config:updated',
    ]) {
      assert.ok(names.includes(name), `missing event ${name}`)
    }

    const settled = events.find((event) => event.type === 'turn:settled').data
    for (const key of [
      'turnId',
      'durationMs',
      'status',
      'finalReportHead',
      'gitSummary',
      'artifacts',
      'sessionRecreated',
      'turnCount',
    ]) {
      assert.ok(key in settled, `turn:settled lost ${key}`)
    }
  })

  test('turns, steps, abort and ring-buffer limits behave exactly as before', () => {
    const { bus } = makeBus({ recentTurnsLimit: 2 })
    for (let i = 0; i < 4; i += 1) {
      const turn = bus.startTurn({ sessionId: `s${i}`, workspaceDir: '/w' })
      bus.settleTurn(turn.turnId, { status: 'ok', finalReportHead: `report ${i}` })
    }
    const snapshot = bus.snapshot()
    assert.equal(snapshot.recentTurns.length, 2)
    assert.equal(snapshot.recentTurns[0].finalReportHead, 'report 3')

    // Steps for an already-settled turn are still dropped.
    const late = bus.startTurn({ sessionId: 'late', workspaceDir: '/w' })
    bus.settleTurn(late.turnId, { status: 'ok' })
    assert.equal(
      bus.pushStep(late.turnId, {
        stepIndex: 1,
        type: 'step',
        toolName: 'noop',
        summary: '',
        virtualCwd: null,
        isOutsideWorkspace: false,
        verdict: { status: 'clean' },
        timestamp: 0,
      }),
      false,
    )
    assert.equal(bus.snapshot().activeTurn, null)
  })

  test('the snapshot is still a deep copy', () => {
    const { bus } = makeBus()
    bus.setSessions([{ sessionId: 'a', conversationId: 'c1' }])
    const snapshot = bus.snapshot()
    snapshot.sessions[0].conversationId = 'hacked'
    snapshot.quota.buckets.push('hacked')
    assert.equal(bus.snapshot().sessions[0].conversationId, 'c1')
    assert.deepEqual(bus.snapshot().quota.buckets, [])
  })
})

// ---------------------------------------------------------------------------
// recordBurn — CONTRACT §7.7 item 4
// ---------------------------------------------------------------------------

describe('recordBurn', () => {
  test('records a positive delta and emits quota:burn', () => {
    const { bus, events } = makeBus()
    const burn = bus.recordBurn({ deltaFraction: 0.013, cumulativeFraction: 0.42, window: 'fiveHour' })
    assert.equal(burn.deltaFraction, 0.013)
    assert.equal(burn.cumulativeFraction, 0.42)
    assert.equal(burn.window, 'fiveHour')
    assert.equal(typeof burn.at, 'number')

    const emitted = events.filter((event) => event.type === 'quota:burn')
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].data.deltaFraction, 0.013)
    assert.equal(bus.snapshot().quota.burn.deltaFraction, 0.013)
  })

  test('keeps the value positive: 0.013 means "1.3% burned", not "-1.3%"', () => {
    const { bus } = makeBus()
    bus.recordBurn({ deltaFraction: 0.013 })
    assert.ok(bus.snapshot().quota.burn.deltaFraction > 0)
    // The UI adds the sign; the wire value must never be negative by accident.
    assert.equal(`-${(bus.snapshot().quota.burn.deltaFraction * 100).toFixed(1)}%`, '-1.3%')
  })

  test('defaults the window and keeps the previous cumulative reading', () => {
    const { bus } = makeBus()
    bus.recordBurn({ deltaFraction: 0.01, cumulativeFraction: 0.3, window: 'weekly' })
    bus.recordBurn({ deltaFraction: 0.02 })
    const burn = bus.snapshot().quota.burn
    assert.equal(burn.window, 'fiveHour')
    assert.equal(burn.cumulativeFraction, 0.3)
    assert.equal(burn.deltaFraction, 0.02)
  })

  test('an unmeasurable burn is ignored instead of blanking the badge', () => {
    const { bus, events } = makeBus()
    bus.recordBurn({ deltaFraction: 0.05 })
    const before = bus.snapshot().quota.burn
    for (const call of [{}, { deltaFraction: null }, { cumulativeFraction: 'nope' }]) {
      assert.equal(bus.recordBurn(call), null)
    }
    assert.deepEqual(bus.snapshot().quota.burn, before)
    assert.equal(events.filter((event) => event.type === 'quota:burn').length, 1)
  })

  test('quota.burn is null (present, JSON-visible) before the first burn', () => {
    const { bus } = makeBus()
    const quota = bus.snapshot().quota
    assert.ok('burn' in quota, 'quota.burn must exist so the page can read it')
    assert.equal(quota.burn, null)
    // It must survive the JSON round-trip the SSE frame performs.
    assert.ok('burn' in JSON.parse(JSON.stringify(bus.snapshot().quota)))
  })

  test('reset() clears the burn along with the turns', () => {
    const { bus } = makeBus()
    const turn = bus.startTurn({ sessionId: 's', workspaceDir: '/w' })
    bus.settleTurn(turn.turnId, { status: 'ok' })
    bus.recordBurn({ deltaFraction: 0.1 })
    bus.reset()
    assert.equal(bus.snapshot().quota.burn, null)
    assert.deepEqual(bus.snapshot().recentTurns, [])
  })
})

// ---------------------------------------------------------------------------
// startTurn — escalation / rolloverBrief / snapshotSha
// ---------------------------------------------------------------------------

describe('startTurn — v0.8.0 identity fields', () => {
  test('carries escalation, rolloverBrief and snapshotSha onto the active turn', () => {
    const { bus, events } = makeBus()
    bus.startTurn({
      sessionId: 's',
      workspaceDir: '/w',
      escalation: { from: 'flash', to: 'pro', reason: 'retry' },
      rolloverBrief: { previousTurnCount: 8, files: ['src/a.js', 'src/b.js'] },
      snapshotSha: 'deadbeef',
    })
    const active = bus.snapshot().activeTurn
    assert.deepEqual(active.escalation, { from: 'flash', to: 'pro', reason: 'retry' })
    assert.deepEqual(active.rolloverBrief, { previousTurnCount: 8, files: ['src/a.js', 'src/b.js'] })
    assert.equal(active.snapshotSha, 'deadbeef')

    // The live event carries them too, so the page does not have to wait.
    const started = events.find((event) => event.type === 'turn:started').data
    assert.deepEqual(started.escalation, { from: 'flash', to: 'pro', reason: 'retry' })
    assert.equal(started.snapshotSha, 'deadbeef')
  })

  test('omits each field independently when it is not supplied', () => {
    const { bus } = makeBus()
    bus.startTurn({ sessionId: 's', workspaceDir: '/w', escalation: { from: 'flash', to: 'pro' } })
    const active = bus.snapshot().activeTurn
    assert.deepEqual(active.escalation, { from: 'flash', to: 'pro', reason: null })
    assert.equal('rolloverBrief' in active, false)
    assert.equal('snapshotSha' in active, false)
  })

  test('a missing escalation target is dropped rather than rendered as null -> null', () => {
    const { bus } = makeBus()
    bus.startTurn({ sessionId: 's', workspaceDir: '/w', escalation: {} })
    assert.equal('escalation' in bus.snapshot().activeTurn, false)
  })

  test('rolloverBrief caps the file list at 15 and tolerates an empty brief', () => {
    const { bus } = makeBus()
    const files = Array.from({ length: 40 }, (_, i) => `f${i}.js`)
    bus.startTurn({ sessionId: 's', workspaceDir: '/w', rolloverBrief: { previousTurnCount: 8, files } })
    const brief = bus.snapshot().activeTurn.rolloverBrief
    assert.equal(brief.files.length, 15)
    assert.equal(brief.previousTurnCount, 8)

    const second = makeBus()
    second.bus.startTurn({ sessionId: 's', workspaceDir: '/w', rolloverBrief: {} })
    assert.deepEqual(second.bus.snapshot().activeTurn.rolloverBrief, {
      previousTurnCount: 0,
      files: [],
    })
  })

  test('the identity fields survive into the settled record', () => {
    const { bus } = makeBus()
    const { record } = settleOne(
      bus,
      {
        escalation: { from: 'flash', to: 'pro', reason: 'complexity' },
        snapshotSha: 'abc123',
        rolloverBrief: { previousTurnCount: 4, files: ['a.js'] },
      },
      { status: 'ok' },
    )
    assert.deepEqual(record.escalation, { from: 'flash', to: 'pro', reason: 'complexity' })
    assert.equal(record.snapshotSha, 'abc123')
    assert.deepEqual(record.rolloverBrief.files, ['a.js'])
  })
})

// ---------------------------------------------------------------------------
// settleTurn — commands / burn / changedFiles
// ---------------------------------------------------------------------------

describe('settleTurn — v0.8.0 result fields', () => {
  test('carries the command summary, changed files, burn and touched files', () => {
    const { bus } = makeBus()
    const { record } = settleOne(
      bus,
      {},
      {
        status: 'ok',
        commands: {
          total: 2,
          failed: 1,
          lastVerification: {
            command: 'npx vitest run',
            cwd: 'F:\\work\\app',
            exitCode: 1,
            outputTail: 'AssertionError: expected 200 to equal 500',
            failed: true,
          },
          verificationFailed: true,
        },
        burn: { fraction: 0.013, label: '5h 桶' },
        changedFiles: [
          { path: 'src/a.js', added: 12, removed: 3 },
          'src/b.js',
        ],
        touchedFiles: ['src/a.js', 'src/b.js'],
      },
    )
    assert.equal(record.commands.total, 2)
    assert.equal(record.commands.failed, 1)
    assert.equal(record.commands.verificationFailed, true)
    assert.equal(record.commands.lastVerification.exitCode, 1)
    assert.deepEqual(record.burn, { fraction: 0.013, label: '5h 桶' })
    assert.deepEqual(record.changedFiles, [
      { path: 'src/a.js', added: 12, removed: 3 },
      { path: 'src/b.js', added: 0, removed: 0 },
    ])
    assert.deepEqual(record.touchedFiles, ['src/a.js', 'src/b.js'])
  })

  test('the turn:settled frame carries the new fields only when they exist', () => {
    const { bus, events } = makeBus()
    const turn = bus.startTurn({ sessionId: 's', workspaceDir: '/w', snapshotSha: 'sha' })
    bus.settleTurn(turn.turnId, { status: 'ok', burn: { fraction: 0.02, label: '5h' } })
    const payload = events.filter((event) => event.type === 'turn:settled').at(-1).data
    assert.deepEqual(payload.burn, { fraction: 0.02, label: '5h' })
    assert.equal(payload.snapshotSha, 'sha')
    assert.equal('commands' in payload, false)
    assert.equal('changedFiles' in payload, false)
  })

  test('omits empty optional result fields entirely', () => {
    const { bus } = makeBus()
    const { record } = settleOne(
      bus,
      {},
      { status: 'ok', commands: {}, changedFiles: [], touchedFiles: [], burn: {} },
    )
    for (const key of ['commands', 'burn', 'changedFiles', 'touchedFiles']) {
      assert.equal(key in record, false, `record grew an empty ${key}`)
    }
  })

  test('rolledBack is only written when true', () => {
    const { bus } = makeBus()
    const normal = settleOne(bus, {}, { status: 'ok', rolledBack: false })
    assert.equal('rolledBack' in normal.record, false)
    const rolled = settleOne(bus, { sessionId: 's2' }, { status: 'ok', rolledBack: true })
    assert.equal(rolled.record.rolledBack, true)
  })

  test('a burn without a fraction is dropped, not written as NaN', () => {
    const { bus } = makeBus()
    const { record } = settleOne(bus, {}, { status: 'ok', burn: { label: '5h' } })
    assert.equal('burn' in record, false)
  })

  test('changed files with no path are filtered out', () => {
    const { bus } = makeBus()
    const { record } = settleOne(
      bus,
      {},
      { status: 'ok', changedFiles: [{ path: '  ' }, { added: 1 }, { path: 'ok.js', added: 2 }] },
    )
    assert.deepEqual(record.changedFiles, [{ path: 'ok.js', added: 2, removed: 0 }])
  })
})

// ---------------------------------------------------------------------------
// markRolledBack — CONTRACT §7.7 item 5
// ---------------------------------------------------------------------------

describe('markRolledBack', () => {
  test('flags the settled turn and emits turn:rolled-back', () => {
    const { bus, events } = makeBus()
    const { turnId } = settleOne(bus, {}, { status: 'ok' })

    const ok = bus.markRolledBack(turnId, {
      restoredFiles: ['src/a.js'],
      removedUntracked: ['new.txt'],
    })
    assert.equal(ok, true)

    const record = bus.snapshot().recentTurns[0]
    assert.equal(record.rolledBack, true)
    assert.deepEqual(record.rollback.restoredFiles, ['src/a.js'])
    assert.deepEqual(record.rollback.removedUntracked, ['new.txt'])
    assert.equal(typeof record.rollback.at, 'number')

    const emitted = events.filter((event) => event.type === 'turn:rolled-back')
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].data.turnId, turnId)
    assert.deepEqual(emitted[0].data.restoredFiles, ['src/a.js'])
    assert.deepEqual(emitted[0].data.removedUntracked, ['new.txt'])
  })

  test('finds the right turn among several in the ring buffer', () => {
    const { bus } = makeBus()
    const first = settleOne(bus, { sessionId: 'a' }, { status: 'ok' })
    const second = settleOne(bus, { sessionId: 'b' }, { status: 'ok' })
    bus.markRolledBack(first.turnId, { restoredFiles: ['only-first.js'] })
    const turns = bus.snapshot().recentTurns
    assert.equal(turns.find((turn) => turn.turnId === first.turnId).rolledBack, true)
    assert.equal('rolledBack' in turns.find((turn) => turn.turnId === second.turnId), false)
  })

  test('returns false and emits nothing for an unknown or evicted turn', () => {
    const { bus, events } = makeBus({ recentTurnsLimit: 1 })
    settleOne(bus, { sessionId: 'a' }, { status: 'ok' })
    const evicted = settleOne(bus, { sessionId: 'b' }, { status: 'ok' })
    settleOne(bus, { sessionId: 'c' }, { status: 'ok' })
    const before = events.length

    assert.equal(bus.markRolledBack(evicted.turnId, {}), false)
    assert.equal(bus.markRolledBack('turn-nope', {}), false)
    assert.equal(bus.markRolledBack('   ', {}), false)
    assert.equal(events.length, before)
  })

  test('an error and skipped list are reported when the rollback was partial', () => {
    const { bus, events } = makeBus()
    const { turnId } = settleOne(bus, {}, { status: 'ok' })
    bus.markRolledBack(turnId, {
      restoredFiles: [],
      removedUntracked: [],
      skipped: ['../outside.txt'],
      error: '不是 git 仓库',
    })
    const record = bus.snapshot().recentTurns[0]
    assert.deepEqual(record.rollback.skipped, ['../outside.txt'])
    assert.equal(record.rollback.error, '不是 git 仓库')
    const payload = events.filter((event) => event.type === 'turn:rolled-back').at(-1).data
    assert.equal(payload.error, '不是 git 仓库')
  })
})

// ---------------------------------------------------------------------------
// markRolledOver — CONTRACT §7.7 item 6
// ---------------------------------------------------------------------------

describe('markRolledOver', () => {
  const row = {
    sessionId: 'chat-1',
    conversationId: 'conv-old',
    workspaceDir: '/w',
    tier: 'pro',
    turnCount: 8,
    longSession: true,
    lastTouchedFiles: ['src/a.js'],
    lastTaskHead: '把登录页改蓝',
    updatedAt: 500,
  }

  test('resets turnCount, swaps the conversation and keeps the brief', () => {
    const { bus } = makeBus()
    bus.setSessions([row, { sessionId: 'other', conversationId: 'x', turnCount: 1 }])

    const updated = bus.markRolledOver('chat-1', {
      toConversationId: 'conv-new',
      brief: { previousTurnCount: 8, files: ['src/a.js'] },
    })
    assert.equal(updated.conversationId, 'conv-new')
    assert.equal(updated.turnCount, 0)
    assert.equal(updated.longSession, false)
    assert.equal(updated.previousConversationId, 'conv-old')
    assert.deepEqual(updated.rolloverBrief, { previousTurnCount: 8, files: ['src/a.js'] })
    assert.equal(typeof updated.rolledOverAt, 'number')

    // Everything that still describes the same session is untouched.
    assert.equal(updated.workspaceDir, '/w')
    assert.equal(updated.tier, 'pro')
    assert.deepEqual(updated.lastTouchedFiles, ['src/a.js'])
    assert.equal(updated.lastTaskHead, '把登录页改蓝')

    // Only the targeted row changed.
    const rows = bus.snapshot().sessions
    assert.equal(rows.length, 2)
    assert.equal(rows[1].conversationId, 'x')
    assert.equal(rows[1].turnCount, 1)
  })

  test('emits session:rollover with what the UI needs to announce it', () => {
    const { bus, events } = makeBus()
    bus.setSessions([row])
    bus.markRolledOver('chat-1', {
      toConversationId: 'conv-new',
      brief: { previousTurnCount: 8, files: ['src/a.js'] },
    })
    const emitted = events.filter((event) => event.type === 'session:rollover')
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].data.sessionId, 'chat-1')
    assert.equal(emitted[0].data.toConversationId, 'conv-new')
    assert.equal(emitted[0].data.previousConversationId, 'conv-old')
    assert.deepEqual(emitted[0].data.brief, { previousTurnCount: 8, files: ['src/a.js'] })
    // The list is republished so a page that only listens to sessions:updated
    // also converges.
    assert.equal(events.filter((event) => event.type === 'sessions:updated').length >= 1, true)
  })

  test('is a no-op for a session the bus has never heard of', () => {
    const { bus, events } = makeBus()
    bus.setSessions([row])
    const before = events.length
    assert.equal(bus.markRolledOver('ghost', { toConversationId: 'n' }), null)
    assert.equal(bus.markRolledOver('   ', {}), null)
    assert.equal(events.length, before)
    assert.equal(bus.snapshot().sessions.length, 1)
  })

  test('works without a brief and without a target conversation', () => {
    const { bus } = makeBus()
    bus.setSessions([row])
    const updated = bus.markRolledOver('chat-1', {})
    assert.equal(updated.conversationId, null)
    assert.equal(updated.turnCount, 0)
    assert.equal('rolloverBrief' in updated, false)
  })

  test('the snapshot rows survive the JSON round-trip', () => {
    const { bus } = makeBus()
    bus.setSessions([row])
    bus.markRolledOver('chat-1', {
      toConversationId: 'conv-new',
      brief: { previousTurnCount: 8, files: ['src/a.js'] },
    })
    const parsed = JSON.parse(JSON.stringify(bus.snapshot()))
    assert.equal(parsed.sessions[0].conversationId, 'conv-new')
    assert.deepEqual(parsed.sessions[0].rolloverBrief, {
      previousTurnCount: 8,
      files: ['src/a.js'],
    })
  })
})

// ---------------------------------------------------------------------------
// the whole v0.8.0 story, end to end through the snapshot
// ---------------------------------------------------------------------------

describe('the full v0.8.0 snapshot path', () => {
  test('one turn goes escalate -> command -> burn -> settle -> rollback', () => {
    const { bus } = makeBus()
    bus.setSessions([{ sessionId: 's', conversationId: 'c1', turnCount: 7, longSession: true }])
    bus.setQuota({ buckets: [], readAt: 1, bucketsByFamily: { fiveHour: null, weekly: null } })

    const turn = bus.startTurn({
      sessionId: 's',
      conversationId: 'c1',
      workspaceDir: '/w',
      escalation: { from: 'flash', to: 'pro', reason: 'retry' },
      snapshotSha: 'sha-before',
    })
    bus.pushStep(
      turn.turnId,
      normalizeStep(
        { step_index: 1, type: 'step', tool_calls: [{ name: 'run_command' }] },
        {
          status: 'clean',
          command: { command: 'npm test', cwd: '/w', exitCode: 1, outputTail: 'boom', failed: true },
        },
      ),
    )
    bus.settleTurn(turn.turnId, {
      status: 'ok',
      commands: { total: 1, failed: 1, verificationFailed: true },
      burn: { fraction: 0.013, label: '5h 桶' },
      changedFiles: [{ path: 'src/a.js', added: 1, removed: 0 }],
    })
    bus.recordBurn({ deltaFraction: 0.013, cumulativeFraction: 0.5, window: 'fiveHour' })
    bus.markRolledBack(turn.turnId, { restoredFiles: ['src/a.js'], removedUntracked: [] })

    const snapshot = bus.snapshot()
    const record = snapshot.recentTurns[0]
    assert.deepEqual(record.escalation, { from: 'flash', to: 'pro', reason: 'retry' })
    assert.equal(record.snapshotSha, 'sha-before')
    assert.equal(record.steps[0].command.exitCode, 1)
    assert.equal(record.commands.verificationFailed, true)
    assert.equal(record.burn.fraction, 0.013)
    assert.equal(record.changedFiles[0].path, 'src/a.js')
    assert.equal(record.rolledBack, true)
    assert.equal(snapshot.quota.burn.cumulativeFraction, 0.5)

    // And it all survives the exact serialization the SSE frame performs.
    const wire = JSON.parse(JSON.stringify(snapshot))
    assert.equal(wire.recentTurns[0].burn.fraction, 0.013)
    assert.equal(wire.quota.burn.deltaFraction, 0.013)

    // A rollover then moves the session forward without losing its identity.
    bus.markRolledOver('s', {
      toConversationId: 'c2',
      brief: { previousTurnCount: 8, files: ['src/a.js'] },
    })
    const session = bus.snapshot().sessions[0]
    assert.equal(session.conversationId, 'c2')
    assert.equal(session.turnCount, 0)
    assert.equal(session.longSession, false)
  })
})
