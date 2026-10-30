import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const clientJsPath = new URL('../client.js', import.meta.url)
const uiIndexPath = new URL('../ui/index.html', import.meta.url)
const packageJsonPath = new URL('../package.json', import.meta.url)

const clientJs = readFileSync(clientJsPath, 'utf8')
const uiHtml = readFileSync(uiIndexPath, 'utf8')
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

describe('War Room UI Static Contract Tests', () => {
  it('client.js 注册全局侧边栏图标且不挂入更多菜单', () => {
    assert.ok(
      clientJs.includes("'sidebar.panellist'") || clientJs.includes('"sidebar.panellist"'),
      'client.js 必须注册全局面板图标 slots (sidebar.panellist)，使用户能直接从侧边栏一键唤出驾驶舱',
    )
    assert.strictEqual(
      clientJs.includes('sidebar.panellist.actions'),
      false,
      'client.js 绝不得再向 sidebar.panellist.actions 注册二级菜单项，避免驾驶舱入口被折叠隐藏在更多菜单中',
    )
  })

  it('client.js 注册 main 面板且不含 layout.selectPanel', () => {
    assert.ok(
      clientJs.includes("name: 'main'") || clientJs.includes('name: "main"'),
      'client.js 必须向 main 槽位注册主区域面板',
    )
    assert.ok(
      clientJs.includes('key: PANEL_ID') ||
        clientJs.includes("key: 'antigravity-warroom'") ||
        clientJs.includes('key: "antigravity-warroom"'),
      'client.js 的 main 注册 key 必须为 PANEL_ID 或 antigravity-warroom，以配合侧边栏同 id 自动切换机制',
    )
    assert.strictEqual(
      clientJs.includes('layout.selectPanel'),
      false,
      'client.js 绝不得调用 layout.selectPanel，应由宿主侧边栏通过相同 id/key 自动激活面板，防止引入脆弱的 layout 耦合',
    )
  })

  it('client.js 零宿主私有依赖且使用 hostRouteUrl 动态解析路径', () => {
    assert.strictEqual(
      clientJs.includes('@deepseek-ai/dsh-client-ui-primitives'),
      false,
      'client.js 必须保持轻量 iframe 容器形态，严禁引入宿主内部组件库 @deepseek-ai/dsh-client-ui-primitives',
    )
    assert.ok(
      clientJs.includes('hostRouteUrl'),
      'client.js 必须使用 hostRouteUrl 动态解析 iframe 地址，确保在反向代理子路径下能正确加载',
    )
    assert.strictEqual(
      clientJs.includes("'/antigravity-executor/'") || clientJs.includes('"/antigravity-executor/"'),
      false,
      'client.js 绝不能硬编码绝对根路径 /antigravity-executor/，必须通过 hostRouteUrl("antigravity-executor/") 相对基址计算',
    )
  })

  it('ui/index.html 不含绝对根路径 API 字符串', () => {
    const absoluteApiRegex = /['"`]\/api\//
    assert.strictEqual(
      absoluteApiRegex.test(uiHtml),
      false,
      'ui/index.html 中所有请求必须经由 apiUrl 相对基址解析，绝不能包含 "/api/" 绝对根路径，否则在宿主代理前缀下会 404',
    )
    assert.ok(
      uiHtml.includes('function apiUrl'),
      'ui/index.html 必须定义 apiUrl 辅助函数以正确兼容宿主反向代理前缀与独立端口运行两种模式',
    )
  })

  it('ui/index.html 不含 document 任务模式选项与分支', () => {
    assert.strictEqual(
      uiHtml.includes('data-value="document"'),
      false,
      'ui/index.html 必须移除 data-value="document" 按钮，因为后端只支持 surgical 与 creative 模式',
    )
    assert.strictEqual(
      uiHtml.includes("effectiveMode === 'document'") || uiHtml.includes('effectiveMode === "document"'),
      false,
      'ui/index.html 必须彻底移除 effectiveMode === "document" 分支逻辑，防止状态回显出现非法模式',
    )
    assert.strictEqual(
      uiHtml.includes('badge-mode-document'),
      false,
      'ui/index.html 必须移除专属的 badge-mode-document 样式定义，避免残留死代码',
    )
  })

  it('ui/index.html 包含宿主主题同步机制与核心 token', () => {
    assert.ok(
      uiHtml.includes('adoptHostTheme'),
      'ui/index.html 必须实现 adoptHostTheme 主题吸附逻辑，使 iframe 能实时同步宿主父级文档的 CSS Token 与深浅配色',
    )
    assert.ok(
      uiHtml.includes('--dsw-alias-bg-base'),
      'ui/index.html 主题同步 token 列表中必须包含核心背景 token --dsw-alias-bg-base',
    )
    assert.ok(
      uiHtml.includes('--dsw-alias-label-primary'),
      'ui/index.html 主题同步 token 列表中必须包含核心文本 token --dsw-alias-label-primary',
    )
  })

  it('package.json 正确打包 client.js 与 ui/index.html 且配置对应导出', () => {
    assert.ok(
      Array.isArray(pkg.files) && pkg.files.includes('client.js'),
      'package.json 的 files 白名单必须包含 client.js，否则发布产物将缺失客户端组件',
    )
    assert.ok(
      Array.isArray(pkg.files) && pkg.files.includes('ui/index.html'),
      'package.json 的 files 白名单必须包含 ui/index.html，否则内嵌 iframe 将无法加载页面正文',
    )
    assert.strictEqual(
      pkg.exports && pkg.exports['./client'],
      './client.js',
      'package.json 的 exports["./client"] 必须指向 ./client.js，以满足 dsh 客户端规范',
    )
  })
})
