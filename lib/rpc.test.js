/**
 * Unit tests for lib/rpc.js and lib/discovery.js.
 *
 * No Antigravity instance is required: the RPC tests drive a throwaway local
 * HTTP server that mimics the Connect/JSON transport (including the real error
 * bodies measured on 2.28.0), and the discovery tests exercise the pure command
 * builders / parsers against captured real output.
 *
 * Run: node --test lib/rpc.test.js
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'

import {
  RPC_SERVICE,
  RpcError,
  cancelCascadeInvocation,
  getCascadeTrajectorySteps,
  getUserStatus,
  isRetryable,
  rpcCall,
  rpcCallResilient,
  waitForConversationFullyIdle,
} from './rpc.js'

import {
  buildListeningPortsCommand,
  buildProcessListCommand,
  commandLineExe,
  languageServerCandidates,
  looksLikeAntigravity,
  parseCsrfFromCommandLine,
  parseCsrfFromHtml,
  parseListeningPorts,
  parseLogPortHints,
  parseLsofListeningPorts,
  parseNetstatListeningPorts,
  parseProcessList,
  parseSsListeningPorts,
  probePort,
} from './discovery.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const CSRF = '11111111-2222-3333-4444-555555555555'

/**
 * Start a local Connect-ish server. `handler(req, body, url)` returns
 * `{status, json}`; a throw means "drop the connection".
 */
async function startServer(handler) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      let result
      try {
        result = handler(req, body, req.url)
      } catch (error) {
        req.socket.destroy(error)
        return
      }
      const payload = typeof result.json === 'string' ? result.json : JSON.stringify(result.json ?? {})
      res.writeHead(result.status ?? 200, {
        'content-type': result.contentType ?? 'application/json',
      })
      res.end(payload)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    server: { port, csrf: CSRF, httpScheme: 'http' },
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A port that is guaranteed closed: bind, read the number, release it. */
async function closedPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// ---------------------------------------------------------------------------
// RpcError / isRetryable
// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it('honours the flag carried by RpcError', () => {
    assert.equal(isRetryable(new RpcError('x', { retryable: true })), true)
    assert.equal(isRetryable(new RpcError('x', { retryable: false })), false)
  })

  it('treats a business error (HTTP 500 unknown) as terminal', () => {
    const error = new RpcError('executor is not currently running', {
      code: 'unknown',
      httpStatus: 500,
      retryable: false,
    })
    assert.equal(isRetryable(error), false)
  })

  it('treats a stale token (401) and gateway statuses as retryable', () => {
    assert.equal(
      isRetryable(new RpcError('unauthenticated', { code: 'unauthenticated', httpStatus: 401, retryable: true })),
      true,
    )
    assert.equal(isRetryable(new RpcError('busy', { httpStatus: 503, retryable: true })), true)
  })

  it('classifies raw transport errors by code or cause.code', () => {
    assert.equal(isRetryable(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true)
    assert.equal(isRetryable(Object.assign(new Error('gone'), { code: 'ECONNRESET' })), true)
    assert.equal(isRetryable(Object.assign(new Error('slow'), { name: 'TimeoutError' })), true)
  })

  it('does not retry an unrelated error', () => {
    assert.equal(isRetryable(new TypeError('boom')), false)
    assert.equal(isRetryable(undefined), false)
    assert.equal(isRetryable(null), false)
  })
})

// ---------------------------------------------------------------------------
// rpcCall — request shaping, parsing, error mapping
// ---------------------------------------------------------------------------

