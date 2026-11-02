# antigravity-executor 迭代契约（模块接口冻结版）

本文件是并行开发的唯一接口基准。**任何模块改动都要先改这里**，否则其他模块会编译期/运行期对不上。

> **v0.6.0 基线**：v0.5.1（commit `7f7ddab` + killed-step 渲染修复）。
> v0.6.0 的目标是「自适应 + 三阶边界加固」：REQ-01 自适应任务模式（§3.11）、
> REQ-02 串行互斥队列（§3.12）、REQ-03 死会话重建上下文补偿（§3.6）、
> REQ-04 挂起命令短超时熔断（§3.4 + §5.0）、REQ-05 git 元数据写入熔断（§3.9 + §5.3）、
> REQ-06 周配额 < 24h 退守底线（§3.5）、REQ-07 结算内联 git 快照（§3.7）。
> **零配置升级**是硬要求：旧 profile 不新增任何一个键也必须能跑，且 7 个 REQ 全部生效。

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
 * @param {(ctx: {steps, elapsedMs}) => ({block?, reason?}|undefined)} [o.onTick]  v0.6.0 每轮询一次
 * @returns {Promise<{ answer, trace, steps, settlement: 'rpc-idle'|'quiet-window'|'timeout',
 *                     elapsedMs, terminationReason?: string, killed?: {step, reason} }>}
 */
export async function waitForTurn(o)

/** 纯函数：这一拍是否该因「挂起命令」熔断（v0.6.0 / REQ-04）。 */
export function evaluateHangingTimeout({ hanging, newestStepIndex, newestStepAt, now, timeoutMs })
// → {block: false} | {block: true, reason, stepIndex, waitedMs}
```

**`onStep` 与 `onTick` 的区别（v0.6.0）**：`onStep` 只在**出现新 step**时触发，
而挂起命令的特征恰恰是「再也不产生新 step」——所以它永远等不到第二拍。
`onTick` 每个轮询拍都触发，是唯一能让 60s 熔断生效的时钟。
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

/** 周限额的有效水位与「是否已进入重置前窗口」（v0.6.0 / REQ-06）。
 *  @returns {{threshold: number, hoursUntilReset: number|null, nearReset: boolean}} */
export function weeklyGuardLevel(settings, { resetAt, anchor } = {})
```

降级规则（v0.6.0：两道闸，各自只作用于 `pro`）：

1. **5h 闸**：`min(tier 行 pro 值, gemini-5h 桶值) < proMinFraction` → 降 `flash`，
   `downgraded = 'pro -> flash (low quota)'`。
2. **周限额闸**：用 `weeklyGuardLevel()` 算出的有效阈值，`gemini-weekly < threshold` → 降 `flash`。
   - 距重置 ≥ `weeklyReserveHours`（默认 24h）：阈值 `weeklyProMinFraction`（0.15），
     `downgraded = 'pro -> flash (weekly quota reserve)'`。
   - 距重置 < 24h：**放开** 15% 储备、**退守** `proMinFraction`（0.05）底线，
     `downgraded = 'pro -> flash (weekly quota floor)'`。
   - `resetTime` 读不到时按「很远」处理（用 15%）——读不到不能反过来**削弱**保护。
3. 无法识别（无 tier 行也无桶）→ **不降级**；`flash` 无额度 → 保持 `pro` 并在 `note` 说明。

**为什么 < 24h 要退守而不是彻底跳过**：0.5.0 在最后 24h 直接把周闸关掉，于是
周配额真的见底（`< 5%` 甚至 `0%`）时仍会强发 `pro`，拿回一个 `RESOURCE_EXHAUSTED`。
放开的是「为最后一天预留的 15%」，不是「连 5% 底线一起放弃」。

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

记录形状：`{ session_id, conversation_id, workspace_dir, tier, turn_count?, last_touched_files?, last_task_head?, created_at, updated_at }`，
key = `` `${workspace}::${sessionId}` ``。写入必须原子（写 `*.tmp` 后 `rename`），失败不致命。

`turn_count` 只在调用方传入 `turns` 或旧记录已带该字段时出现，保证 0.4.0 形状的记录
可以原样往返（向后兼容）。`remove()` 用于**失效会话自愈**：复用持久化的
`session_id` 却在 ~0.1s 内收到 dead-turn 错误时，剔除该映射并自动开新会话。

**v0.6.0 新增两个字段（REQ-03）**，同样遵守「不传就不出现」的向后兼容纪律：

