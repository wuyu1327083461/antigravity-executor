/**
 * ConnectRPC client for the Antigravity desktop Language Server.
 *
 * The Language Server exposes its protobuf service over a plain Connect/JSON
 * transport: `POST http://127.0.0.1:<port>/<service>/<Method>` with a JSON body
 * and three mandatory headers. No generated protobuf code, no gRPC library —
 * just `fetch` (and `node:https` for the self-signed HTTPS port).
 *
 * Measured on Antigravity 2.28.0: the HTTP port (58953) accepts every method
 * used here; the HTTPS port (58952) serves the same service but presents a
 * self-signed certificate, so `fetch` fails with `EPROTO`/400 unless the
 * certificate is ignored. Discovery prefers HTTP and only falls back to HTTPS
 * when that is the only port that answers.
 *
 * Error contract (see CONTRACT.md §2): every failure surfaces as `RpcError`
 * carrying `code`, `httpStatus`, `method` and `retryable`; nothing throws a
 * bare, unclassified error.
 *
 * @module lib/rpc
 */

import { request as httpsRequest } from 'node:https'

/** Frozen service name — the URL segment in front of the method. */
export const RPC_SERVICE = 'exa.language_server_pb.LanguageServerService'

/** Default timeout for ordinary calls. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * `WaitForConversationFullyIdle` is a long poll: it blocks until the running
 * turn finishes (measured: a 39.9 s turn returned at 39.9 s), so its default
 * budget has to be far larger than the ordinary call timeout.
 */
const LONG_POLL_TIMEOUT_MS = 180_000

/** Transport-level failures that are worth one rediscovery + retry. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'TimeoutError',
])

/** HTTP statuses that mean "ask discovery again", not "the request was wrong". */
const RETRYABLE_STATUSES = new Set([401, 403, 408, 425, 429, 502, 503, 504])

/**
 * A classified RPC failure.
 *
 * `code` is either the server's Connect code (`unauthenticated`, `unknown`,
 * `internal`, `invalid_argument`, …) or one of the local codes `network`,
 * `http`, `parse`, `config`, `aborted`, `unimplemented`.
 */
export class RpcError extends Error {
  /**
   * @param {string} message  Chinese, user-facing.
   * @param {{code?: string, httpStatus?: number, method?: string, retryable?: boolean, body?: unknown}} [details]
   */
  constructor(message, { code = 'unknown', httpStatus, method, retryable = false, body } = {}) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.httpStatus = httpStatus
    this.method = method
    this.retryable = retryable
    this.body = body
  }
}

/**
 * Should the caller rediscover the server and try once more?
 *
 * True for transport failures (connection refused/reset, timeout), a stale
 * CSRF token (401/403) and gateway/unavailable statuses. Business errors —
 * "trajectory not found", "executor is not currently running" — come back as
 * HTTP 500 with a Connect code and must NOT trigger a rediscovery.
 */
export function isRetryable(error) {
  if (error === undefined || error === null) return false
  if (error instanceof RpcError) return error.retryable === true

  const code = typeof error.code === 'string' ? error.code : undefined
  if (code !== undefined && NETWORK_CODES.has(code)) return true
  const causeCode = typeof error?.cause?.code === 'string' ? error.cause.code : undefined
  if (causeCode !== undefined && NETWORK_CODES.has(causeCode)) return true
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
  return false
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status)
}

function rpcUrl(server, method) {
  const scheme = server?.httpScheme === 'https' ? 'https' : 'http'
  return `${scheme}://127.0.0.1:${Number(server?.port)}/${RPC_SERVICE}/${method}`
}

/**
 * Map a thrown transport error to a classified `RpcError`.
 *
 * `fetch` hides the interesting part in `error.cause.code`, so both levels are
 * inspected; an abort coming from the caller's own signal is never retryable.
 */
function toNetworkError(error, method, { signal, timeoutMs } = {}) {
  if (signal?.aborted === true) {
    return new RpcError('RPC 调用已取消。', { code: 'aborted', method, retryable: false })
  }
  const code = error?.cause?.code ?? error?.code
  const detail = typeof code === 'string' ? code : String(error?.message ?? error)
  if (error?.name === 'TimeoutError' || detail === 'ETIMEDOUT' || detail === 'TimeoutError') {
    return new RpcError(
      `连接 Antigravity Language Server 超时（${timeoutMs}ms 内没有响应）。` +
        '请确认 Antigravity 窗口正常打开（最小化即可，不要退出）。',
      { code: 'network', method, retryable: true },
    )
  }
  return new RpcError(
    `无法连接 Antigravity Language Server（${detail}）。` +
      '请确认 Antigravity 桌面端正在运行并已登录。',
    { code: 'network', method, retryable: true },
  )
}

/** One POST through global `fetch` (plain HTTP, and HTTPS when trusted). */
async function fetchPost(url, headers, bodyText, { timeoutMs, signal }) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal !== undefined) signals.push(signal)
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyText,
    signal: AbortSignal.any(signals),
  })
  const text = await response.text()
  return { status: response.status, text, contentType: response.headers.get('content-type') }
}