describe('rpcCall', () => {
  it('posts to the frozen service path with the three mandatory headers', async () => {
    const fake = await startServer(() => ({ status: 200, json: { userStatus: { name: 'yu wu' } } }))
    try {
      const payload = await rpcCall(fake.server, 'GetUserStatus', {})
      assert.deepEqual(payload, { userStatus: { name: 'yu wu' } })

      const [request] = fake.requests
      assert.equal(request.method, 'POST')
      assert.equal(request.url, `/${RPC_SERVICE}/GetUserStatus`)
      assert.equal(request.headers['connect-protocol-version'], '1')
      assert.equal(request.headers['x-codeium-csrf-token'], CSRF)
      assert.match(request.headers['content-type'], /application\/json/)
      assert.equal(request.body, '{}')
    } finally {
      await fake.close()
    }
  })

  it('serialises the body and defaults it to {}', async () => {
    const fake = await startServer(() => ({ status: 200, json: {} }))
    try {
      await rpcCall(fake.server, 'GetCascadeTrajectory', { cascadeId: 'abc' })
      await rpcCall(fake.server, 'GetUserStatus')
      assert.equal(fake.requests[0].body, '{"cascadeId":"abc"}')
      assert.equal(fake.requests[1].body, '{}')
    } finally {
      await fake.close()
    }
  })

  it('maps a Connect error body onto RpcError fields', async () => {
    const fake = await startServer(() => ({
      status: 401,
      json: { code: 'unauthenticated', message: 'unauthenticated: invalid CSRF token' },
    }))
    try {
      await assert.rejects(
        () => rpcCall(fake.server, 'GetUserStatus', {}),
        (error) => {
          assert.ok(error instanceof RpcError)
          assert.equal(error.code, 'unauthenticated')
          assert.equal(error.httpStatus, 401)
          assert.equal(error.method, 'GetUserStatus')
          assert.equal(error.retryable, true)
          assert.match(error.message, /invalid CSRF token/)
          return true
        },
      )
    } finally {
      await fake.close()
    }
  })

  it('keeps a 500 business error non-retryable', async () => {
    const fake = await startServer(() => ({
      status: 500,
      json: { code: 'unknown', message: 'trajectory not found (error ID: deadbeef)' },
    }))
    try {
      await assert.rejects(
        () => rpcCall(fake.server, 'GetCascadeTrajectory', { cascadeId: 'nope' }),
        (error) => {
          assert.equal(error.code, 'unknown')
          assert.equal(error.httpStatus, 500)
          assert.equal(error.retryable, false)
          return true
        },
      )
    } finally {
      await fake.close()
    }
  })

  it('reports a plain 404 as an unimplemented method', async () => {
    const fake = await startServer(() => ({
      status: 404,
      json: '404 page not found',
      contentType: 'text/plain',
    }))
    try {
      await assert.rejects(
        () => rpcCall(fake.server, 'NoSuchMethod', {}),
        (error) => {
          assert.equal(error.code, 'unimplemented')
          assert.equal(error.httpStatus, 404)
          assert.equal(error.retryable, false)
          return true
        },
      )
    } finally {
      await fake.close()
    }
  })

  it('reports a non-JSON 2xx body as a parse error', async () => {
    const fake = await startServer(() => ({ status: 200, json: 'not json at all', contentType: 'text/plain' }))
    try {
      await assert.rejects(
        () => rpcCall(fake.server, 'GetUserStatus', {}),
        (error) => {
          assert.equal(error.code, 'parse')
          assert.equal(error.httpStatus, 200)
          return true
        },
      )
    } finally {
      await fake.close()
    }
  })

  it('classifies a refused connection as a retryable network error', async () => {
    const port = await closedPort()
    await assert.rejects(
      () => rpcCall({ port, csrf: CSRF }, 'GetUserStatus', {}),
      (error) => {
        assert.ok(error instanceof RpcError)
        assert.equal(error.code, 'network')
        assert.equal(error.retryable, true)
        return true
      },
    )
  })

  it('rejects incomplete server info with a classified error', async () => {
    await assert.rejects(() => rpcCall({ csrf: CSRF }, 'GetUserStatus', {}), RpcError)
    await assert.rejects(() => rpcCall({ port: 1 }, 'GetUserStatus', {}), RpcError)
  })

  it('turns a caller abort into a non-retryable aborted error', async () => {
    const fake = await startServer(() => {
      throw new Error('drop')
    })
    try {
      const controller = new AbortController()
      const pending = rpcCall(fake.server, 'GetUserStatus', {}, { signal: controller.signal })
      controller.abort()
      await assert.rejects(pending, (error) => {
        assert.ok(error instanceof RpcError)
        assert.equal(error.code, 'aborted')
        assert.equal(error.retryable, false)
        return true
      })
    } finally {
      await fake.close()
    }
  })
})

