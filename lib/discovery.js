/**
 * Cross-platform discovery of the running Antigravity Language Server.
 *
 * What has to be found for every RPC call: the server's HTTP(S) port, its CSRF
 * token, and the executable path (which `agentapi` is invoked through). All
 * three change whenever Antigravity restarts, so discovery is revalidated on a
 * cheap 3 ms identity probe and fully rescanned on demand.
 *
 * Measured on Antigravity 2.28.0 / Windows 11:
 *   - one `language_server.exe` process, ports 58952 (HTTPS, self-signed) and
 *     58953 (HTTP); the HTTP port accepts every Connect method we use;
 *   - `GET /` returns the app shell HTML including `window.__APP_CONFIG__`,
 *     without any token — that is the port identity probe;
 *   - the CSRF token comes from the process command line (`--csrf_token <uuid>`)
 *     and is the same value the root page exposes.
 *
 * Platform branches (CONTRACT.md §3.2):
 *   - Windows: `Get-CimInstance Win32_Process` + `netstat -ano -p TCP`.
 *   - POSIX:   `ps -ax -o pid=,command=` + `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>`,
 *              falling back to `ss -tlnp`.
 *   - Both:    `%APPDATA%\Antigravity\logs\language_server.log` is read first for
 *              port hints ("Language server listening on random port at <port>
 *              for HTTP" / "for HTTPS"), which shortens the scan when netstat is
 *              slow or restricted.
 *
 * The command construction and output parsing are exported as pure functions so
 * they can be unit tested without touching a real process table.
 *
 * @module lib/discovery
 */

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Coarse platform bucket used by every branch below. */
export const platform = process.platform === 'win32' ? 'windows' : 'posix'

const PROCESS_LIST_TIMEOUT_MS = 20_000
const PORT_LIST_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 3_000

/**
 * A discovery failure.
 *
 * CONTRACT.md §3.2 specifies that `discoverLanguageServer` throws a Chinese
 * `Error` when nothing is found; this subclass keeps that contract while adding
 * a stable `code` so callers can branch without string matching.
 */
export class DiscoveryError extends Error {
  constructor(message, { code = 'discovery', detail } = {}) {
    super(message)
    this.name = 'DiscoveryError'
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Run one command without a shell; never throws. */
async function run(file, args, { timeout = PROCESS_LIST_TIMEOUT_MS, env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    })
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error?.message ?? error),
    }
  }
}

/**
 * Command that lists running Language Server processes with their full command
 * line (which is where the CSRF token lives).
 *
 * Windows uses CIM because `wmic` is removed from current Windows builds; POSIX
 * uses `ps` with an explicit format, so the output has no header row to skip.
 *
 * @param {'windows'|'posix'} [plat]
 * @returns {{file: string, args: string[]}}
 */
export function buildProcessListCommand(plat = platform) {
  if (plat === 'windows') {
    const script =
      '$p = Get-CimInstance Win32_Process -Filter "Name=\'language_server.exe\'"; ' +
      "if (-not $p) { '' } else { $p | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" } }"
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
    }
  }
  return { file: 'ps', args: ['-ax', '-o', 'pid=,command='] }
}

/**
 * Command that lists the TCP ports a pid is listening on.
 *
 * `netstat -ano` takes ~40 ms while `Get-NetTCPConnection` takes ~1300 ms, so the
 * cheap one wins on Windows. POSIX prefers `lsof` (pid-scoped, no root needed for
 * own processes) and degrades to `ss -tlnp`, which is present on most Linux
 * images but reports every pid, so the parser filters.
 *
 * @param {'windows'|'posix'} [plat]
 * @param {number} pid
 * @param {'lsof'|'ss'} [posixTool]
 * @returns {{file: string, args: string[]}}
 */
