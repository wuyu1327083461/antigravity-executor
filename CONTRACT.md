# antigravity-executor 迭代契约（模块接口冻结版）

本文件是并行开发的唯一接口基准。**任何模块改动都要先改这里**，否则其他模块会编译期/运行期对不上。

## 0. 全局约束

- Node ≥ 22.19.0，纯 ESM，**零新增运行时依赖**（不得引入 schemastery、undici 之外的包；只用 `node:*` 内置 + 全局 `fetch`）。
- 不新增独立常驻进程、不引入数据库。所有状态要么在内存，要么是插件目录下的 JSON。
- 现有三个工具名与签名必须保持：`delegate_coding_task` / `check_environment` / `list_conversations`。
- 所有模块导出的函数**不抛**未分类的裸错误：可预期失败返回 `{ error: '...' }` 或抛 `RpcError`（见 §2）。
- 面向用户的文案用中文（与现有实现一致），代码注释用英文，保持现有风格。

## 1. 已验证的本地事实（不要再去猜）

实测环境：Antigravity 2.28.0，`language_server.exe` 监听 `127.0.0.1:58952`(HTTPS) 与 `58953`(HTTP) 两个端口。

| 事实 | 结论 |
| --- | --- |
| `/` 根页面 | 返回 HTML，内含 `window.__APP_CONFIG__` 的 `csrfToken`，**无需 token 即可探测**，用来识别端口 |
| HTTP 端口 | `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>` 可直接 POST JSON |
| 必要请求头 | `Connect-Protocol-Version: 1`、`X-Codeium-Csrf-Token: <csrf>`、`Content-Type: application/json` |
| `WaitForConversationFullyIdle` | **长轮询**：忙时阻塞到回合结束才返回 `{}`；已空闲时 34ms 立即返回。body `{conversationId}` |
| `GetAllCascadeTrajectories` | `{trajectorySummaries: {<cascadeId>: {status, stepCount, lastModifiedTime, annotations.title}}}`，`status` ∈ `CASCADE_RUN_STATUS_IDLE / RUNNING / BUSY / CANCELING` |
| `GetCascadeTrajectorySteps` | body `{cascadeId}` → `{steps: [...]}`。**实测 2.28.0 完全忽略 `startIndex`**（35 步的 cascade 在 startIndex=0/5/20/34/35 都返回 35 条，且非法类型被静默接受，说明 proto 里只有 `cascadeId` 字段）。签名仍转发 `startIndex` 以兼容老版本，但**调用方必须自己按 step 顺序切片去重** |
| `GetCascadeTrajectory` | **返回 `{trajectory: {...}, status, numTotalSteps, ...}`** —— 元数据在 `trajectory.executorMetadatas[]` 里，**不在顶层**。按顶层读取会永远得到 `undefined`（实测曾因此让一个 ERROR 终止的回合跑到 200s 超时） |
| `terminationReason` 取值 | `NO_TOOL_CALL`(正常结束) / `USER_CANCELED` / `ERROR` / `HALTED_STEP` / `MAX_INVOCATIONS` / `MAX_TOKEN_BUDGET_EXCEEDED` / … |
| 磁盘日志滞后 | `transcript*.jsonl` 是异步落盘的，**会落后于 RPC**：实测一个已 IDLE + `terminationReason=ERROR` 的回合，磁盘上只有 `USER_INPUT` 一步，而 RPC 已有 `ERROR_MESSAGE`。结算读取必须用 RPC 覆盖磁盘视图 |
| `CancelCascadeInvocation` | body `{cascadeId}`；空闲时返回 HTTP 500 `{"code":"unknown","message":"executor is not currently running"}` |
| `GetUserStatus` | `{userStatus:{name,email,planStatus:{planInfo:{planName,teamsTier,...}}, cascadeModelConfigData:{clientModelConfigs:[{label,modelId,quotaInfo:{remainingFraction,resetTime}}]}}}` |
| `RetrieveUserQuotaSummary` | `{response:{groups:[{displayName,description,buckets:[{bucketId,displayName,window,remainingFraction,resetTime,description}]}]}}` |
| `StartCascade` | body 至少 `{source:"CORTEX_TRAJECTORY_SOURCE_AGENT_API"}` → `{cascadeId}`。**不带 cascadeConfig 会报 `plan model not specified`**，故不作为主路径 |
| `SendUserCascadeMessage` | body `{cascadeId, userMessage:{text}}` → `{}`。**不会**把消息写进 agentapi 创建的会话的轨迹（实测被忽略），故不作为主路径 |
| 模型档位 | `agentapi new-conversation --model=<flash_lite|flash|pro>` 是唯一可靠的分档入口；`planModel` 恒为 `MODEL_PLACEHOLDER_M322`(tiered) |
| 会话元数据 | agentapi 创建的会话恒为 `workspaces: []`、`enforcedWorkspaceValidation: false` —— 软沙箱前提不变 |
| `transcript.jsonl` | 超约 4000 字符的字段被截断并加 `truncated_fields:["content"]`（实测 step 29: 4018 字符 vs 全文 5720） |
| `transcript_full.jsonl` | 同目录，同 step 顺序，**不截断**（实测同 step 5720 字符完整） |
| RPC steps 里的文本 | `GetCascadeTrajectorySteps` 返回的 step **不截断**（实测 json 8.4KB 无 truncated 标记），可作为二级兜底 |
| RPC 工具调用载体 | 每个工具步骤的 `metadata.toolCall = {id, name, argumentsJson, thinkingSignature}`；`argumentsJson` 是**字符串**，需二次 `JSON.parse` 得到 args（实测 run_command 的完整 CommandLine 无损） |
| RPC 步骤状态机 | 生成中的步骤 `status=CORTEX_STEP_STATUS_RUNNING`，结束时转 `DONE`。工具步骤在生成期可能呈现为 `CORTEX_STEP_TYPE_GENERIC`，落盘后定型为 `RUN_COMMAND`/`VIEW_FILE` 等 —— 判定必须按 `metadata.toolCall.name` 而不是 `type` |
| RPC 命令结果 | `RUN_COMMAND` 步骤带 `runCommand:{commandLine, exitCode, combinedOutput:{full}}` 与 `taskDetails:{id, logUri, progress, description}`；`logUri` 指向 `.system_generated/tasks/<task>.log` |
| 后台命令 | `run_command` 若 `WaitMsBeforeAsync` 到点未完成会转后台，回合内先出 PLANNER_RESPONSE、再由 `CORTEX_STEP_TYPE_SYSTEM_MESSAGE` 回报完成 —— 因此「最后一步是 PLANNER_RESPONSE」不足以判定结束，必须同时看 cascade status 与 terminationReason |
| 常驻命令 | 裸跑 `npm run dev` / `vite` / `next dev` / `vitest`（默认 watch）会永不退出，Cascade 一直是 BUSY，只能等 `maxSeconds` 超时。派单必须禁止，审计用 `parseHangingCommand` 识别并告警 |
| 配额桶命名 | `RetrieveUserQuotaSummary` **没有名为 `pro` 的桶**：`pro` 与 `flash` 共用 `Gemini Models` 的 `gemini-5h` / `gemini-weekly`。按名字找 `pro` 会永远找不到，从而静默关掉保护 |
| 双窗口权重 | 5h 桶用光最多等几小时；`gemini-weekly` 用光可能等好几天，必须用更高水位单独保护 |
| 取消实测 | `CancelCascadeInvocation` 发出后 **81ms** cascade 即转 IDLE，`terminationReason` 变 `EXECUTOR_TERMINATION_REASON_USER_CANCELED`（实测在 RUN_COMMAND 执行中取消） |
| 长轮询实测 | 一次 `WaitForConversationFullyIdle` 覆盖整个回合（实测 39.9s 的回合在回合结束瞬间返回），无需 45s 静默窗口 |
| `agentapi` 多行参数 | 经 `execFile` 传参**不会**截断（实测含换行/引号/`$env:` 的 4 行 prompt 完整落到会话里） |
| brain 目录 | `~/.gemini/antigravity/brain/<conversation-id>/`，产物 `.md` 在根目录，日志在 `.system_generated/logs/` |