// ---------------------------------------------------------------------------
// rpcCallResilient
// ---------------------------------------------------------------------------

describe('rpcCallResilient', () => {
  it('retries exactly once with a refreshed server after a stale token', async () => {
    const fake = await startServer((_req, _body, url) => {
      if (url.endsWith('/GetUserStatus')) {
        return { status: 401, json: { code: 'unauthenticated', message: 'invalid CSRF token' } }
      }
      return { status: 200, json: {} }
    })
    try {
      const calls = []
      const getServer = async ({ refresh = false } = {}) => {
        calls.push(refresh)
        return fake.server
      }
      await assert.rejects(() => rpcCallResilient(getServer, 'GetUserStatus', {}), RpcError)
      assert.deepEqual(calls, [false, true], 'one discovery, then one refresh')
      assert.equal(fake.requests.length, 2, 'the method was called twice')
    } finally {
      await fake.close()
    }
  })

  it('succeeds on the retry when the refreshed server is healthy', async () => {
    let seen = 0
    const fake = await startServer(() => {
      seen += 1
      return seen === 1
        ? { status: 401, json: { code: 'unauthenticated', message: 'invalid CSRF token' } }
        : { status: 200, json: { userStatus: { name: 'ok' } } }
    })
    try {
      const payload = await rpcCallResilient(async () => fake.server, 'GetUserStatus', {})
      assert.deepEqual(payload, { userStatus: { name: 'ok' } })
      assert.equal(seen, 2)
    } finally {
      await fake.close()
    }
  })

  it('does not retry a terminal business error', async () => {
    const fake = await startServer(() => ({
      status: 500,
      json: { code: 'unknown', message: 'trajectory not found' },
    }))
    try {
      let refreshes = 0
      const getServer = async ({ refresh = false } = {}) => {
        if (refresh) refreshes += 1
        return fake.server
      }
      await assert.rejects(() => rpcCallResilient(getServer, 'GetCascadeTrajectory', { cascadeId: 'x' }), RpcError)
      assert.equal(refreshes, 0)
      assert.equal(fake.requests.length, 1)
    } finally {
      await fake.close()
    }
  })

  it('wraps a discovery failure into a retryable RpcError', async () => {
    await assert.rejects(
      () =>
        rpcCallResilient(
          async () => {
            throw new Error('Antigravity 桌面端没有在运行')
          },
          'GetUserStatus',
          {},
        ),
      (error) => {
        assert.ok(error instanceof RpcError)
        assert.equal(error.code, 'network')
        assert.equal(error.retryable, true)
        assert.match(error.message, /没有在运行/)
        return true
      },
    )
  })

  it('wraps a failed refresh into a retryable RpcError', async () => {
    const fake = await startServer(() => ({ status: 503, json: { code: 'unavailable', message: 'starting' } }))
    try {
      const getServer = async ({ refresh = false } = {}) => {
        if (refresh) throw new Error('Antigravity 重启中')
        return fake.server
      }
      await assert.rejects(
        () => rpcCallResilient(getServer, 'GetUserStatus', {}),
        (error) => {
          assert.ok(error instanceof RpcError)
          assert.equal(error.retryable, true)
          assert.match(error.message, /重启中/)
          return true
        },
      )
    } finally {
      await fake.close()
    }
  })

  it('rejects a non-function discovery callback', async () => {
    await assert.rejects(() => rpcCallResilient(undefined, 'GetUserStatus', {}), RpcError)
  })
})

// ---------------------------------------------------------------------------
// thin wrappers
// ---------------------------------------------------------------------------