export function buildListeningPortsCommand(plat = platform, pid = 0, posixTool = 'lsof') {
  if (plat === 'windows') {
    return { file: 'netstat.exe', args: ['-ano', '-p', 'TCP'] }
  }
  if (posixTool === 'ss') {
    return { file: 'ss', args: ['-tlnp'] }
  }
  return {
    file: 'lsof',
    args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(Number(pid) || 0)],
  }
}

/**
 * Parse `--csrf_token <uuid>` (also tolerates `--csrf_token=<uuid>` and a
 * quoted value) out of a Language Server command line.
 *
 * @param {string} commandLine
 * @returns {string|undefined}
 */
export function parseCsrfFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine === '') return undefined
  const match = /--csrf_token[ =]"?([0-9A-Za-z_-]{8,})"?/.exec(commandLine)
  return match?.[1]
}

/**
 * Extract the CSRF token from the Language Server root page.
 *
 * The page embeds `window.__APP_CONFIG__ = {..., "csrfToken":"<uuid>", ...}`.
 * Used as a fallback when the process command line is unreadable (restricted
 * `ps`/CIM access) — the value is the same token the command line carries.
 *
 * @param {string} html
 * @returns {string|undefined}
 */
export function parseCsrfFromHtml(html) {
  if (typeof html !== 'string' || html === '') return undefined
  const match = /"csrfToken"\s*:\s*"([^"]+)"/.exec(html)
  return match?.[1]
}

/**
 * Does this HTML look like the Antigravity Language Server root page?
 *
 * The product name appears in both `__APP_CONFIG__` and the `<title>`, so a
 * lowercase substring test is the cheapest reliable identity check.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeAntigravity(text) {
  return typeof text === 'string' && text.toLowerCase().includes('antigravity')
}

/**
 * Parse the process list produced by `buildProcessListCommand`.
 *
 * Windows rows are `pid|commandLine`; POSIX rows are `pid commandLine` with
 * `ps`'s leading padding. Rows for other executables are ignored on POSIX.
 *
 * @param {string} stdout
 * @param {'windows'|'posix'} [plat]
 * @returns {Array<{pid: number, commandLine: string, csrf?: string}>}
 */
export function parseProcessList(stdout, plat = platform) {
  const out = []
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue

    let pid
    let commandLine
    if (plat === 'windows') {
      const sep = line.indexOf('|')
      if (sep <= 0) continue
      pid = Number(line.slice(0, sep))
      commandLine = line.slice(sep + 1).trim()
    } else {
      const match = /^(\d+)\s+(.+)$/.exec(line)
      if (match === null) continue
      pid = Number(match[1])
      commandLine = match[2].trim()
      // `ps -ax` lists every process; keep only the Language Server itself.
      if (!/language_server/i.test(commandLine)) continue
    }
    if (!Number.isFinite(pid) || pid <= 0) continue
    const csrf = parseCsrfFromCommandLine(commandLine)
    out.push({ pid, commandLine, ...(csrf !== undefined ? { csrf } : {}) })
  }
  return out
}

/**
 * Parse `netstat -ano -p TCP` output for the ports one pid listens on.
 *
 * @param {string} stdout
 * @param {number} pid
 * @returns {number[]}
 */
