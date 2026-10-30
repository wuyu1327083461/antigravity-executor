/**
 * The War Room HTTP + SSE surface (UI-REQ-01 … UI-REQ-06, server half).
 *
 * WHY `node:http` AND NOT THE HOST'S OWN WEB SERVER
 * ------------------------------------------------
 * The dashboard is reachable at `http://127.0.0.1:18420` whether or not dsh's
 * Web GUI is running, which is the point: the executor isa headless tool that a
 * user watches from a browser tab, and the dsh page is only one of the things
 * they may have open. Binding an explicit loopback listener also keeps the
 * security story simple and auditable — the whole attack surface is the one
 * socket this module owns, not a seat inside the app's own router.
 *
 * FIVE THINGS THAT ARE EASY TO GET WRONG HERE
 * -------------------------------------------
 * 1. **Port release on HMR (UI-REQ-01).** A dsh reload re-runs `apply()` while
 *    the previous server is still holding 18420. `close()` alone does NOT
 *    release it — it only stops accepting and waits for live connections, and
 *    an open SSE stream never ends. Every response is therefore tracked, and
 *    disposal ends them first, then calls `closeAllConnections()`, then
 *    `close()`. A bind failure falls forward to the next port and reports the
 *    real address instead of dying.
 * 2. **Zero cost with no browser (REQ-04).** `broadcast()` returns before
 *    touching `JSON.stringify` when no client is connected; the snapshot in
 *    `telemetry.mjs` is the only thing kept current.
 * 3. **Path traversal on the preview route (REQ-04 §4.1).** `path.resolve` the
 *    request against the active workspace and require the result to start with
 *    `workspace + sep`. A raw `startsWith(workspace)` is the classic bug: it
 *    accepts `C:\work-evil` for workspace `C:\work`.
 * 4. **Write routes are loopback-only (§4.2).** The listener already binds
 *    127.0.0.1, but a browser can still be tricked into POSTing from another
 *    origin, so `Origin`/`Host` are checked on every mutating route.
 * 5. **Backpressure.** A slow or dead tab must not accumulate frames forever in
 *    a Node stream buffer, so a client whose `res.write()` returns false is
 *    dropped rather than queued.
 * 6. **UI shell mtime caching.** The loopback listener outlives file edits (it
 *    only restarts on a full plugin reload). Rather than pinning the HTML shell
 *    read once at startup, `loadShell()` checks the file's mtime/size fingerprint
 *    on page loads, allowing dashboard edits to take effect immediately on
 *    browser refresh without a process restart.
 *
 * @module antigravity-executor/lib/ui-server
 */

import { createReadStream, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bound to loopback only; the PRD forbids 0.0.0.0. */
export const DEFAULT_UI_HOST = '127.0.0.1'
/** The PRD's default port (§2.2). */
export const DEFAULT_UI_PORT = 18420
/** How many ports to try before giving up. */
const PORT_ATTEMPTS = 10
/** SSE heartbeat: keeps a proxy/idle-timeout from closing a quiet stream. */
const HEARTBEAT_MS = 15_000
/** Largest JSON body accepted on a control route. */
const MAX_BODY_BYTES = 256 * 1024
/** Largest artifact served to the drawer. */
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024

const PKG_DIR = fileURLToPath(new URL('../', import.meta.url))
const UI_DIR = join(PKG_DIR, 'ui')
export const INDEX_FILE = join(UI_DIR, 'index.html')

/** Cached UI shell plus the stat fingerprint it was read at. */
let shellCache = { text: null, mtimeMs: -1, size: -1 }

/**
 * Read `ui/index.html`, reusing the cached copy while the file is unchanged.
 *
 * A dashboard edit has to be visible on the next browser refresh: the listener
 * outlives every HMR reload of the Host half (`ctx.effect` only re-runs on a
 * plugin reload), so a shell read once at startup pins the page to whatever was
 * on disk when the process started. One `stat` per page load is free next to
 * the 100 KiB body it guards.
 */
export async function loadShell() {
  const info = await stat(INDEX_FILE).catch(() => null)
  if (info === null) throw new Error(`可视化界面缺少 ui/index.html（${INDEX_FILE}）`)
  if (shellCache.text !== null && shellCache.mtimeMs === info.mtimeMs && shellCache.size === info.size) {
    return shellCache.text
  }
  const text = await readFile(INDEX_FILE, 'utf8')
  shellCache = { text, mtimeMs: info.mtimeMs, size: info.size }
  return text
}

/** Extension → content type for the preview proxy and the UI shell. */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
})

