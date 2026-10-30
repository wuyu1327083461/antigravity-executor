/**
 * End-to-end checks for the v0.7.0 dashboard server.
 *
 * These start a REAL `node:http` listener on an ephemeral port and talk to it
 * over real sockets. A mocked `res` would pass while the actual thing — SSE
 * framing, port release on reload, the traversal guard — stayed broken, and
 * those are exactly the parts the PRD calls out (UI-REQ-01, §4.1, §4.2).
 *
 * Run with: `node --test lib/ui-server.test.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { createTelemetryBus } from './telemetry.mjs'
import { resolveInsideWorkspace, startUiServer } from './ui-server.mjs'

/** Fetch JSON with an explicit method/body, without any test framework sugar. */
async function json(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: response.status, text, json: parsed, headers: response.headers }
}

/**
 * Read SSE frames until `until(event, data)` is satisfied.
 *
 * A raw `fetch` stream is used rather than `EventSource` because Node has no
 * EventSource and the framing is precisely what must be verified.
 */
async function readSse(url, { frames = 3, timeoutMs = 4000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(url, { signal: controller.signal })
  const collected = []
  let buffer = ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (collected.length < frames) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const event = /^event: (.+)$/m.exec(raw)?.[1]
        const data = /^data: (.+)$/m.exec(raw)?.[1]
        if (event !== undefined) collected.push({ event, data })
        if (collected.length >= frames) break
      }
    }
  } catch {
    // The abort is the normal exit once enough frames arrived.
  } finally {
    clearTimeout(timer)
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
  return collected
}

describe('resolveInsideWorkspace (REQ-04 §4.1 path traversal guard)', () => {
  const root = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo'

  test('accepts a relative file inside the workspace', () => {
    const out = resolveInsideWorkspace(root, 'index.html')
    assert.equal(out.error, undefined)
    assert.ok(out.path.endsWith('index.html'))
  })

  test('accepts a nested relative path', () => {
    const out = resolveInsideWorkspace(root, 'dist/scene/index.html')
    assert.equal(out.error, undefined)
  })

  test('refuses .. traversal that escapes the workspace', () => {
    const out = resolveInsideWorkspace(root, '../../secret.txt')
    assert.ok(out.error?.includes('路径越界'), out.error)
  })

  test('refuses a sibling directory sharing the workspace prefix', () => {
    // The classic bug: `C:\work-evil` starts with `C:\work` but is not inside it.
    const out = resolveInsideWorkspace(root, '../demo-evil/secret.txt')
    assert.ok(out.error?.includes('路径越界'), out.error)
  })

  test('refuses when there is no active workspace', () => {
    const out = resolveInsideWorkspace(null, 'index.html')
    assert.ok(out.error?.includes('没有活跃'))
  })

  test('rejects an empty path', () => {
    assert.ok(resolveInsideWorkspace(root, '').error !== undefined)
  })
})

describe('createTelemetryBus', () => {
  test('keeps a bounded ring buffer of settled turns', () => {
    const bus = createTelemetryBus({ recentTurnsLimit: 2 })
    for (let i = 0; i < 4; i += 1) {
      const turn = bus.startTurn({ sessionId: `s${i}`, workspaceDir: '/w' })
      bus.settleTurn(turn.turnId, { status: 'ok', finalReportHead: `report ${i}` })
    }
    const snapshot = bus.snapshot()
    assert.equal(snapshot.recentTurns.length, 2)
    // Newest first.
    assert.equal(snapshot.recentTurns[0].finalReportHead, 'report 3')
  })

  test('drops steps for a turn that already settled', () => {
    const bus = createTelemetryBus()
    const turn = bus.startTurn({ sessionId: 's', workspaceDir: '/w' })
    bus.settleTurn(turn.turnId, { status: 'ok' })
    const accepted = bus.pushStep(turn.turnId, {
      stepIndex: 1,
      type: 'step',
      toolName: 'run_command',
      summary: 'late',
      virtualCwd: null,
      isOutsideWorkspace: false,
      verdict: { status: 'clean' },
      timestamp: 0,
    })
    assert.equal(accepted, false)
    assert.equal(bus.snapshot().activeTurn, null)
  })

  test('tracks the virtual cwd and the escape flag', () => {
    const bus = createTelemetryBus()
    const turn = bus.startTurn({ sessionId: 's', workspaceDir: '/w' })
    bus.pushStep(turn.turnId, {
      stepIndex: 1,
      type: 'step',
      toolName: 'run_command',
      summary: 'cd ..',
      virtualCwd: '/outside',
      isOutsideWorkspace: true,
      verdict: { status: 'escape' },
      timestamp: 0,
    })
    const active = bus.snapshot().activeTurn
    assert.equal(active.virtualCwd, '/outside')
    assert.equal(active.cwdEscaped, true)
  })

  test('emits nothing to zero subscribers (REQ-04 zero-overhead path)', () => {
    const bus = createTelemetryBus()
    // `snapshot()` must still be correct; the point is that `emit` short-circuits.
    bus.setBridge({ online: true, pid: 1, port: 2 })
    assert.equal(bus.subscriberCount(), 0)
    assert.equal(bus.snapshot().bridge.online, true)
  })
})