describe('thin method wrappers', () => {
  it('getUserStatus posts an empty body', async () => {
    const fake = await startServer(() => ({ status: 200, json: { userStatus: {} } }))
    try {
      await getUserStatus(fake.server)
      assert.equal(fake.requests[0].url, `/${RPC_SERVICE}/GetUserStatus`)
      assert.equal(fake.requests[0].body, '{}')
    } finally {
      await fake.close()
    }
  })

  it('getCascadeTrajectorySteps returns the steps array and forwards startIndex', async () => {
    const fake = await startServer(() => ({
      status: 200,
      json: { steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }, { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' }] },
    }))
    try {
      const steps = await getCascadeTrajectorySteps(fake.server, 'cascade-1', { startIndex: 3 })
      assert.equal(steps.length, 2)
      assert.equal(fake.requests[0].body, '{"cascadeId":"cascade-1","startIndex":3}')
    } finally {
      await fake.close()
    }
  })

  it('getCascadeTrajectorySteps tolerates call options in the third slot', async () => {
    const fake = await startServer(() => ({ status: 200, json: { steps: [] } }))
    try {
      const steps = await getCascadeTrajectorySteps(fake.server, 'cascade-1', { timeoutMs: 5_000 })
      assert.deepEqual(steps, [])
      assert.equal(fake.requests[0].body, '{"cascadeId":"cascade-1"}')
    } finally {
      await fake.close()
    }
  })

  it('getCascadeTrajectorySteps merges startIndex with call options', async () => {
    const fake = await startServer(() => ({ status: 200, json: { steps: [] } }))
    try {
      await getCascadeTrajectorySteps(fake.server, 'cascade-1', { startIndex: 7, timeoutMs: 5_000 })
      assert.equal(fake.requests[0].body, '{"cascadeId":"cascade-1","startIndex":7}')
      await getCascadeTrajectorySteps(fake.server, 'cascade-1', { startIndex: 2 }, { timeoutMs: 4_000 })
      assert.equal(fake.requests[1].body, '{"cascadeId":"cascade-1","startIndex":2}')
    } finally {
      await fake.close()
    }
  })

  it('getCascadeTrajectorySteps returns [] for a payload without steps', async () => {
    const fake = await startServer(() => ({ status: 200, json: {} }))
    try {
      assert.deepEqual(await getCascadeTrajectorySteps(fake.server, 'cascade-1'), [])
    } finally {
      await fake.close()
    }
  })

  it('waitForConversationFullyIdle posts the conversation id', async () => {
    const fake = await startServer(() => ({ status: 200, json: {} }))
    try {
      await waitForConversationFullyIdle(fake.server, 'conv-1')
      assert.equal(fake.requests[0].url, `/${RPC_SERVICE}/WaitForConversationFullyIdle`)
      assert.equal(fake.requests[0].body, '{"conversationId":"conv-1"}')
    } finally {
      await fake.close()
    }
  })

  it('cancelCascadeInvocation reports an idle executor structurally instead of throwing', async () => {
    const fake = await startServer(() => ({
      status: 500,
      json: { code: 'unknown', message: 'executor is not currently running (error ID: abc)' },
    }))
    try {
      const result = await cancelCascadeInvocation(fake.server, 'cascade-1')
      assert.equal(result.cancelled, false)
      assert.equal(result.code, 'unknown')
    } finally {
      await fake.close()
    }
  })

  it('cancelCascadeInvocation reports success for a running executor', async () => {
    const fake = await startServer(() => ({ status: 200, json: {} }))
    try {
      assert.deepEqual(await cancelCascadeInvocation(fake.server, 'cascade-1'), { cancelled: true })
    } finally {
      await fake.close()
    }
  })

  it('cancelCascadeInvocation still throws other failures', async () => {
    const fake = await startServer(() => ({ status: 401, json: { code: 'unauthenticated', message: 'bad token' } }))
    try {
      await assert.rejects(() => cancelCascadeInvocation(fake.server, 'cascade-1'), RpcError)
    } finally {
      await fake.close()
    }
  })
})

// ---------------------------------------------------------------------------
// discovery — pure command builders
// ---------------------------------------------------------------------------

describe('buildProcessListCommand', () => {
  it('uses Get-CimInstance on Windows and filters by exe name', () => {
    const command = buildProcessListCommand('windows')
    assert.equal(command.file, 'powershell.exe')
    assert.ok(command.args.includes('-NoProfile'))
    const script = command.args.at(-1)
    assert.match(script, /Get-CimInstance Win32_Process/)
    assert.match(script, /Name='language_server\.exe'/)
    assert.match(script, /ProcessId/)
    assert.match(script, /CommandLine/)
  })

  it('uses ps with a header-free format on POSIX', () => {
    const command = buildProcessListCommand('posix')
    assert.equal(command.file, 'ps')
    assert.deepEqual(command.args, ['-ax', '-o', 'pid=,command='])
  })
})

describe('buildListeningPortsCommand', () => {
  it('uses netstat -ano on Windows', () => {
    assert.deepEqual(buildListeningPortsCommand('windows', 1234), {
      file: 'netstat.exe',
      args: ['-ano', '-p', 'TCP'],
    })
  })

  it('uses pid-scoped lsof on POSIX', () => {
    assert.deepEqual(buildListeningPortsCommand('posix', 1234, 'lsof'), {
      file: 'lsof',
      args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', '1234'],
    })
  })

  it('degrades to ss -tlnp on POSIX', () => {
    assert.deepEqual(buildListeningPortsCommand('posix', 1234, 'ss'), {
      file: 'ss',
      args: ['-tlnp'],
    })
  })
})

// ---------------------------------------------------------------------------
// discovery — parsers (inputs captured from the real machine)
// ---------------------------------------------------------------------------

describe('parseCsrfFromCommandLine', () => {
  const real =
    'C:\\Users\\example\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe ' +
    '--standalone --override_ide_name antigravity --subclient_type hub --override_ide_version 2.28.0 ' +
    '--https_server_port 0 --csrf_token 11111111-2222-3333-4444-555555555555 --app_data_dir antigravity'

  it('extracts the uuid after --csrf_token', () => {
    assert.equal(parseCsrfFromCommandLine(real), CSRF)
  })

  it('accepts the --csrf_token=<uuid> and quoted forms', () => {
    assert.equal(parseCsrfFromCommandLine(`x --csrf_token=${CSRF}`), CSRF)
    assert.equal(parseCsrfFromCommandLine(`x --csrf_token "${CSRF}"`), CSRF)
  })

  it('returns undefined when absent or malformed', () => {
    assert.equal(parseCsrfFromCommandLine('language_server --standalone'), undefined)
    assert.equal(parseCsrfFromCommandLine(''), undefined)
    assert.equal(parseCsrfFromCommandLine(undefined), undefined)
  })
})

describe('parseCsrfFromHtml', () => {
  it('extracts csrfToken from the __APP_CONFIG__ blob', () => {
    const html =
      '<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"' +
      CSRF +
      '","appVersion":"2.28.0"};</script>'
    assert.equal(parseCsrfFromHtml(html), CSRF)
    assert.equal(parseCsrfFromHtml('<html></html>'), undefined)
    assert.equal(parseCsrfFromHtml(undefined), undefined)
  })
})

describe('looksLikeAntigravity', () => {
  it('matches case-insensitively anywhere in the page', () => {
    assert.equal(looksLikeAntigravity('<title>Antigravity</title>'), true)
    assert.equal(looksLikeAntigravity('{"productName":"ANTIGRAVITY"}'), true)
    assert.equal(looksLikeAntigravity('<html>hello</html>'), false)
    assert.equal(looksLikeAntigravity(undefined), false)
  })
})

describe('parseProcessList', () => {
  it('parses Windows pid|command rows', () => {
    const stdout =
      `51120|C:\\...\\language_server.exe --csrf_token ${CSRF} --app_data_dir antigravity\r\n` +
      '\r\n'
    const entries = parseProcessList(stdout, 'windows')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].pid, 51120)
    assert.equal(entries[0].csrf, CSRF)
  })

  it('keeps a Windows row whose command line has no token', () => {
    const entries = parseProcessList('51120|C:\\...\\language_server.exe --standalone', 'windows')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].csrf, undefined)
  })

  it('parses POSIX ps rows and drops non-language-server processes', () => {
    const stdout = [
      '  512 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token ' + CSRF,
      '  900 /usr/libexec/otherd --flag',
      '  901 /usr/bin/language_server_helper',
    ].join('\n')
    const entries = parseProcessList(stdout, 'posix')
    assert.equal(entries.length, 2, 'only language_server* rows survive')
    assert.equal(entries[0].pid, 512)
    assert.equal(entries[0].csrf, CSRF)
    assert.equal(entries[1].pid, 901)
  })

  it('ignores malformed lines', () => {
    assert.deepEqual(parseProcessList('garbage\n\n|x\n0|zero\n', 'windows'), [])
    assert.deepEqual(parseProcessList('', 'posix'), [])
  })
})