## 2. 错误类型

```js
// lib/rpc.js
export class RpcError extends Error {
  code        // string, 服务端 code 或 'network' | 'http' | 'parse'
  httpStatus  // number | undefined
  method      // string, RPC 方法名
  retryable   // boolean: 网络层失败 / 401 / 403 / ECONNREFUSED 时为 true
}
```

## 3. 模块接口（冻结）

### 3.1 `lib/rpc.js` — ConnectRPC 客户端

```js
export const RPC_SERVICE = 'exa.language_server_pb.LanguageServerService'
export class RpcError extends Error {}
export function isRetryable(error): boolean

/** 单次调用。server = { port, csrf } */
export async function rpcCall(server, method, body, { timeoutMs = 30000, signal } = {}): Promise<object>

/** 带自动重发现的一次重试（REQ-06）。getServer() 由 discovery 提供。 */
export async function rpcCallResilient(getServer, method, body, opts): Promise<object>

// —— 以下均为薄封装，签名固定 ——
export async function getUserStatus(server, opts): Promise<object>
export async function retrieveQuotaSummary(server, opts): Promise<object>
export async function getCascadeTrajectory(server, cascadeId, opts): Promise<object>
export async function getCascadeTrajectorySteps(server, cascadeId, { startIndex } = {}, opts): Promise<object[]>
export async function getAllCascadeTrajectories(server, opts): Promise<object>
export async function waitForConversationFullyIdle(server, conversationId, opts): Promise<void>
export async function cancelCascadeInvocation(server, cascadeId, opts): Promise<object>
export async function getConversationMetadata(server, conversationId, opts): Promise<object>
```

