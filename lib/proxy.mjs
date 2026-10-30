/**
 * Same-origin proxy from dsh's own web server to the War Room listener.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard binds its own loopback port (18420 by default), and the dsh Web
 * GUI is served from a *different* origin (its own port). A browser page on the
 * GUI origin therefore cannot `fetch('http://127.0.0.1:18420/api/state')` or hold
 * an `EventSource` to it — both are cross-origin, and the control routes
 * deliberately refuse foreign `Origin` headers for safety (§4.2).
 *
 * Rather than weaken those control routes with a CORS allowance, the Host half
 * exposes a same-origin path (`/antigravity-executor`) that forwards to the
 * listener. The page then talks to `/antigravity-executor/api/...` with no CORS
 * involvement at all, while the standalone `http://127.0.0.1:18420` surface stays
 * exactly as locked down as before.
 *
 * The proxy is intentionally a dumb pipe: it forwards the method, path, query and
 * body, and streams the response back without buffering, so Server-Sent Events
 * keep working through it. It adds no authentication of its own because the
 * upstream listener already enforces the loopback-Origin rule on every mutating
 * route — a request arriving through the proxy still carries the page's own
 * Origin and is judged by the same rule.
 *
 * @module antigravity-executor/lib/proxy
 */

import { request as httpRequest } from 'node:http'

/** Hop-by-hop headers that must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Build the proxy handler.
 *
 * @param {object} options
 * @param {() => string|null} options.target `() => 'http://127.0.0.1:18420'` or
 *   null while the listener is still binding
 * @param {() => void} [options.onUnavailable] called when there is no target yet
 * @returns {(req: import('node:http').IncomingMessage,
 *            res: import('node:http').ServerResponse) => void}
 */
export function createUiProxy({ target, onUnavailable = () => {} }) {
  return function handleProxy(req, res) {
    const base = target()
    if (typeof base !== 'string' || base === '') {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('驾驶舱正在启动，请稍后重试')
      onUnavailable()
      return
    }

    let upstream
    try {
      upstream = new URL(base)
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('驾驶舱地址无效')
      return
    }

    // The plugin's mount path is `/antigravity-executor`; everything after it is
    // the listener's own path. `req.url` is origin-form and already includes the
    // prefix, so it is stripped with the same constant the route declares.
    const prefix = '/antigravity-executor'
    const raw = String(req.url ?? '/')
    const forwarded = raw.startsWith(prefix) ? raw.slice(prefix.length) || '/' : '/'

    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue
      // The upstream listener's Host check accepts a loopback authority; the
      // incoming Host is the GUI's, which would be rejected, so it is rewritten.
      if (key.toLowerCase() === 'host') continue
      headers[key] = value
    }
    headers.host = `${upstream.hostname}:${upstream.port}`

    const proxied = httpRequest(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: forwarded,
        headers,
      },
      (upstreamRes) => {
        const responseHeaders = {}
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) continue
          responseHeaders[key] = value
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
        // Stream rather than buffer: an SSE response never ends, so buffering it
        // would hang the page forever.
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => {
          try {
            res.end()
          } catch {
            /* socket already gone */
          }
        })
      },
    )

    proxied.on('error', (error) => {
      if (res.headersSent === true) {
        try {
          res.end()
        } catch {
          /* already gone */
        }
        return
      }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `驾驶舱代理失败：${error.message}` }))
    })

    // A page that navigates away must not leave the upstream request hanging.
    res.on('close', () => {
      try {
        proxied.destroy()
      } catch {
        /* already closed */
      }
    })

    req.pipe(proxied)
  }
}