/**
 * One POST through `node:https`, ignoring the self-signed certificate.
 *
 * `fetch` cannot relax certificate verification without a dispatcher package
 * (and this plugin takes zero dependencies), so the HTTPS port goes through
 * `node:https` directly. The HTTP port remains the default path.
 */
function httpsPost(url, headers, bodyText, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text, contentType: res.headers['content-type'] })
        })
        res.on('error', reject)
      },
    )
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    const onAbort = () => {
      req.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))
    }
    req.on('close', () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    })
    req.on('error', reject)
    if (signal !== undefined) {
      if (signal.aborted === true) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    req.write(bodyText)
    req.end()
  })
}

/**
 * Turn one HTTP response into the parsed payload, or throw a classified error.
 *
 * Connect encodes failures as a JSON body `{code, message}`; a plain 404 page
 * means the method does not exist on this server (older builds).
 */
function parseResponse(response, method) {
  const trimmed = String(response.text ?? '').trim()
  const status = Number(response.status)
  let payload
  let parsed = true
  if (trimmed === '') {
    payload = {}
  } else {
    try {
      payload = JSON.parse(trimmed)
    } catch {
      parsed = false
      payload = undefined
    }
  }

  if (status >= 200 && status < 300) {
    if (!parsed) {
      throw new RpcError(
        `RPC ${method} 返回了非 JSON 响应（HTTP ${status}）：${trimmed.slice(0, 200)}`,
        { code: 'parse', httpStatus: status, method, retryable: false, body: trimmed.slice(0, 400) },
      )
    }
    return payload
  }

  if (parsed && payload !== null && typeof payload === 'object') {
    const code = typeof payload.code === 'string' && payload.code !== '' ? payload.code : 'http'
    const message =
      typeof payload.message === 'string' && payload.message !== ''
        ? payload.message
        : trimmed.slice(0, 200)
    throw new RpcError(`RPC ${method} 失败（HTTP ${status}，${code}）：${message}`, {
      code,
      httpStatus: status,
      method,
      retryable: isRetryableStatus(status),
      body: payload,
    })
  }

  if (status === 404) {
    throw new RpcError(`RPC 方法 ${method} 不存在（HTTP 404），当前 Antigravity 版本可能不支持该接口。`, {
      code: 'unimplemented',
      httpStatus: 404,
      method,
      retryable: false,
      body: trimmed.slice(0, 200),
    })
  }

  throw new RpcError(`RPC ${method} 失败（HTTP ${status}）：${trimmed.slice(0, 200)}`, {
    code: 'http',
    httpStatus: status,
    method,
    retryable: isRetryableStatus(status),
    body: trimmed.slice(0, 200),
  })
}

/**
 * One RPC call against one discovered server.
 *
 * @param {{port: number, csrf: string, httpScheme?: 'http'|'https'}} server
 * @param {string} method  bare method name, e.g. `GetUserStatus`
 * @param {object|string} [body]  JSON-serializable request body (default `{}`)
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<object>}
 * @throws {RpcError}
 */
export async function rpcCall(server, method, body, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (typeof method !== 'string' || method === '') {
    throw new RpcError('RPC 方法名不能为空。', { code: 'config', method, retryable: false })
  }
  const port = Number(server?.port)
  if (!Number.isFinite(port) || port <= 0) {
    throw new RpcError('RPC 服务器信息不完整（缺少端口），请重新发现 Antigravity 服务。', {
      code: 'config',
      method,
      retryable: true,
    })
  }
  if (typeof server?.csrf !== 'string' || server.csrf === '') {
    throw new RpcError('RPC 服务器信息不完整（缺少 csrf token），请重新发现 Antigravity 服务。', {
      code: 'config',
      method,
      retryable: true,
    })
  }

  const url = rpcUrl(server, method)
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const headers = {
    'Connect-Protocol-Version': '1',
    'X-Codeium-Csrf-Token': server.csrf,
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(bodyText)),
  }

  let response
  try {
    response =
      server?.httpScheme === 'https'
        ? await httpsPost(url, headers, bodyText, { timeoutMs, signal })
        : await fetchPost(url, headers, bodyText, { timeoutMs, signal })
  } catch (error) {
    throw toNetworkError(error, method, { signal, timeoutMs })
  }
  return parseResponse(response, method)
}

/** Wrap a discovery failure (plain Chinese `Error`) into a classified RpcError. */
function wrapDiscoveryError(error, method) {
  if (error instanceof RpcError) return error
  return new RpcError(
    String(error?.message ?? error ?? '无法定位 Antigravity Language Server。'),
    { code: 'network', method, retryable: true },
  )
}

/**
 * Call once, and on a retryable failure rediscover the server and call again.
 *
 * REQ-06: Antigravity restarting rotates both port and CSRF token, so the cached
 * server must be invalidated and rescanned instead of surfacing a hard failure.
 * Exactly one retry — a second failure is real and belongs to the caller.
 *
 * @param {() => Promise<object>} getServer  discovery callback, e.g. `getServer`
 * @param {string} method
 * @param {object} [body]
 * @param {{timeoutMs?: number, signal?: AbortSignal, retry?: boolean}} [opts]
 * @returns {Promise<object>}
 */
