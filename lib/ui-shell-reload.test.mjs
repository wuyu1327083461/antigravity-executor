import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelemetryBus } from './telemetry.mjs'
import { INDEX_FILE, loadShell, startUiServer } from './ui-server.mjs'

const uiServerMjsPath = new URL('./ui-server.mjs', import.meta.url)

describe('ui-server shell reload and lazy reading', () => {
  it('GET / serves current ui/index.html with status 200 and no-store caching', async (t) => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agy-shell-test-'))
    const bus = createTelemetryBus()
    bus.setWorkspaceDir(tempDir)

    const server = await startUiServer({
      bus,
      host: '127.0.0.1',
      port: 0,
    })

    t.after(async () => {
      await server.close()
      await rm(tempDir, { recursive: true, force: true })
    })

    const res = await fetch(`${server.url}/`)
    assert.equal(res.status, 200, 'GET / 必须返回 HTTP 200')
    assert.match(
      res.headers.get('content-type') ?? '',
      /text\/html/,
      '响应头 content-type 必须为 text/html',
    )
    assert.equal(
      res.headers.get('cache-control'),
      'no-store',
      'cache-control 必须为 no-store，防止浏览器持久缓存旧页面',
    )

    const text = await res.text()
    assert.ok(text.includes('adoptHostTheme'), '响应体必须包含最新注入的 adoptHostTheme 主题吸附逻辑')
    assert.match(text, /<html/i, '响应体必须为有效的 HTML 文档')
  })

  it('loadShell reloads on file mtime modification while caching unchanged reads', async (t) => {
    const originalStat = await stat(INDEX_FILE)

    t.after(async () => {
      // 必须将 mtime 恢复为测试前的时间戳，避免污染仓库文件元数据
      try {
        await utimes(INDEX_FILE, originalStat.atime, originalStat.mtime)
      } catch {
        /* ignore */
      }
    })

    // 1. 首次读取并记录内容与长度
    const first = await loadShell()
    assert.ok(typeof first === 'string' && first.length > 0, '首次 loadShell 必须返回非空字符串')

    // 2. 紧接着再次读取，命中 mtime + size 缓存
    const cached = await loadShell()
    assert.equal(cached, first, '在 mtime 与 size 未发生变化时必须直接返回缓存内容')

    // 3. 将 INDEX_FILE 的 mtime 安全推进 5 秒（不修改文件内容）
    const future = new Date(Date.now() + 5000)
    await utimes(INDEX_FILE, future, future)

    const updatedStat = await stat(INDEX_FILE)
    assert.notEqual(
      updatedStat.mtimeMs,
      originalStat.mtimeMs,
      '测试中必须确认磁盘文件的 mtime 已被成功推进',
    )

    // 4. mtime 变化后再次调用 loadShell，必须触发重新读盘
    const reloaded = await loadShell()
    const diskContent = await readFile(INDEX_FILE, 'utf8')

    assert.equal(reloaded, diskContent, 'mtime 变更后 loadShell 返回的内容必须与磁盘文件最新内容完全一致')
    assert.equal(reloaded.length, first.length, '重读内容长度与原文件长度一致')

    // 恢复原始时间戳
    await utimes(INDEX_FILE, originalStat.atime, originalStat.mtime)
  })

  it('startUiServer does not crash on startup and defers shell reading to request time', async () => {
    // 静态契约断言：startUiServer 启动阶段不再同步或启动时 await readFile(INDEX_FILE)
    const uiServerSrc = await readFile(uiServerMjsPath, 'utf8')
    assert.equal(
      uiServerSrc.includes('shell = await readFile(INDEX_FILE'),
      false,
      'startUiServer 启动阶段绝不能硬编码 await readFile(INDEX_FILE)，必须在请求到来时惰性调用 loadShell',
    )
    assert.ok(
      uiServerSrc.includes('export async function loadShell'),
      'ui-server.mjs 必须具名导出 loadShell 函数以供测试与扩展调用',
    )
    assert.ok(
      uiServerSrc.includes('catch (error) {\n        return sendText(res, 500, error.message)'),
      'GET / 与 GET /index.html 必须捕获 loadShell 异常并返回 500 与清晰可读的错误信息，而不是导致进程崩溃',
    )
  })
})