describe('startUiServer', () => {
  /** @type {Awaited<ReturnType<typeof startUiServer>>} */
  let server
  let bus
  let workspace
  let configCalls
  let evicted

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agy-ui-'))
    await writeFile(join(workspace, 'index.html'), '<!doctype html><h1>scene</h1>', 'utf8')
    await mkdir(join(workspace, 'dist'), { recursive: true })
    await writeFile(join(workspace, 'dist', 'app.js'), 'console.log(1)', 'utf8')

    bus = createTelemetryBus({ recentTurnsLimit: 10 })
    bus.setWorkspaceDir(workspace)
    bus.setRuntimeConfig({ thinkingLevel: 'medium', taskMode: 'auto', pacing: { enabled: true } })

    configCalls = []
    evicted = []
    // Port 0 asks the OS for a free port, so the test never collides with a real
    // dashboard the user has open.
    server = await startUiServer({
      bus,
      host: '127.0.0.1',
      port: 0,
      getControlServer: () => ({ pid: 1, port: 2, csrf: 'x' }),
      applyConfig: async (patch) => {
        configCalls.push(patch)
        return bus.setRuntimeConfig({ ...bus.snapshot().runtimeConfig, ...patch })
      },
      evictSession: async (sessionId) => {
        evicted.push(sessionId)
        return { evicted: 1 }
      },
      listSessions: async () => [],
      listArtifacts: async () => [],
      skipPacing: () => true,
    })
  })

  after(async () => {
    if (server !== undefined) await server.close()
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  })

  test('binds loopback and reports its own URL', () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.ok(server.port > 0)
  })

  test('GET / serves the dashboard shell', async () => {
    const { status, text, headers } = await json(`${server.url}/`)
    assert.equal(status, 200)
    assert.match(headers.get('content-type'), /text\/html/)
    assert.match(text, /<html/i)
  })

  test('GET /api/state returns the full snapshot', async () => {
    const { status, json: body } = await json(`${server.url}/api/state`)
    assert.equal(status, 200)
    for (const key of [
      'bridge',
      'quota',
      'lifecycle',
      'activeTurn',
      'recentTurns',
      'sessions',
      'artifacts',
      'runtimeConfig',
    ]) {
      assert.ok(key in body, `snapshot is missing ${key}`)
    }
  })

  test('GET /api/events pushes state:snapshot first', async () => {
    const frames = await readSse(`${server.url}/api/events`, { frames: 1 })
    assert.equal(frames[0].event, 'state:snapshot')
    const snapshot = JSON.parse(frames[0].data)
    assert.ok('runtimeConfig' in snapshot)
  })

  test('a live event reaches a connected client', async () => {
    const controller = new AbortController()
    const response = await fetch(`${server.url}/api/events`, { signal: controller.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // Drain the initial snapshot frame.
    await reader.read()
    bus.setBridge({ online: true, pid: 4321, port: 9999 })
    const timer = setTimeout(() => controller.abort(), 3000)
    let seen = ''
    try {
      while (!seen.includes('bridge:status')) {
        const { value, done } = await reader.read()
        if (done) break
        seen += decoder.decode(value, { stream: true })
      }
    } finally {
      clearTimeout(timer)
      try {
        await reader.cancel()
      } catch {
        /* closed */
      }
    }
    assert.match(seen, /event: bridge:status/)
    assert.match(seen, /4321/)
  })

  test('POST /api/control/config forwards the patch', async () => {
    const { status, json: body } = await json(`${server.url}/api/control/config`, {
      method: 'POST',
      body: { thinkingLevel: 'high' },
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.runtimeConfig.thinkingLevel, 'high')
    assert.deepEqual(configCalls.at(-1), { thinkingLevel: 'high' })
  })

  test('POST /api/control/skip-pacing reports whether a cooldown was waiting', async () => {
    const { status, json: body } = await json(`${server.url}/api/control/skip-pacing`, {
      method: 'POST',
      body: {},
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.skipped, true)
  })

  test('POST /api/sessions/evict calls the eviction hook', async () => {
    const { status, json: body } = await json(`${server.url}/api/sessions/evict`, {
      method: 'POST',
      body: { sessionId: 'demo' },
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(evicted, ['demo'])
  })

  test('POST /api/sessions/evict rejects an empty session id', async () => {
    const { status } = await json(`${server.url}/api/sessions/evict`, {
      method: 'POST',
      body: { sessionId: '  ' },
    })
    assert.equal(status, 400)
  })

  test('a mutating call from a foreign Origin is refused (REQ-04 §4.2)', async () => {
    const { status, json: body } = await json(`${server.url}/api/control/config`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: { thinkingLevel: 'high' },
    })
    assert.equal(status, 403)
    assert.match(body.error, /本机/)
  })

  test('GET /api/workspace-preview serves a file inside the workspace', async () => {
    const { status, text } = await json(`${server.url}/api/workspace-preview/index.html`)
    assert.equal(status, 200)
    assert.match(text, /scene/)
  })

  test('GET /api/workspace-preview serves a nested asset', async () => {
    const { status, text } = await json(`${server.url}/api/workspace-preview/dist/app.js`)
    assert.equal(status, 200)
    assert.match(text, /console\.log/)
  })

  test('GET /api/workspace-preview refuses traversal with 403', async () => {
    // Percent-encoded so the URL parser passes it through as one path segment.
    const { status, text } = await json(`${server.url}/api/workspace-preview/..%2F..%2Fsecret.txt`)
    assert.equal(status, 403, text)
    assert.match(text, /路径越界/)
  })

  test('GET /api/artifact rejects a traversal-shaped filename', async () => {
    const { status } = await json(
      `${server.url}/api/artifact?conversationId=x&file=..%2F..%2Fsecret.md`,
    )
    assert.equal(status, 400)
  })

  test('GET /api/control/rescan is not a GET route', async () => {
    const { status } = await json(`${server.url}/api/control/rescan`)
    assert.equal(status, 405)
  })

  test('an unknown route is a 404, not a crash', async () => {
    const { status, json: body } = await json(`${server.url}/api/nope`)
    assert.equal(status, 404)
    assert.equal(body.ok, false)
  })

  test('HEAD / returns headers without a body', async () => {
    const response = await fetch(`${server.url}/`, { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '')
  })

  test('broadcast is a no-op with no SSE client attached', () => {
    // No assertion beyond "does not throw": this is the REQ-04 hot path, and a
    // throw here would break the executor rather than the page.
    assert.doesNotThrow(() => bus.emit('turn:step', { turnId: 'x' }))
  })
})

describe('startUiServer port release (UI-REQ-01 §2.2)', () => {
  test('close() frees the port for an immediate rebind', async () => {
    const bus = createTelemetryBus()
    const options = {
      bus,
      host: '127.0.0.1',
      port: 0,
      getControlServer: () => null,
      applyConfig: async () => ({}),
      evictSession: async () => ({}),
      listSessions: async () => [],
      listArtifacts: async () => [],
      skipPacing: () => false,
    }
    const first = await startUiServer(options)
    const port = first.port
    // Hold an SSE stream open across the teardown: `close()` must end it rather
    // than wait for it, which is exactly the HMR EADDRINUSE failure mode.
    const controller = new AbortController()
    const stream = await fetch(`${first.url}/api/events`, { signal: controller.signal })
    const reader = stream.body.getReader()
    await reader.read()
    await first.close()
    // Rebind on the very same port. `listen` on a taken port rejects, so a
    // successful second bind proves the first listener released it.
    const second = await startUiServer({ ...options, port })
    assert.equal(second.port, port)
    await second.close()
    try {
      await reader.cancel()
    } catch {
      /* already ended by close() */
    }
  })

  test('a busy port falls forward and reports the real one', async () => {
    const bus = createTelemetryBus()
    const base = {
      bus,
      host: '127.0.0.1',
      getControlServer: () => null,
      applyConfig: async () => ({}),
      evictSession: async () => ({}),
      listSessions: async () => [],
      listArtifacts: async () => [],
      skipPacing: () => false,
    }
    const first = await startUiServer({ ...base, port: 0 })
    // Ask the second server to bind the FIRST one's port: it must step forward.
    const second = await startUiServer({ ...base, port: first.port })
    assert.notEqual(second.port, first.port)
    assert.ok(second.note?.includes('被占用'), second.note)
    await second.close()
    await first.close()
  })
})
