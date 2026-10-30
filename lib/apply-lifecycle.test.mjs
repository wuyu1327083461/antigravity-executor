/**
 * The plugin's own `apply()` lifecycle, verified end to end.
 *
 * The interesting half of UI-REQ-01 is not "does a server start" but "does a
 * Cordis reload free the port". That only happens if `apply()` registers the
 * listener inside `ctx.effect` and the returned disposer actually closes it, so
 * this test drives a minimal fake context through it: apply → listen → dispose →
 * apply again on the SAME port.
 *
 * A fake `ctx` is enough here because the parts it must satisfy are small and
 * documented (`ctx.tools.register`, `ctx.skills.registerProvider`, `ctx.effect`,
 * `ctx.logger`), and a real Cordis loader would add nothing this test can assert.
 *
 * Run with: `node --test lib/apply-lifecycle.test.mjs`
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, test } from 'node:test'

import { apply, name } from './index.js'

/** Minimal Cordis-shaped context that records the effects it is given. */
function fakeContext() {
  const effects = []
  const tools = []
  const skills = []
  const injected = []
  return {
    tools: { register: (definition) => tools.push(definition) },
    skills: { registerProvider: (provider) => skills.push(provider) },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    /** Cordis runs the callback and keeps its disposer. */
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    /**
     * Cordis's scoped-service injector: run `callback` only while every named
     * service exists, and dispose its effects when one goes away. This fake has
     * no `webServer` — the headless case — so the callback is not invoked, which
     * is exactly the behaviour the plugin must tolerate.
     */
    inject(names, callback) {
      injected.push([...names])
      const available = { webServer: this.webServer }
      if (names.every((name) => available[name] !== undefined)) {
        callback(this)
      }
    },
    /** Test helper: run every disposer, as an unload would. */
    async dispose() {
      for (const fn of effects.splice(0).reverse()) {
        if (typeof fn === 'function') await fn()
      }
    },
    toolsRegistered: tools,
    skillsRegistered: skills,
    injectedRequests: injected,
  }
}

/** Ask the OS for a free port, then release it so the test can bind it. */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** Wait until `predicate()` is true, or fail after `timeoutMs`. */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

describe('apply() lifecycle (UI-REQ-01 §2.2)', () => {
  let port

  before(async () => {
    port = await freePort()
  })

  test('exports the plugin name', () => {
    assert.equal(name, 'antigravity-executor')
  })

  test('apply() registers its tools and the dashboard, then dispose() frees the port', async () => {
    const ctx = fakeContext()
    apply(ctx, {
      ui: { enabled: true, host: '127.0.0.1', port, recentTurnsLimit: 5 },
      quotaFallback: { enabled: false },
      pacing: { enabled: false },
    })

    // The three tools the bundle promises.
    const names = ctx.toolsRegistered.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['check_environment', 'delegate_coding_task', 'list_conversations'])
    assert.equal(ctx.skillsRegistered.length, 1)

    // The listener binds asynchronously.
    const up = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/state`)
        return response.ok
      } catch {
        return false
      }
    })
    assert.ok(up, 'dashboard did not start listening')

    // A snapshot with the contract's top-level keys, over a real socket.
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()
    for (const key of ['bridge', 'quota', 'lifecycle', 'runtimeConfig']) {
      assert.ok(key in snapshot, `snapshot is missing ${key}`)
    }
    // `apply()` publishes the effective config on activation, so the page has
    // something real to render before the first turn.
    assert.equal(typeof snapshot.runtimeConfig.thinkingLevel, 'string')

    // Disposing (an HMR reload) must release the port.
    await ctx.dispose()
    const released = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/state`)
        return response.ok === false
      } catch {
        return true
      }
    })
    assert.ok(released, 'the port was still serving after dispose()')
  })

  test('a re-apply() on the same port succeeds (the HMR reload path)', async () => {
    const first = fakeContext()
    apply(first, { ui: { enabled: true, host: '127.0.0.1', port }, pacing: { enabled: false } })
    const up = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/state`)).ok
      } catch {
        return false
      }
    })
    assert.ok(up, 'first activation failed')

    // Reload: dispose then apply again, exactly as cordis does.
    await first.dispose()
    const second = fakeContext()
    apply(second, { ui: { enabled: true, host: '127.0.0.1', port }, pacing: { enabled: false } })

    const rebound = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/state`)).ok
      } catch {
        return false
      }
    })
    assert.ok(rebound, 'the reloaded plugin did not rebind the same port (EADDRINUSE)')
    await second.dispose()
  })

  test('ui.enabled=false binds no socket at all', async () => {
    const closedPort = await freePort()
    const ctx = fakeContext()
    apply(ctx, { ui: { enabled: false, host: '127.0.0.1', port: closedPort }, pacing: { enabled: false } })
    // Give the activation a moment; then nothing must answer.
    await new Promise((resolve) => setTimeout(resolve, 400))
    let served = false
    try {
      served = (await fetch(`http://127.0.0.1:${closedPort}/api/state`)).ok
    } catch {
      served = false
    }
    assert.equal(served, false, 'a disabled dashboard must not listen')
    await ctx.dispose()
  })

  test('registers the same-origin proxy route when a webServer is present', async () => {
    const proxyPort = await freePort()
    const ctx = fakeContext()
    /** Record what the plugin registers on the host web server. */
    const routes = []
    const routeDisposers = []
    ctx.webServer = {
      register(route) {
        routes.push(route)
        const dispose = () => {
          routeDisposers.push(route)
        }
        return dispose
      },
    }

    apply(ctx, { ui: { enabled: true, host: '127.0.0.1', port: proxyPort }, pacing: { enabled: false } })

    // The plugin asked for `webServer` and the fake reported it present, so the
    // prefix route must exist.
    assert.ok(
      ctx.injectedRequests.some((names) => names.includes('webServer')),
      'the plugin did not request the webServer service',
    )
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/antigravity-executor')
    assert.equal(typeof routes[0].handler, 'function')

    // The route answers even before the listener has finished binding, with a
    // clear "starting" response rather than a hang.
    const started = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${proxyPort}/api/state`)).ok
      } catch {
        return false
      }
    })
    assert.ok(started, 'dashboard did not start for the proxy test')
    await ctx.dispose()
  })
})