/** Is the request's Origin header one we serve? */
function isLoopbackOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') return true
  try {
    const url = new URL(String(origin))
    const host = url.hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** Is the request's Host header a loopback authority? */
function isLoopbackHost(header) {
  if (header === undefined || header === null || header === '') return true
  const host = String(header).split(':')[0].toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/** Write a JSON response. */
function sendJson(res, status, value) {
  if (res.writableEnded === true) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Write a plain-text response. */
function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.writableEnded === true) return
  const body = String(text ?? '')
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * Read and parse a JSON body with a hard size cap.
 *
 * @returns {Promise<{ok: true, value: any}|{ok: false, error: string}>}
 */
function readJsonBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return finish({ ok: true, value: {} })
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return finish({ ok: false, error: '请求体必须是 JSON 对象' })
        }
        finish({ ok: true, value: parsed })
      } catch (error) {
        finish({ ok: false, error: `JSON 解析失败：${error.message}` })
      }
    })
    req.on('error', (error) => finish({ ok: false, error: `读取请求失败：${error.message}` }))
  })
}

/**
 * Resolve `relative` inside `root`, or refuse.
 *
 * The `+ sep` is the whole point: `C:\work-evil` starts with `C:\work` but is
 * not inside it.
 *
 * @param {string} root absolute workspace directory
 * @param {string} relative URL path, already decoded and stripped of the route prefix
 * @returns {{path: string}|{error: string}}
 */
export function resolveInsideWorkspace(root, relative) {
  if (typeof root !== 'string' || root.trim() === '') {
    return { error: '当前没有活跃的 workspace_dir，预览不可用' }
  }
  const base = resolve(root)
  const baseWithSep = base.endsWith(sep) ? base : `${base}${sep}`
  // A leading separator would make `resolve` treat the path as absolute on
  // POSIX; strip it so the result is always computed *relative to* the base.
  const cleaned = String(relative ?? '').replace(/^[/\\]+/, '')
  if (cleaned === '') return { error: '缺少预览文件路径' }
  const target = resolve(base, cleaned)
  if (target !== base && !target.startsWith(baseWithSep)) {
    return { error: `路径越界（Path Traversal Guard）：${target}` }
  }
  return { path: target }
}