export async function rpcCallResilient(getServer, method, body, opts = {}) {
  if (typeof getServer !== 'function') {
    throw new RpcError('rpcCallResilient 需要一个可用的服务发现回调。', {
      code: 'config',
      method,
      retryable: false,
    })
  }
  const { retry = true, ...callOpts } = opts ?? {}

  let server
  try {
    server = await getServer({ refresh: false })
  } catch (error) {
    throw wrapDiscoveryError(error, method)
  }

  try {
    return await rpcCall(server, method, body, callOpts)
  } catch (error) {
    if (retry === false || !isRetryable(error)) throw error

    let refreshed
    try {
      refreshed = await getServer({ refresh: true })
    } catch (discoveryError) {
      throw wrapDiscoveryError(discoveryError, method)
    }
    return await rpcCall(refreshed, method, body, callOpts)
  }
}

// ---------------------------------------------------------------------------
// thin method wrappers — signatures frozen by CONTRACT.md §3.1
// ---------------------------------------------------------------------------

/** @returns {Promise<object>} `{userStatus:{name,email,planStatus,cascadeModelConfigData,...}}` */
export async function getUserStatus(server, opts = {}) {
  return await rpcCall(server, 'GetUserStatus', {}, opts)
}

/** @returns {Promise<object>} `{response:{groups:[{displayName,buckets:[...]}]}}` */
export async function retrieveQuotaSummary(server, opts = {}) {
  return await rpcCall(server, 'RetrieveUserQuotaSummary', {}, opts)
}

/** Full trajectory: `{trajectory:{steps:[...], executorMetadatas:[...]}}`. */
export async function getCascadeTrajectory(server, cascadeId, opts = {}) {
  return await rpcCall(server, 'GetCascadeTrajectory', { cascadeId }, opts)
}

/**
 * Steps of one cascade.
 *
 * `startIndex` is forwarded verbatim as documented in CONTRACT.md. Measured
 * caveat: the 2.28.0 server currently answers the full step list regardless of
 * `startIndex`, so callers must not rely on it to filter — dedupe by step order
 * instead (the wrapper still returns exactly the server's array).
 *
 * Accepted call shapes (both are used across the codebase):
 *   `(server, id, { startIndex }, { timeoutMs })` — CONTRACT.md §3.1 signature
 *   `(server, id, { startIndex, timeoutMs })`   — merged shorthand
 *
 * @returns {Promise<object[]>}
 */
export async function getCascadeTrajectorySteps(server, cascadeId, options = {}, opts) {
  const requestOptions = options ?? {}
  const callOpts = { ...(opts ?? {}) }
  for (const key of ['timeoutMs', 'signal', 'retry']) {
    if (requestOptions[key] !== undefined) {
      callOpts[key] = requestOptions[key]
      delete requestOptions[key]
    }
  }

  const body = { cascadeId }
  const index = Number(requestOptions.startIndex)
  if (Number.isFinite(index) && index >= 0) body.startIndex = Math.floor(index)

  const payload = await rpcCall(server, 'GetCascadeTrajectorySteps', body, callOpts)
  return Array.isArray(payload?.steps) ? payload.steps : []
}

/** `{trajectorySummaries: {<cascadeId>: {status, stepCount, lastModifiedTime, annotations}}}`. */
export async function getAllCascadeTrajectories(server, opts = {}) {
  return await rpcCall(server, 'GetAllCascadeTrajectories', {}, opts)
}

/**
 * Long poll: resolves when the conversation is fully idle.
 *
 * Busy conversations block until the turn ends (measured: returns at the exact
 * end of a 39.9 s turn); an already idle conversation answers in ~34 ms.
 *
 * @returns {Promise<void>}
 */
export async function waitForConversationFullyIdle(server, conversationId, opts = {}) {
  const callOpts = { timeoutMs: LONG_POLL_TIMEOUT_MS, ...(opts ?? {}) }
  await rpcCall(server, 'WaitForConversationFullyIdle', { conversationId }, callOpts)
}

/**
 * Ask the server to cancel a running cascade.
 *
 * Cancelling an idle cascade is a no-op on the server side and answers HTTP 500
 * `{"code":"unknown","message":"executor is not currently running"}`. That case
 * is reported structurally as `{cancelled:false}` instead of throwing, because
 * callers (turn.js) treat a failed cancel as non-fatal.
 *
 * @returns {Promise<object>} `{cancelled:true}` or `{cancelled:false, reason}`
 */
export async function cancelCascadeInvocation(server, cascadeId, opts = {}) {
  try {
    await rpcCall(server, 'CancelCascadeInvocation', { cascadeId }, opts)
    return { cancelled: true }
  } catch (error) {
    if (error instanceof RpcError && /not currently running/i.test(error.message)) {
      return { cancelled: false, reason: 'executor is not currently running', code: error.code }
    }
    throw error
  }
}

/** `{metadata:{...staticConfig, cascadeConfig, workspaces, ...}}`. */
export async function getConversationMetadata(server, conversationId, opts = {}) {
  return await rpcCall(server, 'GetConversationMetadata', { conversationId }, opts)
}