describe('parseNetstatListeningPorts', () => {
  const stdout = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2044',
    '  TCP    127.0.0.1:58952        0.0.0.0:0              LISTENING       51120',
    '  TCP    127.0.0.1:58953        0.0.0.0:0              LISTENING       51120',
    '  TCP    127.0.0.1:3080         127.0.0.1:49361        ESTABLISHED     2392',
    '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       2392',
  ].join('\r\n')

  it('returns only LISTENING ports owned by the pid', () => {
    assert.deepEqual(parseNetstatListeningPorts(stdout, 51120), [58952, 58953])
    assert.deepEqual(parseNetstatListeningPorts(stdout, 2392), [3080])
    assert.deepEqual(parseNetstatListeningPorts(stdout, 9999), [])
  })

  it('ignores a pid that only appears as a prefix of another', () => {
    assert.deepEqual(parseNetstatListeningPorts(stdout, 5112), [])
  })
})

describe('parseLsofListeningPorts', () => {
  it('parses LISTEN rows for IPv4 and IPv6', () => {
    const stdout = [
      'language_s 512 user 20u IPv4 0x1234 0t0 TCP 127.0.0.1:58953 (LISTEN)',
      'language_s 512 user 21u IPv6 0x5678 0t0 TCP [::1]:58952 (LISTEN)',
    ].join('\n')
    assert.deepEqual(parseLsofListeningPorts(stdout), [58953, 58952])
    assert.deepEqual(parseLsofListeningPorts(''), [])
  })
})