export function parseNetstatListeningPorts(stdout, pid) {
  const ports = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (match === null) continue
    if (Number(match[2]) !== Number(pid)) continue
    ports.push(Number(match[1]))
  }
  return ports
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` output.
 *
 * Rows look like `language_s 1234 user 20u IPv4 0x… 0t0 TCP 127.0.0.1:58953 (LISTEN)`.
 *
 * @param {string} stdout
 * @returns {number[]}
 */
export function parseLsofListeningPorts(stdout) {
  const ports = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /TCP\s+(?:\[[^\]]+\]|[^\s:]+):(\d+)\s+\(LISTEN\)/.exec(line)
    if (match === null) continue
    ports.push(Number(match[1]))
  }
  return ports
}

/**
 * Parse `ss -tlnp` output, keeping only rows owned by `pid`.
 *
 * Rows look like `LISTEN 0 511 127.0.0.1:58953 0.0.0.0:* users:(("language_server",pid=1234,fd=6))`.
 *
 * @param {string} stdout
 * @param {number} [pid]  omit to keep every row
 * @returns {number[]}
 */
export function parseSsListeningPorts(stdout, pid) {
  const ports = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue
    if (pid !== undefined && pid !== null) {
      const owner = /pid=(\d+)/.exec(line)
      if (owner === null || Number(owner[1]) !== Number(pid)) continue
    }
    const match = /\s(?:\[[^\]]+\]|[^\s:]+):(\d+)\s/.exec(line)
    if (match === null) continue
    ports.push(Number(match[1]))
  }
  return ports
}

/**
 * Parse listening ports from any supported tool output.
 *
 * Auto-detects netstat / lsof / ss so callers do not have to know which tool
 * actually answered (the POSIX path tries `lsof` first and may fall back).
 *
 * @param {string} stdout
 * @param {number} pid
 * @returns {number[]}
 */
export function parseListeningPorts(stdout, pid) {
  const text = String(stdout ?? '')
  if (text.trim() === '') return []
  if (/\bLISTENING\b/i.test(text)) return parseNetstatListeningPorts(text, pid)
  if (/\(LISTEN\)/.test(text)) return parseLsofListeningPorts(text)
  if (/users:\(\(/.test(text) || /\bLISTEN\b/.test(text)) return parseSsListeningPorts(text, pid)
  return []
}

/**
 * Parse port hints out of `%APPDATA%\Antigravity\logs\language_server.log`.
 *
 * The server logs its random ports once per start:
 *   `Language server listening on random port at 58952 for HTTPS (gRPC)`
 *   `Language server listening on random port at 58953 for HTTP`
 *
 * @param {string} logText
 * @returns {{http: number[], https: number[]}}
 */
export function parseLogPortHints(logText) {
  const http = []
  const https = []
  const pattern = /listening on random port at (\d{2,5}) for (HTTPS[^\n]*|HTTP)\b/gi
  let match
  while ((match = pattern.exec(String(logText ?? ''))) !== null) {
    const port = Number(match[1])
    if (!Number.isFinite(port) || port <= 0) continue
    if (/^HTTPS/i.test(match[2])) https.push(port)
    else http.push(port)
  }
  return { http, https }
}

/** Path of the Language Server log, per platform. */
export function languageServerLogPath(plat = platform) {
  if (plat === 'windows') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'Antigravity', 'logs', 'language_server.log')
  }
  return join(homedir(), 'Library', 'Application Support', 'Antigravity', 'logs', 'language_server.log')
}

/** Executable candidates, in priority order. */
export function languageServerCandidates() {
  const out = []
  const override = String(process.env.AGY_LANGUAGE_SERVER ?? '').trim()
  if (override !== '') out.push(override)

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    out.push(
      join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
    )
  }
  out.push('/Applications/Antigravity.app/Contents/Resources/bin/language_server')
  if (platform === 'posix') {
    out.push(join(homedir(), '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server'))
  }
  return out
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** First existing Language Server executable, or undefined. */
export function resolveLanguageServer() {
  for (const candidate of languageServerCandidates()) {
    if (candidate && isFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Executable path from a Language Server command line.
 *
 * Windows command lines start with the (usually unquoted, possibly space-bearing)
 * absolute `.exe` path followed by flags; POSIX ones are a single token, possibly
 * quoted. Only used as a fallback when no candidate path exists on disk, so the
 * result is not verified to be a file.
 *
 * @param {string} commandLine
 * @returns {string|undefined}
 */
export function commandLineExe(commandLine) {
  const text = String(commandLine ?? '').trim()
  if (text === '') return undefined

  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(text)
  if (quoted !== null) return quoted[1] ?? quoted[2]

  // Unquoted Windows path: everything up to the `.exe` boundary.
  const winExe = /^(.+?\.exe)(?=\s|$)/i.exec(text)
  if (winExe !== null) return winExe[1]

  // POSIX path: the first whitespace-delimited token.
  return text.split(/\s+/)[0]
}

// ---------------------------------------------------------------------------
// identity probe (HTTP and HTTPS)
// ---------------------------------------------------------------------------

function httpsGetRoot(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
        res.on('error', () => resolve(undefined))
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(undefined))
    req.end()
  })
}

/**
 * Identify one local port: is it the Antigravity Language Server, and over which
 * scheme?
 *
 * HTTP is tried first because it is the working transport (`fetch` cannot relax
 * TLS verification for the self-signed HTTPS port, and every method used here
 * answers on HTTP). The HTTPS probe only runs when the HTTP one misses, so a
 * server that answers on both is labelled `http`.
 *
 * @param {number} port
 * @param {{timeoutMs?: number, allowHttps?: boolean}} [options]
 * @returns {Promise<{port: number, httpScheme: 'http'|'https', csrf?: string} | undefined>}
 */
export async function probePort(port, { timeoutMs = PROBE_TIMEOUT_MS, allowHttps = true } = {}) {
  const numeric = Number(port)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined

  try {
    const response = await fetch(`http://127.0.0.1:${numeric}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (response.ok && looksLikeAntigravity(text)) {
      const csrf = parseCsrfFromHtml(text)
      return { port: numeric, httpScheme: 'http', ...(csrf !== undefined ? { csrf } : {}) }
    }
  } catch {
    // Not an HTTP port (EPROTO on the TLS port, ECONNREFUSED when closed).
  }

  if (!allowHttps) return undefined
  const https = await httpsGetRoot(numeric, timeoutMs)
  if (https !== undefined && https.status >= 200 && https.status < 300 && looksLikeAntigravity(https.text)) {
    const csrf = parseCsrfFromHtml(https.text)
    return { port: numeric, httpScheme: 'https', ...(csrf !== undefined ? { csrf } : {}) }
  }
  return undefined
}