### 3.2 `lib/discovery.js` — 跨平台服务发现（REQ-06 / REQ-09）

```js
/** @returns {Promise<{ exe, pid, port, csrf, platform, httpScheme }>} 找不到时抛 Error（中文文案） */
export async function discoverLanguageServer({ refresh = false } = {})

/** 清空内存缓存；下一次 discover 会重新扫描（桌面端重启后自愈） */
export function invalidateDiscovery()

/** 当前缓存（可能为 undefined） */
export function cachedServer()

/** 供 rpcCallResilient 用的取服务器回调：命中可重试错误时自动 invalidate 后重扫 */
export async function getServer({ refresh = false } = {})
```

平台分支：Windows 用 `Get-CimInstance Win32_Process` + `netstat -ano`；macOS/Linux 用 `ps -ax -o pid=,command=` + `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>`（退化 `ss -tlnp`）。优先读取 `%APPDATA%\Antigravity\logs\language_server.log` 加速端口定位。

### 3.3 `lib/transcript.js` — 日志读取与反截断（REQ-02）

```js
/** 规范化 step 形状（见 §4）。 */
export function normalizeStep(raw, index): object

/** 读取一轮对话的全部 step。
 *  优先 transcript_full.jsonl；缺失/落后时用 transcript.jsonl + RPC 补齐被截断的字段。
 *  @returns {{ steps, source: 'full'|'compact'|'compact+rpc'|'rpc'|'none', truncatedSteps: number[] }} */
export async function readTranscript(conversationId, { server, preferFull = true } = {})

/** 只读 RPC 的兜底实现，RPC 不可用时返回 { steps: [], source: 'none' } */
export async function readTranscriptViaRpc(server, conversationId, opts)

export function transcriptPaths(conversationId): { dir, compact, full }
```

### 3.4 `lib/turn.js` — 回合结束判定（REQ-01 / REQ-08 / REQ-04 挂钩）

```js
/**
 * @param {object} o
 * @param {string} o.conversationId
 * @param {number} o.sinceIndex        本轮起始 step_index
 * @param {object} o.server
 * @param {object} o.cfg               插件配置（pollIntervalSeconds/fastSettleSeconds/quietWindowSeconds/useFullTranscript）
 * @param {AbortSignal} [o.signal]
 * @param {(ev:{kind:'step'|'progress'|'idle', step?, text?, trace?}) => void} [o.onEvent]
 * @param {(step) => ({block?: boolean, reason?: string})} [o.onStep]   REQ-04 增量审计钩子
 * @returns {Promise<{ answer, trace, steps, settlement: 'rpc-idle'|'quiet-window'|'timeout',
 *                     elapsedMs, terminationReason?: string, killed?: {step, reason} }>}
 */
export async function waitForTurn(o)
```

判定顺序：
1. 起手先发一次 `waitForConversationFullyIdle`（长轮询，忙时直接阻塞到结束）。
2. 长轮询返回后，用 `getAllCascadeTrajectories` 确认 `IDLE` + `getCascadeTrajectory` 的 `terminationReason`。
3. 必须同时满足「存在无工具调用的 PLANNER_RESPONSE」才结算；否则回到步骤 1 再等一轮（防止工具轮之间的间隙被误判为结束）。
4. 再等 `fastSettleSeconds` 确认窗口，期间有新 step 则回到步骤 1。
5. `WaitForConversationFullyIdle` 不可用（RpcError.retryable 或方法不存在）时，**整体降级**为「轮询 + quietWindowSeconds 静默窗口」。
6. `signal.aborted` 或 `onStep` 返回 `block:true` 时：调 `cancelCascadeInvocation`（失败不致命），立即返回 `settlement:'timeout'` 语义的 `killed` 结果。