describe('parseSsListeningPorts', () => {
  const stdout = [
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      511    127.0.0.1:58953   0.0.0.0:*    users:(("language_server",pid=512,fd=6))',
    'LISTEN 0      511    127.0.0.1:8080    0.0.0.0:*    users:(("node",pid=900,fd=20))',
    'ESTAB  0      0      127.0.0.1:58953   127.0.0.1:50000',
  ].join('\n')

  it('keeps only rows owned by the pid', () => {
    assert.deepEqual(parseSsListeningPorts(stdout, 512), [58953])
    assert.deepEqual(parseSsListeningPorts(stdout, 900), [8080])
  })

  it('keeps every LISTEN row when no pid is given', () => {
    assert.deepEqual(parseSsListeningPorts(stdout), [58953, 8080])
  })
})

describe('parseListeningPorts', () => {
  it('auto-detects netstat, lsof and ss output', () => {
    const netstat = '  TCP    127.0.0.1:58953        0.0.0.0:0              LISTENING       51120'
    const lsof = 'language_s 512 user 20u IPv4 0x1 0t0 TCP 127.0.0.1:58952 (LISTEN)'
    const ss = 'LISTEN 0 511 127.0.0.1:58951 0.0.0.0:* users:(("language_server",pid=512,fd=6))'
    assert.deepEqual(parseListeningPorts(netstat, 51120), [58953])
    assert.deepEqual(parseListeningPorts(lsof, 512), [58952])
    assert.deepEqual(parseListeningPorts(ss, 512), [58951])
    assert.deepEqual(parseListeningPorts('', 512), [])
  })
})