- `last_touched_files`：工作区内被读/写过的文件，去重，最多 10 条，来自审计器的 `touchedFiles`。
- `last_task_head`：上一轮 `task_spec` 的前 200 字符。

`conversation_id` 变化时这两个字段**不继承**（新线程从干净状态开始，理由与 `turn_count` 相同）。

```js
/** 失效会话重建时拼在 prompt 头部的上下文补补偿横幅；无内容时 undefined。 */
export function contextRecoveryBanner(record, { sessionId } = {}): string | undefined
```

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

// --- v0.6.0（REQ-07）--------------------------------------------------------

/** 只读地采集工作区的 git 状态快照；永不抛错、永不挂起。
 *  @returns {Promise<{isRepo, status, diffStat, changed, untracked, error?}>} */
export async function readGitSummary(workspaceDir, { timeoutMs = 3000, maxLines = 40, run } = {})

/** 快照的中文渲染块；非 git 仓库返回 undefined。 */
export function renderGitSummary(summary): string | undefined
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

// --- v0.6.0（REQ-05 / REQ-03 / REQ-07）--------------------------------------

/** 是否落在工作区内的 Git 元数据上（`.git/hooks/**`、`.git/config`）。 */
export function isGitMetadataPath(target): boolean

/** 命令里可见的写入目标（含 `>` / `Out-File` / 各种写动词的参数）。 */
export function extractWriteTargets(command): string[]

/** 该工具名是否是原生文件写工具。 */
export function isWriteTool(name): boolean

/** 原生写工具参数里的目标路径；没有则 undefined。 */
export function writeToolPath(args): string | undefined
```

`auditTurn(steps, sinceIndex, workspace)` 用 `createAuditor` 重新实现，保证两种入口结论一致。

**v0.6.0 的 `report()` 增补两个字段**（其余字段与形状不变）：

```js
report() // → { ...v0.5.0 的五个字段,
         //     touchedFiles: string[],  // 工作区内被读/写过的绝对路径，去重，按首次触碰排序
         //     fileWrites: number }     // 文件写操作次数（原生写工具 + 写形命令，每条命令记一次）
```

`touchedFiles` 供「失效会话重建」时把上下文补回去（§3.6）；
`fileWrites` 供「声称改了但其实没动」的幻觉预警（§3.7）。

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

### 3.11 `lib/task-mode.js` — 自适应任务模式（v0.6.0 / REQ-01）

```js
export const TASK_MODES = ['surgical', 'creative']
export const DEFAULT_TASK_MODE = 'surgical'
export const CREATIVE_TASK_RE = /…/i

/** 显式参数 > 正则兜底。@returns {{mode, source: 'call'|'auto'|'invalid', note?}} */
export function resolveTaskMode({ task_mode, task_spec } = {})

/** creative 人格前缀（逐字固定，产品要求）。 */
export function creativePreamble(): string

/** 第 1 轮视觉复审门禁；不满足条件时 undefined。 */
export function creativeReviewGate({ mode, turnCount } = {}): string | undefined

/** 报告里的一行。 */
export function renderTaskMode(decision): string
```

两种人格的差别只在**注入给执行器的 Preamble** 与**第 1 轮的门禁提示**：

| mode | Preamble | 第 1 轮返回后 |
| --- | --- | --- |
| `surgical` | 现有「最小化改动」工程前缀 | 无附加提示，快返 |
| `creative` | 工程前缀 + `[CREATIVE & VISUAL DENSITY MODE]` | 追加 `[Supervisor Creative Gate — Pass 1 Completed]` |

`creativeReviewGate` 只在 `mode === 'creative'` 且 `Number(turnCount) === 1` 时返回文本，
其余一律 `undefined`——它是一条**一次性**的督导指令，第 2 轮之后不能再劝人继续扩建，
否则主模型会无限续轮、烧配额。

### 3.12 `lib/queue.js` — 插件内串行互斥队列（v0.6.0 / REQ-02）

```js
/** 严格 FIFO，同一时刻只跑一个委派。 */
export function createSerialQueue({ now } = {})
// 返回 { run(fn): Promise<any>,
//        status(): {running, queued, completed, currentStartedAt?, lastFinishedAt?},
//        reset() }