### 3.5 `lib/quota.js` — 额度监控与降级（REQ-03）

```js
/** @returns {{ plan, email, tiers: [{id, label, modelId, remainingFraction, resetTime}],
 *              buckets: [{groupId, groupName, bucketId, window, remainingFraction, resetTime, description}],
 *              readAt: number, error?: string }} */
export async function readQuota(server, { timeoutMs = 8000, rpc, now } = {})

/** 档位选择：把 thinking level 映射到 Antigravity 的 flash_lite/flash/pro（复用 config-schema 的 THINKING_TIERS） */
export function tierForLevel(level): string

/** 低额度自动降级（5h 桶 + 周限额双保险）。@returns {{ tier, downgraded?, note? }} */
export function applyQuotaFallback(desiredTier, quota, cfg)

/** 绑定共享的 Gemini 计费池（v0.5.0）。@returns {{gemini, weekly?, fiveHour?, thirdParty}} */
export function pickBillingBuckets(quota)

/** 配额缓存判定（v0.5.0）。@returns {{usable: boolean, reason?, ageMs?}} */
export function quotaCacheUsable(cached, cfg, { now, force } = {})

/** 配额缓存（v0.5.0）。@returns {{get, usable, read, invalidate, readAt}} */
export function createQuotaCache()

/** 供 check_environment 渲染的文本块（含倒计时，如 `pro: 65%, resets in 1h 42m`） */
export function renderQuota(quota, { now = Date.now() } = {}): string
```

降级规则（v0.5.0 两道闸，各自只作用于 `pro`）：

1. **5h 闸**：`min(tier 行 pro 值, gemini-5h 桶值) < proMinFraction` → 降 `flash`，
   `downgraded = 'pro -> flash (low quota)'`。
2. **周限额闸**：`gemini-weekly < weeklyProMinFraction` **且**距重置 > `weeklyReserveHours`
   → 降 `flash`，`downgraded = 'pro -> flash (weekly quota reserve)'`。
3. 无法识别（无 tier 行也无桶）→ **不降级**；`flash` 无额度 → 保持 `pro` 并在 `note` 说明。

配额缓存只在「读取完整 + 未过期 + 未逼近 `proMinFraction + 0.05` 警戒线」时复用；
`check_environment` 始终强制实时读取。

### 3.6 `lib/sessions.js` — 会话映射持久化（REQ-06）

```js
export function createSessionStore(filePath)
// 返回 { load(): Promise<Record>, save(state): Promise<void>,
//        get(state, workspace, sessionId), set(state, {sessionId, workspace, conversationId, tier, turns?}),
//        remove(state, workspace, sessionId),
//        list(state, limit), prune(state, { keepDays = 30 }) }

/** 轮数递增（v0.5.0）：换了 conversation 就从 1 重新数。 */
export function nextTurnCount(record, conversationId, turns?): number

/** 单会话超过阈值时的提示行（v0.5.0），未超阈返回 undefined。 */
export function longSessionHint(record, threshold = 8): string | undefined
```

记录形状：`{ session_id, conversation_id, workspace_dir, tier, turn_count?, created_at, updated_at }`，
key = `` `${workspace}::${sessionId}` ``。写入必须原子（写 `*.tmp` 后 `rename`），失败不致命。

`turn_count` 只在调用方传入 `turns` 或旧记录已带该字段时出现，保证 0.4.0 形状的记录
可以原样往返（向后兼容）。`remove()` 用于**失效会话自愈**：复用持久化的
`session_id` 却在 ~0.1s 内收到 dead-turn 错误时，剔除该映射并自动开新会话。

### 3.7 `lib/artifacts.js` — Git 死锁预检 + Brain 产物回收（REQ-07）

```js
/** @returns {{ worktreeConfig: boolean, configPath, warning?: string }} */
export async function checkWorktreeConfig(workspaceDir)

/** @returns {Promise<Array<{ name, path, bytes, chars, updatedAt, summary, inline }>>}
 *  只取根目录 .md，排除 .system_generated。
 *  策略：≤ maxInlineChars 直接内联全文（inline: true）；
 *        > maxInlineChars 只内联 maxArtifactHeadChars 开头 + 绝对路径（inline: false）。 */
export async function collectBrainArtifacts(conversationId, {
  sinceMs = 0, maxFiles = 8, summaryChars = 600,
  maxInlineChars = 4000, oversizeHeadChars = 2000,
} = {})
```

