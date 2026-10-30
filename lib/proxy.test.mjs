/**
 * Same-origin proxy checks (v0.7.0).
 *
 * The proxy is what lets the in-app panel talk to the loopback dashboard without
 * a CORS allowance, so the assertions are about the two things that would break
 * silently: JSON flowing through, and an SSE stream staying open end to end.
 *
 * Run with: `node --test lib/proxy.test.mjs`
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, test } from 'node:test'

import { createUiProxy } from './proxy.mjs'
import { createTelemetryBus } from './telemetry.mjs'
import { startUiServer } from './ui-server.mjs'

const PREFIX = '/antigravity-executor'

describe('createUiProxy', () => {
  let upstream
  let gui
  let guiUrl
  let bus

  before(async () => {
    bus = createTelemetryBus({ recentTurnsLimit: 3 })
    bus.setBridge({ online: true, pid: 4242, port: 7777, plan: 'Pro' })
    bus.setRuntimeConfig({ thinkingLevel: 'high', pacing: { enabled: true } })
    upstream = await startUiServer({
      bus,
      host: '127.0.0.1',
      port: 0,
      getControlServer: () => null,
      applyConfig: async (patch) => bus.setRuntimeConfig({ ...bus.snapshot().runtimeConfig, ...patch }),
      evictSession: async () => ({ evicted: 1 }),
      listSessions: async () => [],
      listArtifacts: async () => [],
      skipPacing: () => true,
    })

    // A stand-in for the dsh Web GUI: a *different* origin that mounts the proxy
    // under the plugin's prefix, exactly as `webServer.register` would.
    const proxy = createUiProxy({ target: () => upstream.url })
    gui = createServer((req, res) => {
      const url = String(req.url ?? '/')
      if (url === PREFIX || url.startsWith(`${PREFIX}/`)) {
        proxy(req, res)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not the plugin')
    })
    await new Promise((resolve) => gui.listen(0, '127.0.0.1', resolve))
    guiUrl = `http://127.0.0.1:${gui.address().port}`
  })

  after(async () => {
    if (upstream !== undefined) await upstream.close()
    if (gui !== undefined) await new Promise((resolve) => gui.close(resolve))
  })

  test('proxies GET /api/state across origins', async () => {
    const response = await fetch(`${guiUrl}${PREFIX}/api/state`)
    assert.equal(response.status, 200)
    const snapshot = await response.json()
    assert.equal(snapshot.bridge.pid, 4242)
    assert.equal(snapshot.runtimeConfig.thinkingLevel, 'high')
  })

  test('proxies a mutating control route', async () => {
    const response = await fetch(`${guiUrl}${PREFIX}/api/control/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskMode: 'creative' }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.runtimeConfig.taskMode, 'creative')
  })

  test('proxies the dashboard shell', async () => {
    const response = await fetch(`${guiUrl}${PREFIX}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<html/i)
  })

  test('streams SSE through the proxy', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch(`${guiUrl}${PREFIX}/api/events`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    try {
      // The first frame is the snapshot; that alone proves the stream survived
      // the extra hop (a buffering proxy would never deliver it).
      while (!seen.includes('state:snapshot')) {
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
    assert.match(seen, /event: state:snapshot/)
  })

  test('answers 503 while the dashboard is still binding', () => {
    const handler = createUiProxy({ target: () => null })
    // A minimal fake response collects the status the proxy writes.
    const written = {}
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        written.status = status
        written.headers = headers
        this.headersSent = true
      },
      end(body) {
        written.body = body
      },
    }
    handler({ url: `${PREFIX}/api/state`, method: 'GET', headers: {} }, res)
    assert.equal(written.status, 503)
    assert.match(String(written.body), /正在启动/)
  })

  test('rewrites the Host header to the upstream authority', async () => {
    // The upstream listener's host check would reject the GUI's own authority,
    // so a forwarded Host is what keeps the control routes usable in-app.
    const response = await fetch(`${guiUrl}${PREFIX}/api/state`, {
      headers: { host: '127.0.0.1:3080' },
    })
    assert.equal(response.status, 200)
  })
})
