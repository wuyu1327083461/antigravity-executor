/**
 * v0.8.0 end-to-end acceptance: the shipped War Room page, served for real.
 *
 * WHY THIS IS A TEST AND NOT A SCRIPT SOMEWHERE
 * ---------------------------------------------
 * Every other UI test in this package reads `ui/index.html` off disk and asserts
 * on its text. That proves the markup exists; it does not prove a browser would
 * ever receive it. This suite starts the actual listener, fetches the actual
 * shell over HTTP, and then asks the actual `/api/state` endpoint for the
 * snapshot — so a 500 on load, a broken route, or a snapshot shape that quietly
 * dropped a v0.8.0 field all fail here rather than in someone's browser.
 *
 * @module antigravity-executor/lib/warroom-v080.test.mjs
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createTelemetryBus } from './telemetry.mjs'
import { startUiServer } from './ui-server.mjs'

const exec = promisify(execFile)
const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true })

/** One workspace + one server, shared by the whole file. */
const state = { dir: undefined, server: undefined, html: '', snapshot: undefined }

describe('v0.8.0 War Room end to end', () => {
  it('serves the shell and a fully populated snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy v080 '))
    state.dir = dir
    await git(dir, 'init', '-b', 'main')
    await git(dir, 'config', 'user.email', 't@t.local')
    await git(dir, 'config', 'user.name', 't')
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'app.js'), 'const x = 1\n')
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-m', 'base')

    const bus = createTelemetryBus()
    bus.setWorkspaceDir(dir)

    // A turn exercising every v0.8.0 field at once.
    const turn = bus.startTurn({
      sessionId: 'smoke',
      conversationId: 'conv-1',
      effectiveMode: 'document',
      requestedTier: 'pro',
      effectiveTier: 'pro',
      escalation: { from: 'flash', to: 'pro', reason: 'retry' },
      snapshotSha: 'deadbeef',
    })
    bus.pushStep(turn.turnId, {
      stepIndex: 1,
      type: 'RUN_COMMAND',
      toolName: 'run_command',
      summary: 'npx vitest run',
      verdict: { status: 'clean' },
      command: {
        command: 'npx vitest run',
        cwd: dir,
        exitCode: 1,
        outputTail: 'AssertionError',
        failed: true,
      },
    })
    bus.recordBurn({ deltaFraction: 0.013, cumulativeFraction: 0.054, window: '5h' })
    bus.settleTurn(turn.turnId, {
      status: 'ok',
      commands: { total: 2, failed: 1, verificationFailed: true },
      burn: { fraction: 0.013, label: '5h' },
      changedFiles: [{ path: 'src/app.js', added: 2, removed: 0 }],
      touchedFiles: [join(dir, 'src/app.js')],
    })
    bus.setSessions([
      {
        sessionId: 'smoke',
        conversationId: 'conv-1',
        workspaceDir: dir,
        tier: 'pro',
        turnCount: 9,
        cumulativeTurnCount: 9,
        longSession: true,
        lastTouchedFiles: ['src/app.js'],
        lastTaskHead: '生成月度报表',
        taskMode: 'document',
        lastTurnFailed: true,
        burnCumulative: 0.054,
        updatedAt: new Date().toISOString(),
      },
    ])

    const server = await startUiServer({ bus, host: '127.0.0.1', port: 0 })
    state.server = server

    const res = await fetch(`${server.url}/`)
    assert.equal(res.status, 200, 'GET / must serve the dashboard shell')
    assert.match(String(res.headers.get('cache-control')), /no-store/)
    state.html = await res.text()
    state.snapshot = await fetch(`${server.url}/api/state`).then((r) => r.json())
  })

  it('UI-REQ-01: ships the four-tab Universal Inspector', () => {
    for (const id of ['ipane-tab-diff', 'ipane-tab-terminal', 'ipane-tab-plan', 'ipane-tab-preview']) {
      assert.ok(state.html.includes(`id="${id}"`), `the inspector must expose ${id}`)
    }
  })

  it('UI-REQ-02: ships the filter pills, read-step folding and the step accordion', () => {
    for (const marker of ['timeline-filter-row', 'createExploreGroupElement', 'createStepDetailAccordion']) {
      assert.ok(state.html.includes(marker), `the timeline must implement ${marker}`)
    }
  })

  it('UI-REQ-03/04: ships rollback, rollover and the config persistence controls', () => {
    for (const marker of ['requestRollback', 'btn-config-save', 'btn-config-reset', 'config-drift-note']) {
      assert.ok(state.html.includes(marker), `the controls must implement ${marker}`)
    }
    assert.ok(state.html.includes('renderBurnBadge'), 'the burn delta badge must be rendered')
  })

  it('UI-REQ-05: ships container queries, the history lock and the new-turn pill', () => {
    for (const marker of ['container-type', '@container', 'history-lock-banner', 'new-turn-pill']) {
      assert.ok(state.html.includes(marker), `the responsive layout must implement ${marker}`)
    }
  })

  it('REQ-05: document is a first-class task mode in the UI', () => {
    assert.ok(state.html.includes('data-value="document"'), 'document must be selectable')
    assert.ok(state.html.includes('badge-mode-document'), 'document must have its own badge')
  })

  it('the shell keeps its v0.7.0 safety and theme contracts', () => {
    assert.ok(state.html.includes('adoptHostTheme'), 'host theme sync must survive')
    assert.ok(state.html.includes('--dsw-alias-bg-base'), 'the host background token must survive')
    assert.ok(state.html.includes('function apiUrl'), 'all URL building must go through apiUrl')
    // A hard-coded absolute API path 404s under the host's proxy prefix.
    assert.equal(/['"`]\/api\//.test(state.html), false, 'no absolute /api/ literal may appear')
  })

  it('the snapshot carries every v0.8.0 field the new panes render', () => {
    const snap = state.snapshot
    assert.equal(snap.quota?.burn?.deltaFraction, 0.013, 'quota.burn.deltaFraction')
    const turn = snap.recentTurns?.[0]
    assert.equal(turn?.commands?.failed, 1, 'recentTurns[].commands.failed')
    assert.equal(turn?.escalation?.reason, 'retry', 'recentTurns[].escalation.reason')
    assert.equal(turn?.burn?.fraction, 0.013, 'recentTurns[].burn.fraction')
    assert.equal(turn?.changedFiles?.[0]?.path, 'src/app.js', 'recentTurns[].changedFiles')
    assert.equal(turn?.snapshotSha, 'deadbeef', 'recentTurns[].snapshotSha')
    assert.equal(turn?.steps?.[0]?.command?.exitCode, 1, 'steps[].command.exitCode')
    assert.equal(snap.sessions?.[0]?.burnCumulative, 0.054, 'sessions[].burnCumulative')
    assert.equal(snap.sessions?.[0]?.taskMode, 'document', 'sessions[].taskMode')
  })

  after(async () => {
    if (state.server !== undefined) await state.server.close()
    if (state.dir !== undefined) await rm(state.dir, { recursive: true, force: true })
  })
})