### 3.8 `lib/platform.js` — 跨平台 shell 前置（REQ-09）

```js
export const platform: 'windows'|'posix'
export function shellPreamble(workspace): string   // Windows: `Set-Location -LiteralPath '<ws>'; `  POSIX: `cd '<ws>' && `
export function shellNotes(): string[]             // 交给执行器的语法提示（`;` vs `&&`、Get-Content vs cat …）
export function workspaceSwitchHint(workspace): string
```

### 3.9 `lib/audit.js` — 静态 / 流式审计（REQ-04 / REQ-05）

保留现有导出（`normalizePath` / `isInside` / `extractPaths` / `auditTurn` / `renderAudit`）**签名与语义不变**，另有：

```js
/** 有状态增量审计器：按 step 顺序推进，内部维护虚拟工作目录。 */
export function createAuditor(workspace)
// 返回 { push(step): { violations, externalReads, commandCount, writeCount, readCount,
//                      blocked, blockedDestructive, blockedEscape },
//        report(): { violations, externalReads, commandCount, writeCount, readCount } }

/** 展开 PowerShell/Bash 别名与环境变量，返回归一化后的命令文本（REQ-05） */
export function expandAliases(command): string

/** 虚拟工作目录归一化：resolve(cwd, target) */
export function resolveVirtualPath(cwd, target): string

/** finding 粒度归类（v0.5.0）：'dangerous:*' -> 'destructive'，
 *  'cd-outside'/'write-outside' -> 'escape'，其余 -> undefined */
export function classifyFinding(kind): 'destructive'|'escape'|undefined

/** 识别不会自己退出的常驻命令（v0.5.0）。@returns {{id, why}|undefined} */
export function parseHangingCommand(command)

/** 一个 step 里的全部常驻命令命中（v0.5.0）。@returns {Array<{index, command, id, why}>} */
export function findHangingCommands(step)
```

`auditTurn(steps, sinceIndex, workspace)` 用 `createAuditor` 重新实现，保证两种入口结论一致。

### 3.10 `lib/pacing.js` — 拟人冷却（v0.5.0）

```js
/** 记录上一轮结束时间，在下一轮委派开始前补足间隔 + 随机抖动。 */
export function createPacer({ now?, random?, sleep? } = {})
// 返回 { plan(cfg): {delayMs, reason?, sinceLastMs?},
//        waitForTurnStart(cfg): Promise<{waitedMs, reason?}>,
//        noteTurnFinished(), status(), reset() }

/** check_environment 的一行渲染。 */
export function renderPacing(cfg, state?, now?): string
```

**只延迟「下一轮的开始」，绝不拖慢本轮结果**。状态在内存中（不落盘）：dsh 重启后
上一轮间隔本就不可知。


## 4. 规范化 step 形状

```js
{
  step_index: number,
  type: string,            // 'PLANNER_RESPONSE' | 'USER_INPUT' | 'RUN_COMMAND' | 'VIEW_FILE' | 'ERROR_MESSAGE' | ...
  status: string,          // 'DONE' | 'GENERATING' | ...
  created_at: string,
  content: string,         // PLANNER_RESPONSE 的正文（可能为空）
  tool_calls: Array<{ name: string, args: object }>,
  raw?: object
}
```

RPC step → 规范化的映射（`normalizeStep` 负责）：

| RPC `CORTEX_STEP_TYPE_*` | `type` | `content` | `tool_calls` |
| --- | --- | --- | --- |
| `PLANNER_RESPONSE` | `PLANNER_RESPONSE` | `plannerResponse.modifiedResponse ?? plannerResponse.response` | `[]`（若带 `toolCalls` 则映射） |
| `USER_INPUT` | `USER_INPUT` | `userInput.items[].text` 拼接 | `[]` |
| `RUN_COMMAND` | `RUN_COMMAND` | — | `[{name:'run_command', args:{CommandLine: runCommand.commandLine ?? runCommand.command}}]` |
| `VIEW_FILE` / `READ_FILE` | `VIEW_FILE` | — | `[{name:'view_file', args:{Path: viewFile.path ?? viewFile.filePath}}]` |
| `ERROR_MESSAGE` | `ERROR_MESSAGE` | `errorMessage.error.shortError` | `[]` |
| 其它 | 去掉前缀 | — | `[]` |

> `raw` 保留原对象，供审计/调试回溯。

## 5. 配置键（`lib/config-schema.js` 是唯一权威）