/** check_environment 的一行。 */
export function renderQueue(state): string
```

**为什么要锁**：主模型可以在同一条回复里并发发起多个 `delegate_coding_task`
（Parallel Tool Calls）。它们会在同一毫秒读到相同的 `lastTurnFinishedAt`，
于是 `pacing` 冷却与抖动被同时穿透；两个 Antigravity 会话同时写同一工作区
还会造成文件踩踏与 `.git/index.lock`。

锁的粒度是**进程内全局**（整条 Bridge），不是按 `workspace_dir`：并发写不同
工作区同样会一起击穿 pacing，而 pacing 状态本来就是全局的。

释放放在 `finally`，失败的任务不能把队列焊死；拒绝只回到它自己的 `run()` 调用方。


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

# --- v0.6.0 新增（全部可选，缺省即用下列默认值）------------------------------
taskMode: auto                   # auto | surgical | creative（auto = 按 task_spec 正则判定）
hangingCommandTimeoutSeconds: 60  # 疑似常驻命令超过这么久就主动掐断（0 = 只告警不掐断）
includeGitSummary: true          # 结算时自动附带 git status / diff --stat 快照
includeTaskModeHint: true        # 返回报告里显示判定出的 task_mode（排查用）
```

新增键必须给默认值，且**不破坏**旧 profile（旧键缺省即用默认值）。

### 5.0 v0.6.0 配置键语义

| 键 | 作用 | 关掉会怎样 |
| --- | --- | --- |
| `taskMode` | 强制覆盖自动判定。`auto`（默认）按 `task_spec` 正则判定，`surgical`/`creative` 直接钉死 | 设成 `creative` 会让修 Bug 也走高密度人格，别这么用 |
| `hangingCommandTimeoutSeconds` | 疑似常驻命令超过这么久、且期间无新 step → 主动 `CancelCascadeInvocation` | 设 `0` 退回 v0.5.1 的「只告警，等满 `maxSeconds`」 |
| `includeGitSummary` | 结算时在本地跑 `git status --porcelain` / `git diff --stat`（各 3s 超时） | 关掉后主模型又得自己跑一轮 git，且丢掉「假改」预警 |
| `includeTaskModeHint` | 报告里多一行「这次按哪种人格跑的」 | 关掉只影响可观测性，不影响行为 |

`task_mode` **不是**配置键的替代品：工具参数逐次生效（一次 3D 任务、下一次修 Bug 不必改任何文件），
配置键只用于「这个 profile 永远只做某类活」的极端场景。

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

### 5.3 熔断粒度（v0.6.0 增补 REQ-05）

`classifyFinding` 新增第三类破坏性 finding：

| kind | 含义 | 归类 |
| --- | --- | --- |
| `dangerous:*` | 命中高危命令规则表 | `destructive` |
| `destructive_git_metadata_write` | 写到了 `<ws>/.git/hooks/**` 或 `<ws>/.git/config` | **`destructive`** |
| `cd-outside` / `write-outside` | 工作区越界 | `escape` |

**为什么 git 元数据算破坏性而不是越界**：它在**工作区内部**，所以
`write-outside` 永远抓不到它，而 `failOnEscape: false` 又恰恰是默认配置——
于是 0.5.x 对这条路径完全无感。危险在于它不是「改了个文件」，而是
**让下一轮 `git status` 执行任意命令**：主模型每次验收都会跑 git，等于把
执行器的代码直接搬进主模型进程。这类写入必须与 `reg delete` 同级无条件熔断。


## 6. 写作用域（避免撞车）

| 负责人 | 文件 |
| --- | --- |
| Lead | `lib/config-schema.js`、`lib/index.js`、`lib/integration.test.js`、`README.md`、`cordis.patch.yml`、`package.json`、`locale/*.json`、`CONTRACT.md`、`skills/supervisor-workflow/SKILL.md` |
| teammate-task-mode-queue | `lib/task-mode.js`、`lib/task-mode.test.js`、`lib/queue.js`、`lib/queue.test.js`（v0.6.0） |
| teammate-audit-gitmeta | `lib/audit.js`、`lib/audit.test.js`（v0.6.0） |
| teammate-turn-hang-tick | `lib/turn.js`、`lib/turn.test.js`（v0.6.0） |
| teammate-quota-sessions-git | `lib/quota.js`、`lib/quota.test.js`、`lib/sessions.js`、`lib/sessions.test.js`、`lib/artifacts.js`、`lib/artifacts.test.js`（v0.6.0） |
| teammate-rpc | `lib/rpc.js`、`lib/discovery.js`（v0.6.0 未改动） |
| teammate-support | `lib/platform.js`、`lib/pacing.js`（v0.6.0 未改动） |