/** Serve one file from disk with a content type. */
async function serveFile(res, filePath, { head = false } = {}) {
  let stats
  try {
    stats = statSync(filePath)
  } catch {
    return sendText(res, 404, 'Not Found')
  }
  if (stats.isDirectory()) {
    // A directory request means "the page in it", which is what an iframe for
    // `folder/` expects.
    return serveFile(res, join(filePath, 'index.html'), { head })
  }
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  if (head) {
    res.writeHead(200, {
      'content-type': type,
      'content-length': stats.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    return res.end()
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': stats.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    if (!res.writableEnded) res.end()
  })
  return stream.pipe(res)
}

/**
 * Start the dashboard server.
 *
 * @param {object} options
 * @param {object} options.bus telemetry bus from `createTelemetryBus`
 * @param {() => object|null} options.getControlServer `() => server|null` used by
 *   `abort`/`rescan`; returns the live Language Server handle, or null
 * @param {(patch: object) => Promise<object>} options.applyConfig runtime config
 *   mutation; resolves with the new effective config
 * @param {(sessionId: string) => Promise<any>} options.evictSession
 * @param {() => Promise<Array<object>>} options.listSessions re-reads the stores
 * @param {() => Promise<Array<object>>} options.listArtifacts
 * @param {() => boolean} options.skipPacing wakes the pacer
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @returns {Promise<{url: string, port: number, host: string, clients: number,
 *                    close: () => Promise<void>, started: boolean,
 *                    note?: string}>}
 */
export async function startUiServer({
  bus,
  getControlServer,
  applyConfig,
  evictSession,
  listSessions,
  listArtifacts,
  skipPacing,
  log = () => {},
  host = DEFAULT_UI_HOST,
  port = DEFAULT_UI_PORT,
} = {}) {
  /** Live SSE responses, so disposal can end them before closing the socket. */
  const streams = new Set()

  // --- SSE ---------------------------------------------------------------

  /**
   * Push one frame to every live client.
   *
   * Returns immediately when nobody is connected: that early return is the
   * whole REQ-04 "no client, no overhead" guarantee (no stringify, no I/O).
   */
  function broadcast(type, data) {
    if (streams.size === 0) return
    const payload = JSON.stringify(data ?? {})
    // A CR/LF inside a JSON string cannot break the framing (it is escaped),
    // but a turn summary can contain one; JSON.stringify already escapes it.
    const frame = `event: ${type}\ndata: ${payload}\n\n`
    for (const res of [...streams]) {
      try {
        // `false` means the kernel buffer is full: this client is not keeping
        // up (a backgrounded tab, a dead socket). Dropping it is better than
        // growing an unbounded buffer for a page nobody is looking at.
        if (res.write(frame) === false) {
          streams.delete(res)
          try {
            res.end()
          } catch {
            /* already gone */
          }
        }
      } catch {
        streams.delete(res)
      }
    }
  }

  const unsubscribe = bus.subscribe(broadcast)

  const heartbeat = setInterval(() => {
    if (streams.size === 0) return
    for (const res of [...streams]) {
      try {
        res.write('event: ping\ndata: {}\n\n')
      } catch {
        streams.delete(res)
      }
    }
  }, HEARTBEAT_MS)
  // A heartbeat must never be the reason the process stays alive.
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  // --- routes ------------------------------------------------------------

  /**
   * Every route in one table, matched in order.
   *
   * Keeping the table data-driven is what makes the "which routes mutate state"
   * check (`mutating`) a single declaration instead of a second list that can
   * drift out of sync with the handlers.
   */
  async function handle(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase()
    // `req.url` is origin-form; parse it so query strings and percent-escapes
    // are handled by a real URL parser rather than by hand.
    let url
    try {
      url = new URL(String(req.url ?? '/'), `http://${host}:${port}`)
    } catch {
      return sendText(res, 400, 'Bad Request')
    }
    const path = url.pathname

    const mutating = method !== 'GET' && method !== 'HEAD'
    if (mutating) {
      // REQ-04 §4.2: a mutating call must come from a loopback page.
      if (!isLoopbackOrigin(req.headers.origin) || !isLoopbackHost(req.headers.host)) {
        return sendJson(res, 403, { ok: false, error: '只接受来自本机 127.0.0.1 / localhost 的写操作' })
      }
    }

    // --- GET / ------------------------------------------------------------
    if (path === '/' || path === '/index.html') {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false })
      let shell
      try {
        shell = await loadShell()
      } catch (error) {
        return sendText(res, 500, error.message)
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      return res.end(method === 'HEAD' ? undefined : shell)
    }

    // --- GET /api/state ---------------------------------------------------
    if (path === '/api/state') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false })
      return sendJson(res, 200, bus.snapshot())
    }

    // --- GET /api/events (SSE) -------------------------------------------
    if (path === '/api/events') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false })
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Belt and braces against a buffering intermediary.
        'x-accel-buffering': 'no',
      })
      // A retry hint keeps reconnects quick after a dsh reload.
      res.write('retry: 2000\n\n')
      streams.add(res)
      // The first frame is the whole present, so a page that connects
      // mid-turn renders immediately instead of waiting for the next change.
      try {
        res.write(`event: state:snapshot\ndata: ${JSON.stringify(bus.snapshot())}\n\n`)
      } catch {
        /* the client vanished during the handshake */
      }
      const drop = () => {
        streams.delete(res)
      }
      req.on('close', drop)
      req.on('error', drop)
      res.on('error', drop)
      res.on('close', drop)
      return undefined
    }

    // --- POST /api/control/* ---------------------------------------------
    if (path.startsWith('/api/control/')) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' })
      const body = await readJsonBody(req)
      if (body.ok !== true) return sendJson(res, 400, { ok: false, error: body.error })
      const action = path.slice('/api/control/'.length)

      if (action === 'abort') {
        const reason = String(body.value.reason ?? 'dashboard emergency stop')
        return sendJson(res, 200, await onAbort(reason))
      }
      if (action === 'skip-pacing') {
        try {
          const skipped = skipPacing() === true
          return sendJson(res, 200, { ok: true, skipped })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error.message })
        }
      }
      if (action === 'rescan') {
        try {
          const status = await onRescan()
          bus.setBridge(status)
          return sendJson(res, 200, { ok: true, bridge: status })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error.message })
        }
      }
      if (action === 'config') {
        try {
          const next = await applyConfig(body.value)
          return sendJson(res, 200, { ok: true, runtimeConfig: next })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message })
        }
      }
      return sendJson(res, 404, { ok: false, error: `未知控制指令：${action}` })
    }

    // --- POST /api/sessions/evict ----------------------------------------
    if (path === '/api/sessions/evict') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' })
      const body = await readJsonBody(req)
      if (body.ok !== true) return sendJson(res, 400, { ok: false, error: body.error })
      const sessionId = String(body.value.sessionId ?? '').trim()
      if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId 不能为空' })
      try {
        const removed = await evictSession(sessionId)
        return sendJson(res, 200, { ok: true, removed, sessions: await listSessions() })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error.message })
      }
    }

    // --- GET /api/artifact -----------------------------------------------
    if (path === '/api/artifact') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false })
      const conversationId = String(url.searchParams.get('conversationId') ?? '').trim()
      const file = String(url.searchParams.get('file') ?? '').trim()
      if (conversationId === '' || file === '') {
        return sendJson(res, 400, { ok: false, error: '需要 conversationId 与 file 参数' })
      }
      // The brain directory lives outside the workspace, so it is resolved by
      // the artifact helper rather than by the preview guard — but the *file
      // name* is still attacker-controlled, so it is validated here.
      if (!/^[\w.\-]+\.(md|txt|json|html?)$/i.test(file) || file.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法产物文件名' })
      }
      try {
        const text = await readArtifact(conversationId, file)
        if (text === null) return sendJson(res, 404, { ok: false, error: '产物不存在' })
        return sendText(res, 200, text)
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error.message })
      }
    }

    // --- GET /api/workspace-preview/* ------------------------------------
    if (path.startsWith('/api/workspace-preview/')) {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false })
      const relative = decodeURIComponent(path.slice('/api/workspace-preview/'.length))
      const target = resolveInsideWorkspace(bus.workspaceDir(), relative)
      if (target.error !== undefined) {
        // 403 (not 404) on purpose: a traversal attempt must be visible, and it
        // must never be retried as "maybe the file moved".
        return sendText(res, target.error.startsWith('路径越界') ? 403 : 404, target.error)
      }
      return serveFile(res, target.path, { head: method === 'HEAD' })
    }

    return sendJson(res, 404, { ok: false, error: `未知路由：${path}` })
  }

  /** Read one brain artifact by conversation + file name. */
  async function readArtifact(conversationId, file) {
    const reader = readArtifactImpl
    if (typeof reader !== 'function') return null
    return reader(conversationId, file)
  }
  /** Installed by `startUiServer`'s caller through `setArtifactReader`. */
  let readArtifactImpl
  function setArtifactReader(fn) {
    readArtifactImpl = fn
  }

  // --- abort / rescan ----------------------------------------------------

  /**
   * Emergency stop (UI-REQ-04).
   *
   * The cancellation latency is measured and published because the PRD sells
   * "80 ms physical cut" — a number that must be observable, not asserted.
   */
  async function onAbort(reason) {
    const turnId = bus.activeTurnId()
    const startedAt = Date.now()
    const server = typeof getControlServer === 'function' ? getControlServer() : null
    if (server === null || server === undefined) {
      return { ok: false, error: '当前没有可用的 Language Server 连接，无法下发取消指令' }
    }
    const conversationId =
      typeof getActiveConversationId === 'function' ? getActiveConversationId() : null
    if (conversationId === null) {
      return { ok: false, error: '当前没有正在执行的回合' }
    }
    try {
      await cancelCascade(server, conversationId)
      const cancelLatencyMs = Date.now() - startedAt
      if (turnId !== null) {
        bus.abortTurn(turnId, { trigger: 'manual', reason, cancelLatencyMs })
      }
      return { ok: true, turnId, cancelLatencyMs }
    } catch (error) {
      return { ok: false, error: `取消失败：${error.message}`, cancelLatencyMs: Date.now() - startedAt }
    }
  }
  /** Hooks the caller installs; declared here so `onAbort` reads clearly. */
  let getActiveConversationId = () => null
  let cancelCascade = async () => {
    throw new Error('cancel 通道未接线')
  }

  function setAbortHooks({ conversationId, cancel }) {
    if (typeof conversationId === 'function') getActiveConversationId = conversationId
    if (typeof cancel === 'function') cancelCascade = cancel
  }

  /** Re-scan the desktop Language Server (bridge indicator's recovery button). */
  async function onRescan() {
    const rescan = typeof rescanBridge === 'function' ? rescanBridge : null
    if (rescan === null) throw new Error('重新扫描通道未接线')
    return await rescan()
  }
  let rescanBridge = null
  function setRescan(fn) {
    if (typeof fn === 'function') rescanBridge = fn
  }

  // --- listen ------------------------------------------------------------

  const server = createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((error) => {
      log(`[antigravity-executor] UI 请求处理失败：${error?.message ?? error}`)
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        else if (!res.writableEnded) res.end()
      } catch {
        /* the socket is already gone */
      }
    })
  })

  /**
   * Bind, falling forward through the next ports on EADDRINUSE (UI-REQ-01 §2.2).
   *
   * `port: 0` asks the OS for any free port. Reading the bound port from
   * `server.address()` is required in that case: the requested number stays 0
   * while the socket listens elsewhere, and reporting the request would print a
   * URL nobody can connect to.
   *
   * @returns {Promise<number>} the actually bound port
   */
  async function listenWithFallback() {
    let lastError
    for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
      const candidate = Number(port) + offset
      const bound = await new Promise((resolveAttempt) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          resolveAttempt({ error })
        }
        const onListening = () => {
          server.removeListener('error', onError)
          const actual = server.address()
          const resolvedPort =
            actual !== null && typeof actual === 'object' ? Number(actual.port) : candidate
          resolveAttempt({ port: Number.isFinite(resolvedPort) ? resolvedPort : candidate })
        }
        server.once('error', onError)
        server.once('listening', onListening)
        try {
          server.listen(candidate, host)
        } catch (error) {
          server.removeListener('error', onError)
          server.removeListener('listening', onListening)
          resolveAttempt({ error })
        }
      })
      if (bound.error === undefined) return bound.port
      lastError = bound.error
      // Only a port collision is worth stepping forward for; anything else
      // (EACCES, an invalid host) will fail identically on every attempt.
      if (bound.error?.code !== 'EADDRINUSE') break
      log(`[antigravity-executor] 端口 ${candidate} 已被占用，尝试 ${candidate + 1}`)
    }
    throw new Error(
      `无法在 ${host}:${port} 起监听（已尝试 ${PORT_ATTEMPTS} 个端口）：${
        lastError?.message ?? 'unknown'
      }`,
    )
  }

  let boundPort
  try {
    boundPort = await listenWithFallback()
  } catch (error) {
    clearInterval(heartbeat)
    unsubscribe()
    throw error
  }

  // A listener error after bind must not crash the host process.
  server.on('error', (error) => {
    log(`[antigravity-executor] UI server 错误：${error?.message ?? error}`)
  })

  const url = `http://${host}:${boundPort}`
  const note =
    Number(boundPort) === Number(port)
      ? undefined
      : `首选端口 ${port} 被占用，已改用 ${boundPort}`

  /**
   * Tear the server down and release the port (UI-REQ-01 §2.2).
   *
   * The order is load-bearing: end the SSE streams first (otherwise `close()`
   * waits for them forever), then destroy any remaining sockets, then close.
   */
  async function close() {
    clearInterval(heartbeat)
    try {
      unsubscribe()
    } catch {
      /* already detached */
    }
    for (const res of [...streams]) {
      try {
        res.end()
      } catch {
        /* already gone */
      }
    }
    streams.clear()
    try {
      server.closeAllConnections?.()
    } catch {
      /* not available on this Node build */
    }
    await new Promise((resolveClose) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolveClose()
      }
      try {
        server.close(() => done())
      } catch {
        return done()
      }
      // Never hang a reload on a socket that will not drain.
      const timer = setTimeout(done, 1500)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  return {
    url,
    host,
    port: boundPort,
    get clients() {
      return streams.size
    },
    close,
    setArtifactReader,
    setAbortHooks,
    setRescan,
    note: note ?? null,
    broadcast,
  }
}

export default startUiServer