```yaml
thinkingLevel: medium            # minimal|low|medium|high|extra_high
allowOverride: true
followSessionWorkspace: true
allowOutsideWorkspace: false
audit: true
failOnEscape: false              # 只影响「越界」，不影响「破坏性命令」
maxSeconds: 900
quietWindowSeconds: 45           # 兜底静默窗口
pollIntervalSeconds: 2           # 轮询间隔
fastSettleSeconds: 2             # RPC 确认 IDLE 后的确认窗口
useFullTranscript: true          # 优先 transcript_full.jsonl
quotaFallback:
  enabled: true
  proMinFraction: 0.05           # 5h 窗口阈值
  weeklyProMinFraction: 0.15     # 周限额保护水位（更高，v0.5.0）
  weeklyGuard: true
  weeklyReserveHours: 24         # 距重置不足这么多小时则不启用周保护
  cacheTtlSeconds: 180           # 配额缓存（0 = 关闭）
realtimeKillSwitch: true         # 破坏性命令无条件熔断（v0.5.0）
persistSessions: true
includeBrainArtifacts: true
maxArtifactInlineChars: 4000     # 超过则只内联开头 + 绝对路径（v0.5.0）
maxArtifactHeadChars: 2000
longSessionTurns: 8              # 超过则提示换新 session_id（v0.5.0）
hangingCommandWarnSeconds: 45    # 常驻命令告警阈值（v0.5.0）
pacing:                          # 拟人冷却（v0.5.0）
  enabled: true
  minGapSeconds: 15
  jitterMinSeconds: 6
  jitterMaxSeconds: 15
```

新增键必须给默认值，且**不破坏**旧 profile（旧键缺省即用默认值）。

### 5.1 熔断粒度（v0.5.0，重要语义变更）

`createAuditor().push()` 返回三个布尔量：

| 字段 | 含义 | 受哪个配置控制 |
| --- | --- | --- |
| `blockedDestructive` | 命中 15+ 类高危破坏性命令（`dangerous:*`） | **仅**`realtimeKillSwitch` |
| `blockedEscape` | 命中 `cd-outside` / `write-outside` | `realtimeKillSwitch` **且** `failOnEscape` |
| `blocked` | 任一 error 级 finding（旧语义，保留） | 调用方决定 |

`classifyFinding(kind)` 给出上述归类（`'destructive'` / `'escape'` / `undefined`）。

**为什么必须拆开**：0.4.0 把熔断绑在 `failOnEscape && realtimeKillSwitch` 上，
而 `failOnEscape` 默认 `false`，于是**开箱即用状态下 80ms 事中熔断从未生效**。
用户设 `failOnEscape: false` 的原意是「容忍偶尔读工作区外的参考文件」，
绝不是「容忍 `reg delete`」。

### 5.2 配额桶语义（v0.5.0）

`RetrieveUserQuotaSummary` **不存在名为 `pro` 的桶**。实测 Pro 账号返回：

```
Gemini Models / gemini-5h      (5h)
Gemini Models / gemini-weekly  (weekly)
Claude and GPT models / 3p-5h  (5h)
Claude and GPT models / 3p-weekly (weekly)
```

`pro` 与 `flash` 共用 `Gemini Models` 池，`pro` 只是单位任务燃烧更快。因此：

- 匹配 pro 额度时用 `pickBillingBuckets()` 绑定 **Gemini 池**，不能按名字找 `pro`；
- 5h 桶与 tier 行描述同一池，取二者**更紧**的值；
- 降级 `pro -> flash` 本质是**降低燃烧速率**，不是换池。

周限额（`gemini-weekly`）用更高的 `weeklyProMinFraction` 单独保护：5h 桶用光最多
等几小时，周限额用光可能等好几天。


## 6. 写作用域（避免撞车）

| 负责人 | 文件 |
| --- | --- |
| Lead | `lib/config-schema.js`、`lib/index.js`、`lib/integration.test.js`、`README.md`、`cordis.patch.yml`、`package.json`、`locale/*.json`、`CONTRACT.md` |
| teammate-rpc | `lib/rpc.js`、`lib/discovery.js` |
| teammate-audit | `lib/audit.js`、`lib/audit.test.js` |
| teammate-turn | `lib/transcript.js`、`lib/turn.js` |
| teammate-support | `lib/quota.js`、`lib/sessions.js`、`lib/artifacts.js`、`lib/platform.js`、`lib/pacing.js` |

各自文件内的自测脚本放 `lib/<name>.test.js`（自己命名，不与他人的 test 文件重名）。