各自文件内的自测脚本放 `lib/<name>.test.js`（自己命名，不与他人的 test 文件重名）。


---

# v0.8.0 迭代契约增量（General Complex Task Orchestration Edition）

> **基线**：v0.7.0（Commit `b8880b8`）。需求来源：`F:\work\需求文档.md`。
> **纪律不变**：任何模块改动先改这里；零配置升级（旧 profile 不加键也能跑）；零新增运行时依赖。

## 7.1 写作用域（v0.8.0 并行分工）

| 负责人 | 文件 |
| --- | --- |
| Lead | `CONTRACT.md`、`lib/config-schema.js`、`lib/index.js`、`lib/ui-server.mjs`、`ui/index.html`、`client.js`、`cordis.patch.yml`、`package.json`、`locale/*.json`、`README.md`、`skills/supervisor-workflow/SKILL.md`、`lib/integration.test.js` |
| teammate-commands | **新建** `lib/commands.js`、`lib/commands.test.js` |
| teammate-escalation | **新建** `lib/escalation.js`、`lib/escalation.test.js` |
| teammate-snapshot | **新建** `lib/snapshot.js`、`lib/snapshot.test.js` |
| teammate-session-brief | **新建** `lib/session-brief.js`、`lib/session-brief.test.mjs` |
| teammate-task-mode | `lib/task-mode.js`、`lib/task-mode.test.js`（v0.8.0 三元模式 + 粘性） |
| teammate-sessions | `lib/sessions.js`、`lib/sessions.test.js`（v0.8.0 结转字段） |
| teammate-telemetry | `lib/telemetry.mjs`、`lib/telemetry.test.mjs`（v0.8.0 快照/命令/配额增量） |

**新建模块必须是纯模块**：只 import `node:*` 内置，不 import 本包其它 lib 文件（测试才能独立跑）。

## 7.2 新增配置键（`lib/config-schema.js` 仍是唯一权威）

```yaml
# --- v0.8.0（全部可选，缺省即用下列默认值，旧 profile 不新增任何键即可跑）----
autoEscalateOnRetry: true          # REQ-01：返工轮次 / 上一轮失败 / creative 模式自动 flash -> pro
retryEscalationLevel: high         # 升档目标档位（high 或 extra_high）
preTurnGitSnapshot: true           # REQ-03：回合前 git stash create 零副作用快照，支持一键回滚
autoRolloverLongSessions: false    # REQ-04：超长会话是否自动带记忆结转（false = 仅提示 + UI 按钮）
documentMaxSummaryChars: 6000      # REQ-05：document 模式回显文档结构摘要的字符上限
```

语义：新增键**只影响新增能力**，任一键缺省时行为与 v0.7.0 等价（`autoRolloverLongSessions` 默认 false 尤其重要：自动换会话会丢上下文，必须用户显式开启或点 UI 按钮）。

## 7.3 `lib/commands.js`（REQ-02 / UI-REQ-01）

```js
/** 从规范化 steps（含 raw）提取所有 run_command 执行结果。 */
export function extractRunCommands(steps): Array<{
  stepIndex: number,
  command: string,
  cwd: string|null,
  exitCode: number|null,      // 轨迹里没有就是 null（不是 0！）
  outputTail: string,         // 最后 20 行，硬上限 1500 字符
  failed: boolean,            // exitCode 是有限数且 !== 0
}>

/** 是否是「验收类」命令（测试/构建/lint/类型检查）。 */
export function isVerificationCommand(command): boolean

/** 汇总：{total, failed, lastVerification, verificationFailed} */
export function summarizeCommands(commands)

/** 报告块 `[Command Execution Summary]`，无命令时返回 undefined。 */
export function renderCommandSummary(commands, { maxCommands = 12 } = {})  // → string|undefined

/** 假成功拦截条：最后一条验收命令非零退出时返回预警文本，否则 undefined。 */
export function verificationWarning(commands)
```

判定口径（**必须照做**）：
- `exitCode` 来源优先级：`step.raw.runCommand.exitCode` → `step.raw.metadata.commandResult.exitCode` → `step.raw.taskDetails.exitCode` → 正则自最后一条输出里的 `exit code N`。**读不到就是 `null`，绝不猜 0**。
- `command` 来源：`step.raw.metadata.toolCall.argumentsJson`（字符串二次 `JSON.parse`）里的 `CommandLine` → `step.tool_calls[].args.CommandLine` → `step.raw.runCommand.commandLine`。
- `outputTail` 来源：`step.raw.runCommand.combinedOutput.full` → `step.raw.runCommand.combinedOutput` → `step.content`。取最后 20 行后若超 1500 字符，从**头部**截断（保留尾部堆栈）。
- 渲染样例（逐字）：