describe('parseLogPortHints', () => {
  const log = [
    'ERROR: logging before google.Init: I1029 08:34:22.495630       1 server.go:757] Language server listening on random port at 58952 for HTTPS (gRPC)',
    'ERROR: logging before google.Init: I1029 08:34:22.556768       1 server.go:765] Language server listening on random port at 58953 for HTTP',
  ].join('\n')

  it('separates HTTP and HTTPS hints', () => {
    assert.deepEqual(parseLogPortHints(log), { http: [58953], https: [58952] })
  })

  it('returns empty lists for a log without the lines', () => {
    assert.deepEqual(parseLogPortHints('nothing here'), { http: [], https: [] })
    assert.deepEqual(parseLogPortHints(undefined), { http: [], https: [] })
  })
})

describe('languageServerCandidates', () => {
  it('always offers the AGY_LANGUAGE_SERVER override and the macOS path', () => {
    const previous = process.env.AGY_LANGUAGE_SERVER
    process.env.AGY_LANGUAGE_SERVER = '/custom/language_server'
    try {
      const candidates = languageServerCandidates()
      assert.equal(candidates[0], '/custom/language_server')
      assert.ok(candidates.includes('/Applications/Antigravity.app/Contents/Resources/bin/language_server'))
    } finally {
      if (previous === undefined) delete process.env.AGY_LANGUAGE_SERVER
      else process.env.AGY_LANGUAGE_SERVER = previous
    }
  })
})

describe('commandLineExe', () => {
  it('extracts an unquoted Windows exe path', () => {
    const commandLine =
      'C:\\Users\\example\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe ' +
      '--standalone --csrf_token ' + CSRF
    assert.equal(
      commandLineExe(commandLine),
      'C:\\Users\\example\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe',
    )
  })

  it('extracts an unquoted POSIX path', () => {
    assert.equal(
      commandLineExe('/Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token x'),
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
    )
  })

  it('unwraps quoted paths', () => {
    assert.equal(commandLineExe('"/opt/agy/bin/language_server" --csrf_token x'), '/opt/agy/bin/language_server')
    assert.equal(commandLineExe("'C:\\Program Files\\agy\\language_server.exe' --x"), 'C:\\Program Files\\agy\\language_server.exe')
  })

  it('returns undefined for an empty command line', () => {
    assert.equal(commandLineExe(''), undefined)
    assert.equal(commandLineExe(undefined), undefined)
  })
})

// ---------------------------------------------------------------------------
// discovery — port identity probe
// ---------------------------------------------------------------------------

describe('probePort', () => {
  it('identifies an HTTP Antigravity port and returns its scheme and csrf', async () => {
    const fake = await startServer(() => ({
      status: 200,
      contentType: 'text/html',
      json: `<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"${CSRF}"};</script>`,
    }))
    try {
      const hit = await probePort(fake.port)
      assert.equal(hit.port, fake.port)
      assert.equal(hit.httpScheme, 'http')
      assert.equal(hit.csrf, CSRF)
    } finally {
      await fake.close()
    }
  })

  it('rejects an HTTP port that is not Antigravity', async () => {
    const fake = await startServer(() => ({ status: 200, contentType: 'text/html', json: '<html>hello</html>' }))
    try {
      assert.equal(await probePort(fake.port, { allowHttps: false }), undefined)
    } finally {
      await fake.close()
    }
  })

  it('rejects a closed port without throwing', async () => {
    const port = await closedPort()
    assert.equal(await probePort(port, { timeoutMs: 1_000 }), undefined)
  })

  it('rejects an invalid port without throwing', async () => {
    assert.equal(await probePort(0), undefined)
    assert.equal(await probePort(Number.NaN), undefined)
  })
})
