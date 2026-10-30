import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const indexJsPath = new URL('./index.js', import.meta.url)

describe('Dashboard Initial Seeding Contract Tests', () => {
  it('lib/index.js 安排了一次延迟且单次的 probeBridge 初始播种，且绝不轮询', async () => {
    const src = await readFile(indexJsPath, 'utf8')

    // 1. setTimeout 延迟探测
    assert.match(
      src,
      /setTimeout\([\s\S]{0,400}probeBridge\(/,
      '必须在 setTimeout 延迟回调中执行 probeBridge，避免阻塞插件激活并给冷启动语言服务留出就绪时间',
    )

    // 2. clearTimeout 存在
    assert.match(
      src,
      /clearTimeout\(/,
      '必须调用 clearTimeout 清理定时器，防止插件重载或卸载后残留悬挂回调',
    )

    // 3. 严禁使用 setInterval 轮询
    assert.strictEqual(
      /setInterval[\s\S]{0,300}probeBridge/.test(src),
      false,
      '绝不得使用 setInterval 轮询 probeBridge，初始探测必须是单次触发，避免在后台持续消耗账号配额',
    )

    // 4. probeBridge 调用计数
    const matches = src.match(/probeBridge\(/g) || []
    assert.ok(
      matches.length >= 2 && matches.length <= 3,
      `probeBridge( 的匹配计数必须在 2 到 3 之间（实际：${matches.length} 次），确保仅在单次播种与手动重新扫描两个入口触发`,
    )
  })

  it('apply() 流程绝不 await probeBridge，保证启动不被阻塞', async () => {
    const src = await readFile(indexJsPath, 'utf8')
    assert.strictEqual(
      /await\s+probeBridge/.test(src),
      false,
      'apply() 及其核心启动流绝不能包含 await probeBridge，必须保持同步或非阻塞返回，以满足 Webview 启动屏障的秒级响应要求',
    )
  })

  it('disposer 中 clearTimeout 必须位于 disposed = true 附近以保证生命周期正确释放', async () => {
    const src = await readFile(indexJsPath, 'utf8')
    const disposedIdx = src.indexOf('disposed = true')
    const clearTimeoutIdx = src.indexOf('clearTimeout(')

    assert.ok(disposedIdx !== -1, 'disposer 中必须包含 disposed = true 标志更新')
    assert.ok(clearTimeoutIdx !== -1, 'disposer 中必须包含 clearTimeout 调用')
    assert.ok(
      clearTimeoutIdx > disposedIdx && clearTimeoutIdx - disposedIdx < 100,
      'clearTimeout 必须紧跟在 disposed = true 之后执行，确保在 HMR 重载或卸载时第一时间取消未触发的探测定时器',
    )
  })
})