```text
[Command Execution Summary]
  ✅ Exit 0: npm run build
  ❌ Exit 1: npx vitest run
     cwd  : F:\work\app
     tail :
       AssertionError [ERR_ASSERTION]: expected 200 to equal 500
```

- 预警条（逐字，插在报告**最顶部**）：

```text
[⚠️ Verification Warning: The last executed command exited with code 1. Inspect the error output below before accepting.]
```

## 7.4 `lib/escalation.js`（REQ-01）

```js
export const RETRY_SIGNAL_RE = /\b(fix|failing|failed|error|broken|regression|retry|still\s+not)\b|报错|失败|未通过|没改对|返工|修复/i

/** 触发条件 A 的「返工信号」判定。 */
export function detectRetrySignal({ taskSpec, lastTurnFailed, turnCount, reusedSession }): boolean

/** 返回 {escalate, from, to, reason}，不满足升档条件返回 {escalate:false}。 */
export function shouldEscalate({ explicitLevel, configuredLevel, effectiveMode, session, taskSpec, config }): {
  escalate: boolean,
  from?: string,            // 'flash'
  to?: string,              // 'pro'
  reason?: 'retry'|'complexity',
  detail?: string,          // 报告里的一行原因
}

/** UI 状态栏 + 报告行：`escalated: flash -> pro (retry/complexity escalation)` */
export function renderEscalation(decision): string|undefined
```

规则（**必须照做**）：
1. 调用方显式传了 `thinking_level` → **不升档**（用户/主模型意志优先）。
2. `effectiveMode === 'creative'` → 升档，`reason: 'complexity'`。
3. `reusedSession === true`（`turnCount >= 1`）且（`session.lastTurnFailed === true` 或 `taskSpec` 命中 `RETRY_SIGNAL_RE`）→ 升档，`reason: 'retry'`。
4. 目标档位 = `config.retryEscalationLevel`（默认 `high`），且**只升不降**：已 ≥ 目标则不升。
5. **升档后排在前面的仍是 `quotaFallback`**：本模块只回答「想不想升」，配额守卫在 `index.js` 之后照样可以把它降回来。

## 7.5 `lib/snapshot.js`（REQ-03）

```js
/** 回合前零副作用快照。@returns {isRepo, snapshotSha, headSha, preUntracked, error?} */
export async function capturePreTurnSnapshot(workspaceDir, { run, timeoutMs } = {}): Promise<{
  isRepo: boolean, snapshotSha: string|null, headSha: string|null,
  preUntracked: string[], error?: string
}>

/** 回滚一个回合。@returns {ok, restoredFiles, removedUntracked, skipped, error?} */
export async function rollbackTurn(workspaceDir, snapshot, { run, touchedFiles, removeUntracked = true } = {})

/** 报告 / UI 渲染。 */
export function renderSnapshot(snapshot): string|undefined
export function renderRollback(result): string
```

实现约束（**必须照做**）：
- `run(args)` 形如 `run(['-C', ws, 'status'])`，返回 `{code, stdout, stderr}`；默认实现用 `execFile('git', ...)`，**永不 throw**。
- 采集顺序：`rev-parse --is-inside-work-tree`（非 0 → `isRepo:false`，**不报错**）→ `rev-parse HEAD`（空仓库可失败 → `headSha:null`）→ `stash create`（工作区干净时输出空串，此时 `snapshotSha = headSha`）→ `ls-files --others --exclude-standard` 记 `preUntracked`。
- `stash create` **只写 `.git/objects` 悬空对象**：绝不碰工作区、暂存区、`stash list`。
- `rollbackTurn`：对 `touchedFiles` 中**受版本控制**的文件执行 `checkout <snapshotSha> -- <file>`；对「当前未跟踪 **且** 不在 `preUntracked` 里」的文件执行删除（`removeUntracked:false` 时只报告不删）。`touchedFiles` 为空时退化为整树 `checkout <sha> -- .`（仍不碰 preUntracked）。
- `snapshotSha` 为 null（空仓库）时：跳过 checkout，只做未跟踪清理，并在 `skipped` 说明。
- **只允许改工作区内的路径**：所有目标路径必须 `resolve` 后仍在 `workspaceDir` 下，否则跳过并记入 `skipped`。