/** Backwards-friendly alias used by the cache revalidation path. */
async function isValid(server) {
  if (server === undefined) return false
  const hit = await probePort(server.port, { timeoutMs: 1_500, allowHttps: true })
  return hit !== undefined && hit.httpScheme === server.httpScheme
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

/** Last known-good result; revalidated with a cheap probe on every call. */
let cachedServerState

/** Clear the in-memory cache; the next `discoverLanguageServer` rescans. */
export function invalidateDiscovery() {
  cachedServerState = undefined
}

/** The cached server, if any (undefined before the first successful scan). */
export function cachedServer() {
  return cachedServerState
}

async function listProcesses() {
  const command = buildProcessListCommand(platform)
  const { stdout } = await run(command.file, command.args, { timeout: PROCESS_LIST_TIMEOUT_MS })
  return parseProcessList(stdout, platform)
}

async function listListeningPorts(pid) {
  if (platform === 'windows') {
    const command = buildListeningPortsCommand('windows', pid)
    const { stdout } = await run(command.file, command.args, { timeout: PORT_LIST_TIMEOUT_MS })
    return parseNetstatListeningPorts(stdout, pid)
  }
  const lsof = buildListeningPortsCommand('posix', pid, 'lsof')
  const lsofResult = await run(lsof.file, lsof.args, { timeout: PORT_LIST_TIMEOUT_MS })
  const viaLsof = parseLsofListeningPorts(lsofResult.stdout)
  if (viaLsof.length > 0) return viaLsof

  const ss = buildListeningPortsCommand('posix', pid, 'ss')
  const ssResult = await run(ss.file, ss.args, { timeout: PORT_LIST_TIMEOUT_MS })
  return parseSsListeningPorts(ssResult.stdout, pid)
}

/** Port hints from the Language Server log; empty when the log is missing. */
async function logPortHints() {
  try {
    const text = await readFile(languageServerLogPath(platform), 'utf8')
    return parseLogPortHints(text)
  } catch {
    return { http: [], https: [] }
  }
}

/**
 * Locate the running Language Server.
 *
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<{exe: string|undefined, pid: number, port: number, csrf: string,
 *                    platform: 'windows'|'posix', httpScheme: 'http'|'https'}>}
 * @throws {DiscoveryError} Chinese, user-facing, when nothing usable is found
 */
export async function discoverLanguageServer({ refresh = false } = {}) {
  if (!refresh && cachedServerState !== undefined && (await isValid(cachedServerState))) {
    return cachedServerState
  }

  // Process enumeration and log hints are independent; running them together
  // keeps a cold scan near the cost of the slower one (~600 ms on Windows).
  const [processes, hints] = await Promise.all([listProcesses(), logPortHints()])

  if (processes.length === 0) {
    // The process list is the only source of the pid and CSRF token, so a miss
    // here is either "not running" or "the process table is unreadable".
    throw new DiscoveryError(
      'Antigravity 桌面端没有在运行（找不到 language_server 进程）。' +
        '请先启动 Antigravity 并登录，然后重试；若已启动，请检查是否有权限读取进程列表。',
      { code: 'process-not-found' },
    )
  }

  const withCsrf = processes.filter((entry) => entry.csrf !== undefined)
  if (withCsrf.length === 0) {
    throw new DiscoveryError(
      '找到 language_server 进程但命令行里没有 --csrf_token；Antigravity 可能还在启动，请稍后重试。',
      { code: 'csrf-not-found', detail: processes.map((entry) => entry.pid) },
    )
  }

  // The exe path is only needed for `agentapi`; prefer a real file, but fall back
  // to whatever the running process reports so discovery still works when the
  // install lives somewhere AGY_LANGUAGE_SERVER does not point at.
  const installedExe = resolveLanguageServer()

  for (const entry of withCsrf) {
    const ports = await listListeningPorts(entry.pid)
    const ordered = [
      ...new Set([...ports, ...hints.http, ...hints.https].filter((port) => Number(port) > 0)),
    ]
    if (ordered.length === 0) continue

    // Probe concurrently: usually exactly one port answers.
    const probes = await Promise.all(ordered.map((port) => probePort(port)))
    const hits = probes.filter(Boolean)
    if (hits.length === 0) continue

    // Prefer the plain HTTP port — it is the one `fetch` can drive.
    const hit = hits.find((item) => item.httpScheme === 'http') ?? hits[0]
    const server = {
      exe: installedExe ?? commandLineExe(entry.commandLine),
      pid: entry.pid,
      port: hit.port,
      csrf: entry.csrf ?? hit.csrf,
      platform,
      httpScheme: hit.httpScheme,
    }
    if (typeof server.csrf !== 'string' || server.csrf === '') continue
    if (server.exe === undefined) {
      throw new DiscoveryError(
        '找到了 Antigravity Language Server，但定位不到它的可执行文件；' +
          '请用 AGY_LANGUAGE_SERVER 环境变量指定 language_server 的完整路径。',
        { code: 'exe-not-found', detail: { pid: entry.pid } },
      )
    }
    cachedServerState = server
    return server
  }

  throw new DiscoveryError(
    '找到了 Antigravity Language Server 进程，但它的 HTTP 端口没有响应。' +
      '请确认 Antigravity 窗口正常打开（最小化即可，不要退出）。',
    { code: 'port-not-found' },
  )
}

/**
 * Discovery callback for `rpcCallResilient`.
 *
 * `{refresh: true}` drops the cache first, so a rotated port/CSRF token after an
 * Antigravity restart is picked up instead of failing the tool call.
 *
 * @param {{refresh?: boolean}} [options]
 */
export async function getServer({ refresh = false } = {}) {
  if (refresh) invalidateDiscovery()
  return await discoverLanguageServer({ refresh })
}