## 7.6 `lib/session-brief.js`（REQ-04）

```js
/** 结转摘要。@returns {{cumulativeTouchedFiles: string[], lastPlanHead: string, previousTurnCount: number}} */
export function buildRolloverBrief(record, { extraFiles = [], planText } = {})

/** 新会话首轮注入的头部横幅；无内容返回 undefined。 */
export function renderRolloverPrompt(brief): string|undefined

/** 是否已到长会话结转水位。 */
export function isLongSession(record, { longSessionTurns = 8 } = {}): boolean
```

口径：`cumulativeTouchedFiles` 去重、**保持首次触碰顺序**、最多 **15** 条、转成工作区相对路径斜杠形式；`lastPlanHead` 取 `planText` 前 **600** 字符（空则退回 `record.last_task_head`）；`previousTurnCount` 取 `record.turn_count`。

## 7.7 `lib/telemetry.mjs` 增量（UI-REQ-01/02/03/04）

- `normalizeStep(step, verdict)` **新增字段** `command`：`undefined` 或 `{command, cwd, exitCode, outputTail, failed}`（形状见 §7.3，UI 终端 Tab 直接渲染，不再解析）。
- `startTurn(info)` 新增可选 `escalation: {from, to, reason}`、`rolloverBrief: {previousTurnCount, files}`、`snapshotSha`。
- `settleTurn(turnId, result)` 新增可选 `commands`（§7.3 汇总）、`burn`（`{fraction, label}`）、`changedFiles`（`[{path, added, removed}]`）、`touchedFiles`、`rolledBack: false`。
- **新增** `recordBurn({deltaFraction, cumulativeFraction, window})`：写 `quota.burn`，`deltaFraction` 是「本轮消耗」，供回合卡片徽章。
- **新增** `markRolledBack(turnId, {restoredFiles, removedUntracked})`：把环形缓冲里该回合标 `rolledBack:true` 并 emit `turn:rolled-back`。
- **新增** `markRolledOver(sessionId, {toConversationId, brief})`：emit `session:rollover` 并更新该行 `turnCount`。
- `snapshot()` 新增 `quota.burn`、`recentTurns[].{snapshotSha,rolledBack,commands,changedFiles,burn,escalation}`。

## 7.8 `lib/ui-server.mjs` 新增路由（§4.1）

| 方法 & 路径 | 入参 | 响应 |
| --- | --- | --- |
| `GET /api/git-diff` | `?turnId=&file=` | `{file, diffText, stats:{added,removed}}`；**必须**用 `resolveInsideWorkspace` 校验 `file`，越界 403 |
| `POST /api/control/rollback` | `{turnId?}` | `{ok, turnId, restoredFiles, removedUntracked}` |
| `POST /api/sessions/rollover` | `{sessionId}` | `{ok, sessionId, briefSummary}` |
| `POST /api/control/config/save` | `{}` | `{ok, savedPath}` |

全部沿用现成约束：写操作走 loopback Origin 校验
（403）、`readJsonBody` 的 256KB 上限、未知路由 404。

## 7.9 验收口径（Lead 会逐条跑）

1. 默认 `medium` 下第 1 轮 → `flash`；第 2 轮修复/上一轮非零退出 → `pro`，报告出现 `escalated: flash -> pro (...)`。
2. 回合内测试失败 → 报告顶部出现 `[⚠️ Verification Warning: ...]`，且 `[Command Execution Summary]` 里有 `❌ Exit 1` 与堆栈尾部。
3. 「已有未提交改动 + 本轮改 3 文件新建 1 文件」→ 回滚后这 4 个文件回到盘前状态，**盘前已有改动完好**。
4. 8 轮后结转 → 新 `conversation_id`、`turn_count` 归零、首轮 prompt 带前 8 轮文件列表与进度摘要。
5. `document` 模式被 `.xlsx/.pptx/.docx/.pdf/.csv` 命中；同 `session_id` 第 2 轮不带 `task_mode` 时**继承**首轮模式。
6. War Room：4 Tab 检视器、时间轴过滤胶囊 + 连续只读折叠、单步手风琴、回滚/结转按钮、本轮消耗徽章、`@container` 窄屏折叠、历史锁定横幅。
