/**
 * Antigravity executor — native dsh tool plugin (account-login edition).
 *
 * Registers `delegate_coding_task` / `check_environment` / `list_conversations`
 * directly on `ctx.tools`. No MCP server, no Python child process: this module
 * drives the Antigravity desktop Language Server through its `agentapi`
 * subcommand, reads the conversation transcript off disk, and talks to the
 * server's own ConnectRPC surface for state, quota and cancellation.
 *
 * Why native instead of an MCP bridge: nothing has to exist outside this
 * package — no venv, no absolute script path — and the tool schema ships with
 * the package that provides it.
 *
 * MODULE LAYOUT (see CONTRACT.md)
 * -------------------------------
 *   rpc.js        ConnectRPC client (one POST per method)
 *   discovery.js  cross-platform Language Server discovery + re-discovery
 *   transcript.js transcript reading with anti-truncation
 *   turn.js       turn settlement (RPC state machine, quiet-window fallback)
 *   quota.js      account quota reading, tier fallback, rendering
 *   sessions.js   session_id -> conversation_id persistence
 *   artifacts.js  git worktree deadlock pre-check, brain artifact collection
 *   platform.js   per-platform shell preamble and syntax notes
 *   audit.js      static / streaming workspace auditor
 *   config-schema.js  the validated config contract
 *
 * @module antigravity-executor
 */

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  checkWorktreeConfig,
  collectBrainArtifacts,
  readGitSummary,
  renderGitSummary,
} from './artifacts.js'
import {
  auditTurn,
  classifyFinding,
  createAuditor,
  findHangingCommands,
  isInside,
  renderAudit,
} from './audit.js'
import { Config, DEFAULT_CONFIG, THINKING_LEVELS, THINKING_TIERS } from './config-schema.js'
import { discoverLanguageServer, getServer, invalidateDiscovery } from './discovery.js'
import { createPacer, renderPacing } from './pacing.js'
import { shellNotes, shellPreamble, workspaceSwitchHint } from './platform.js'
import { createSerialQueue, renderQueue } from './queue.js'
import { applyQuotaFallback, createQuotaCache, readQuota, renderQuota } from './quota.js'
import {
  contextRecoveryBanner,
  createSessionStore,
  longSessionHint,
  nextTurnCount,
} from './sessions.js'
import {
  creativePreamble,
  creativeReviewGate,
  renderTaskMode,
  resolveTaskMode,
} from './task-mode.js'
import { readTranscript } from './transcript.js'
import { evaluateHangingTimeout, waitForTurn } from './turn.js'

const execFileAsync = promisify(execFile)

export const name = 'antigravity-executor'
/**
 * `sessions` is required, not optional: reading the session's own `cwd` is how
 * `delegate_coding_task` defaults its workspace to the conversation's directory.
 * Cordis refuses property access to services a plugin has not injected, so
 * omitting it made the lookup throw and the workspace silently unresolved.
 * `skills` backs the bundled supervisor-workflow skill.
 */
export const inject = ['tools', 'skills', 'sessions']
export { Config } from './config-schema.js'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SESSIONS_FILE = join(PKG_DIR, 'sessions.json')

const LS_TIMEOUT_MS = 30_000

/** Validated user config, merged over the schema defaults. */
let cfg = {
  ...DEFAULT_CONFIG,
  quotaFallback: { ...DEFAULT_CONFIG.quotaFallback },
  pacing: { ...DEFAULT_CONFIG.pacing },
}

/** Session map, loaded lazily and reused; the store handles atomicity. */
const sessionStore = createSessionStore(SESSIONS_FILE)
/** In-memory mirror so a slow disk never blocks a tool call. */
let sessionState

/** Quota memo (v0.5.0): avoids a burst of account reads on rapid re-dispatch. */
const quotaCache = createQuotaCache()
/** Inter-turn pacing (v0.5.0): keeps consecutive delegations from looking scripted. */
const pacer = createPacer()
/**
 * Delegation mutex (v0.6.0 / REQ-02).
 *
 * The planner can emit several `delegate_coding_task` calls in ONE reply. Without
 * a lock, all of them read the same `lastTurnFinishedAt`, so the pacing gap and
 * its jitter are pierced simultaneously — the exact metronome-shaped burst the
 * pacer exists to prevent — and two Antigravity conversations then edit the same
 * workspace at once (clobbered files, `.git/index.lock`).
 *
 * One queue for the whole Bridge, not one per `workspace_dir`: pacing state is
 * global, so two concurrent delegations on two different workspaces pierce it
 * just as effectively as two on the same one.
 */
const delegationQueue = createSerialQueue()

/** Progress sink installed by apply(); falls back to a no-op. */
let progressLog = () => {}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Run one command without a shell; never throws. */
async function run(file, args, { timeout = LS_TIMEOUT_MS, env } = {}) {
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
 * Invoke `agentapi <args>` against a located server and parse its JSON reply.
 *
 * This stays the send path on purpose. `SendUserCascadeMessage` over HTTP
 * accepts the request and returns `{}`, but the message never lands in the
 * trajectory of a conversation created by `agentapi` (measured), so the CLI
 * remains the only reliable way to add a turn. `execFile` passes argv without a
 * shell, so multi-line prompts and embedded quotes survive intact — the
 * historical truncation came from shell quoting, not from this channel.
 */
async function agentapi(ls, args, timeout = 120_000) {
  const { code, stdout, stderr } = await run(ls.exe, ['agentapi', ...args], {
    timeout,
    env: {
      ANTIGRAVITY_LS_ADDRESS: `http://127.0.0.1:${ls.port}`,
      ANTIGRAVITY_CSRF_TOKEN: ls.csrf,
    },
  })
  const text = (stdout ?? '').trim()
  if (text === '') {
    throw new Error(`agentapi 没有输出（exit=${code}）：${(stderr ?? '').slice(0, 400)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`agentapi 返回了非 JSON 内容：${text.slice(0, 400)}`)
  }
  if (payload.error) throw new Error(String(payload.error))
  return payload.response ?? {}
}

function renderText(value) {
  return [{ type: 'text', text: String(value ?? '') }]
}

/**
 * Where a kill-switch finding happened, as user-facing text.
 *
 * `turn.js` reports `killed.step` as the whole normalized step object, so
 * interpolating it directly printed "[object Object]" — the one line a user
 * reads when the breaker fires was unreadable. Exported so the format is
 * testable without standing up the RPC layer.
 *
 * @param {{step?: object|number}} killed
 * @returns {string} e.g. `step 7` / `step ?`
 */
export function renderKilledStep(killed) {
  const step = killed?.step
  if (step !== null && typeof step === 'object') return `step ${step.step_index ?? '?'}`
  return `step ${step ?? '?'}`
}

/** How many touched files are worth persisting for a later context recovery. */
const SESSION_TOUCHED_FILES = 10

/**
 * The touched-file list to persist with a session record (v0.6.0 / REQ-03).
 *
 * `sessions.js` already caps and de-duplicates, but the cap is applied here too
 * so the in-memory record stays small even before it is written to disk. The
 * list is deliberately the most recent slice of the turn's touches: an
 * incremental follow-up is nearly always about the last few files, not the first
 * ones an orientation pass happened to open.
 *
 * @param {{touchedFiles?: string[]}|undefined} report
 * @returns {string[]|undefined} undefined when the auditor never ran
 */
function sessionTouchedFiles(report) {
  const files = Array.isArray(report?.touchedFiles) ? report.touchedFiles : undefined
  if (files === undefined) return undefined
  return files.slice(-SESSION_TOUCHED_FILES)
}

// ---------------------------------------------------------------------------
// session bookkeeping
// ---------------------------------------------------------------------------

async function state() {
  if (sessionState === undefined) sessionState = await sessionStore.load()
  return sessionState
}

async function persist(stateValue) {
  sessionState = stateValue
  if (cfg.persistSessions) await sessionStore.save(stateValue)
}

function sessionKey(workspace, sessionId) {
  return `${workspace}::${sessionId}`
}

// ---------------------------------------------------------------------------
// workspace resolution
// ---------------------------------------------------------------------------

/**
 * The dsh session's own working directory.
 *
 * `exec.agent.id` is the session id; the immutable session header carries the
 * validated absolute `cwd` the session was created in, which is exactly the
 * directory the user means by "this project". Returns undefined when the
 * service or header is unavailable (older profiles, fresh sessions).
 */
function sessionWorkspace(ctx, exec) {
  const sessionId = exec?.agent?.id
  if (sessionId === undefined) {
    return { reason: 'exec.agent.id 不可用（工具调用没有携带 agent）' }
  }
  if (ctx?.sessions === undefined) {
    return { reason: 'ctx.sessions 不可用（插件未注入 sessions 服务）' }
  }

  let session
  try {
    session = ctx.sessions.get(sessionId)
  } catch (error) {
    return { reason: `ctx.sessions.get(${sessionId}) 抛错：${error.message}` }
  }
  if (session === undefined) {
    return { reason: `会话 ${sessionId} 不在当前进程的 SessionStore 中` }
  }

  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { reason: `会话 ${sessionId} 的 header 没有 cwd（创建时未指定工作目录）` }
  }
  return { workspace: resolve(cwd) }
}

/**
 * Decide the workspace for one delegation.
 *
 * Explicit `workspace_dir` always wins. Otherwise we follow the dsh session cwd,
 * which is the behaviour this plugin is expected to have: the executor works
 * where the conversation works. Delegating outside the session workspace is
 * refused unless `allowOutsideWorkspace` is set, so a typo in a task spec cannot
 * silently aim the executor at `C:\Windows`.
 */
function resolveWorkspace(requested, ctx, exec) {
  const explicit = String(requested ?? '').trim()
  const found = sessionWorkspace(ctx, exec)
  const sessionCwd = found.workspace

  if (explicit !== '') {
    const target = resolve(explicit)
    if (
      !cfg.allowOutsideWorkspace &&
      cfg.followSessionWorkspace &&
      sessionCwd !== undefined &&
      !isInside(sessionCwd, target)
    ) {
      return {
        error:
          `[error] workspace_dir 位于当前会话工作区之外：${target}\n` +
          `会话工作区：${sessionCwd}\n` +
          '若确有需要，请在插件配置中把 allowOutsideWorkspace 设为 true。',
      }
    }
    return { workspace: target, source: 'explicit' }
  }

  if (cfg.followSessionWorkspace && sessionCwd !== undefined) {
    return { workspace: sessionCwd, source: 'session-cwd' }
  }

  // No explicit path and no usable session cwd: say exactly why, so the caller
  // can fix the actual cause instead of guessing at the config.
  const why = cfg.followSessionWorkspace
    ? (found.reason ?? '会话没有 cwd')
    : '插件配置 followSessionWorkspace=false'
  return {
    error:
      `[error] 无法确定工作区：本次调用没有传 workspace_dir，且无法从会话读取 cwd。\n` +
      `原因：${why}\n` +
      '请显式传入 workspace_dir。',
  }
}

/** Effective thinking level for one call, honouring the config selector. */
function resolveThinking(requested) {
  const raw = String(requested ?? '').trim().toLowerCase()

  if (raw === '') {
    return { level: cfg.thinkingLevel, source: 'config' }
  }

  if (!cfg.allowOverride) {
    return {
      level: cfg.thinkingLevel,
      source: 'config (override disabled)',
      note: `请求的 ${raw} 被忽略：插件配置 allowOverride=false。`,
    }
  }

  if (!THINKING_LEVELS.includes(raw)) {
    return {
      error: `[error] unknown thinking_level ${JSON.stringify(requested)}; use one of ${THINKING_LEVELS.join(', ')}`,
    }
  }
  return { level: raw, source: 'call' }
}

// ---------------------------------------------------------------------------
// prompt shaping
// ---------------------------------------------------------------------------

/**
 * The executor prompt.
 *
 * TWO PERSONAS, ONE PROMPT (v0.6.0 / REQ-01)
 * -----------------------------------------
 * The engineering preamble is deliberately conservative: "do exactly what the
 * spec says, do not widen the scope". That is exactly right for a bug fix and
 * exactly wrong for a 3D scene, where it produces a skeletal "matchbox" result —
 * three plain boxes standing in for a shelf, a shopfront and a floor — which
 * passes every syntax check and still looks nothing like the request.
 *
 * So the persona is selected per call rather than configured per profile. The
 * hard constraints (absolute paths, workspace containment, no dev servers) are
 * shared; only the scope rule and the appended density block differ. The user
 * never has to edit a file when switching between the two kinds of work.
 *
 * @param {string} workspace absolute workspace directory
 * @param {string} taskSpec the caller's specification
 * @param {{mode?: 'surgical'|'creative'}} [options]
 * @returns {string}
 */
function buildPrompt(workspace, taskSpec, { mode = 'surgical' } = {}) {
  const notes = shellNotes()
    .map((line, i) => `${i + 3}. ${line}`)
    .join('\n')
  const nextNote = 3 + shellNotes().length
  const creative = mode === 'creative'

  // The scope rule is the one line that has to flip with the persona: "do not
  // widen the scope" is precisely what turns a 3D scene into placeholder boxes.
  const scopeRule = creative
    ? `${nextNote + 1}. 在任务规格给定的文件范围内工作，但**不要为了代码简洁而阉割视觉表现**：
   该有的几何体、材质、贴图、灯光、交互都要真的写出来，而不是留一个只有单个 primitive 的骨架。
   允许在规格描述的场景范围内自由发挥细节（道具、陈列、氛围、动画），
   但不要引入规格之外的构建系统、框架或新的运行时依赖。`
    : `${nextNote + 1}. 严格按任务规格执行，不要擅自扩大范围去重构任务之外的模块。`

  return `你是由 Google Antigravity 驱动的软件工程执行智能体（Executor）。
上级是架构师/总策划（Planner），它负责规划与验收；你只负责落地编码。

**本次任务的工作区（唯一允许改动的目录）**：
${workspace}

硬性约束：
1. 所有文件路径都用**绝对路径**，且必须位于上面的工作区内。绝不要读写工作区之外的路径。
2. 所有 shell 命令都必须以 \`${workspaceSwitchHint(workspace)}\` 开头，
   因为 run_command 的默认工作目录不在你的项目里。
   例：${shellPreamble(workspace)}python -m pytest -q
${notes}
${nextNote}. **禁止启动常驻进程**：不要运行 \`npm run dev\` / \`vite\` / \`next dev\` 这类开发服务器，
   也不要运行会进入 watch 模式的测试（\`vitest\` 必须写成 \`vitest run\` 或加 \`--run\`；\`jest\` 不要加 \`--watch\`）。
   验证请用一次性命令，例如 \`CI=true npm test\`、\`npm run build\`、\`vitest run\`。
   常驻进程不会自己退出，会把本回合一直挂到超时。
${scopeRule}

完成后必须汇报：
- 新建/修改了哪些文件（相对工作区的路径）
- 运行了哪些命令、输出结果如何
- 任何未完成项、风险或需要上级决策的问题
${creative ? `\n${creativePreamble()}\n` : ''}
--- 任务规格（Task Spec）---
${taskSpec}
`
}

// ---------------------------------------------------------------------------
// tool bodies
// ---------------------------------------------------------------------------

async function checkEnvironment(ctx) {
  const lines = [
    'bridge       : antigravity-executor (native plugin, account login)',
    `auth         : Antigravity desktop account session (no API key involved)`,
    `tiers        : ${[...new Set(Object.values(THINKING_TIERS))].join(', ')}`,
    `thinking map : ${Object.entries(THINKING_TIERS).map(([k, v]) => `${k}->${v}`).join(', ')}`,
    `default tier : ${cfg.thinkingLevel} (-> ${THINKING_TIERS[cfg.thinkingLevel]})` +
      (cfg.allowOverride ? ', overridable per call' : ', override disabled'),
    `workspace    : ${cfg.followSessionWorkspace ? 'follows the dsh session cwd' : 'must be passed explicitly'}` +
      (cfg.allowOutsideWorkspace ? ' (outside-workspace allowed)' : ' (outside-workspace refused)'),
    `audit        : ${cfg.audit ? (cfg.failOnEscape ? 'on, escapes fail the turn' : 'on, escapes reported') : 'OFF'}` +
      (cfg.realtimeKillSwitch
        ? ', kill-switch armed (destructive commands always cut)'
        : ', kill-switch off'),
    `settlement   : rpc-state-machine (fastSettle ${cfg.fastSettleSeconds}s)` +
      `, quiet-window fallback ${cfg.quietWindowSeconds}s, poll ${cfg.pollIntervalSeconds}s`,
    `transcript   : ${cfg.useFullTranscript ? 'prefer transcript_full.jsonl (anti-truncation)' : 'compact transcript only'}`,
    `quota policy : ${
      cfg.quotaFallback.enabled
        ? `pro -> flash below ${(cfg.quotaFallback.proMinFraction * 100).toFixed(0)}% (5h)` +
          (cfg.quotaFallback.weeklyGuard
            ? `, weekly reserve ${(cfg.quotaFallback.weeklyProMinFraction * 100).toFixed(0)}%` +
              ` (falls back to the ${(cfg.quotaFallback.proMinFraction * 100).toFixed(0)}% floor` +
              ` in the last ${cfg.quotaFallback.weeklyReserveHours}h)`
            : ', weekly guard off') +
          `, cache ${cfg.quotaFallback.cacheTtlSeconds}s`
        : 'no auto-fallback'
    }`,
    `artifacts    : ${
      cfg.includeBrainArtifacts
        ? `brain .md collected (inline <= ${cfg.maxArtifactInlineChars} chars, else head ${cfg.maxArtifactHeadChars} + path)`
        : 'off'
    }`,
    `task mode    : ${
      cfg.taskMode === 'auto'
        ? 'auto-detected per call (creative for 3D/WebGL/Canvas/UI, surgical otherwise)'
        : `pinned to ${cfg.taskMode} by config`
    }`,
    `session hint : suggest a new session_id after ${cfg.longSessionTurns} turns`,
    `hanging cmd  : ` +
      (Number(cfg.hangingCommandTimeoutSeconds) > 0 && cfg.realtimeKillSwitch
        ? `cut at ${cfg.hangingCommandTimeoutSeconds}s when no new step appears` +
          ` (warn at ${cfg.hangingCommandWarnSeconds}s)`
        : `warn when a dev server/watch runs > ${cfg.hangingCommandWarnSeconds}s (no active cut)`),
    `git snapshot : ${cfg.includeGitSummary ? 'git status/diff --stat inlined at settlement' : 'off'}`,
    renderPacing(cfg, pacer.status()),
    renderQueue(delegationQueue.status()),
    `sessions     : ${cfg.persistSessions ? SESSIONS_FILE : '(in memory only)'}`,
    `platform     : ${process.platform} (shell: ${process.platform === 'win32' ? 'PowerShell' : 'POSIX sh'})`,
  ]

  let server
  try {
    server = await discoverLanguageServer({ refresh: true })
    lines.push(`live LS      : pid=${server.pid} port=${server.port} csrf=set`)
    lines.push('status       : READY - delegations will use your signed-in account')
  } catch (error) {
    lines.push('live LS      : NOT AVAILABLE')
    lines.push(`status       : BLOCKED - ${error.message}`)
    return lines.join('\n')
  }

  // Quota (REQ-03): always a live read here — a manual health check must not
  // report a cached fraction (v0.5.0 keeps the cache for delegations only).
  try {
    const quota = await readQuota(server)
    quotaCache.invalidate()
    lines.push('', renderQuota(quota))
    if (cfg.quotaFallback.enabled) {
      const decision = applyQuotaFallback(THINKING_TIERS[cfg.thinkingLevel], quota, cfg)
      lines.push(
        `fallback     : ${
          decision.downgraded !== undefined
            ? `active — this delegation would run as ${decision.tier} (${decision.downgraded})`
            : 'not triggered (target tier has budget)'
        }`,
      )
      if (decision.note !== undefined) lines.push(`quota note   : ${decision.note}`)
    }
  } catch (error) {
    lines.push('', `quota        : unavailable (${error.message})`)
  }

  // Git worktree deadlock pre-check (REQ-07) against the session workspace.
  const found = sessionWorkspace(ctx, undefined)
  if (found.workspace !== undefined) {
    try {
      const git = await checkWorktreeConfig(found.workspace)
      lines.push('', `workspace chk: ${found.workspace}`)
      lines.push(
        git.worktreeConfig
          ? (git.warning ?? 'worktree_config_warning: extensions.worktreeConfig = true')
          : 'worktree cfg : ok (extensions.worktreeConfig not enabled)',
      )
    } catch (error) {
      lines.push(`worktree cfg : check failed (${error.message})`)
    }
  }

  return lines.join('\n')
}

async function listConversations(limit) {
  const store = await state()
  const rows = sessionStore.list(store, Math.max(1, Number(limit) || 20))
  if (rows.length === 0) return '(no delegated conversations yet)'
  return [
    'session_id | workspace | tier | conversation_id | updated_at',
    ...rows.map(
      (r) =>
        `${r.session_id ?? '?'} | ${r.workspace_dir ?? r.workspace ?? '?'} | ${r.tier ?? '?'} | ` +
        `${r.conversation_id ?? '?'} | ${r.updated_at ?? '?'}`,
    ),
  ].join('\n')
}

/**
 * One delegation, serialised against every other one (v0.6.0 / REQ-02).
 *
 * The lock is taken *outside* everything else in the call — before the quota
 * read, the workspace check and above all before `pacer.waitForTurnStart` — for
 * a reason that is easy to get wrong: the pacing delay is only meaningful if it
 * is measured against a `lastTurnFinishedAt` that no sibling call can move while
 * we are waiting. Acquire in the wrong order and two parallel calls both observe
 * "the previous turn ended long ago", both skip the gap, and the lock then just
 * makes them slow instead of keeping them apart.
 *
 * The mutex does not swallow the result: the body's own rejection propagates to
 * its own caller, and the next waiter starts in a `finally`.
 */
async function delegate(args, ctx, exec) {
  const startedAt = Date.now()
  const waited = delegationQueue.status().queued
  if (waited > 0) {
    progressLog(
      `[antigravity] 委派串行化（REQ-02）：前方还有 ${waited} 个委派在排队，` +
        '避免并发击穿 pacing 冷却与工作区写入冲突',
    )
  }
  return await delegationQueue.run(async () => {
    const queuedMs = Date.now() - startedAt
    return await delegateOnce({ ...args, queuedMs }, ctx, exec)
  })
}

async function delegateOnce(
  {
    task_spec: taskSpec,
    workspace_dir: workspaceDir,
    thinking_level: thinking,
    session_id: sessionId = 'main-dev-session',
    task_mode: taskModeArg,
    max_seconds: maxSeconds,
    signal,
    queuedMs,
  },
  ctx,
  exec,
) {
  if (String(taskSpec ?? '').trim() === '') {
    return '[error] task_spec must be a non-empty specification'
  }

  // --- v0.6.0 / REQ-01: which persona is this? ---------------------------
  // Resolved before anything expensive happens, so the prompt, the gate and the
  // report all agree on one decision. A config-level `taskMode` (when it is not
  // `auto`) pins the mode for this profile; otherwise the call argument wins and
  // the task_spec regex is the fallback — which is what makes the feature work
  // without the user ever editing a file.
  const modeDecision = resolveTaskMode({
    task_mode: taskModeArg ?? (cfg.taskMode !== 'auto' ? cfg.taskMode : undefined),
    task_spec: taskSpec,
  })
  const mode = modeDecision.mode

  // Thinking level: explicit call argument > configured default.
  const level = resolveThinking(thinking)
  if (level.error !== undefined) return level.error
  const desiredTier = THINKING_TIERS[level.level]

  // Workspace: explicit argument > the dsh session cwd.
  const placement = resolveWorkspace(workspaceDir, ctx, exec)
  if (placement.error !== undefined) return placement.error
  const workspace = placement.workspace

  if (!isDirectory(workspace)) {
    return `[error] workspace 不是已存在的目录：${workspace}`
  }

  const budget = Number(maxSeconds) > 0 ? Number(maxSeconds) : cfg.maxSeconds
  const timeoutMs = Math.max(60, budget) * 1000

  let server
  try {
    server = await getServer()
  } catch (error) {
    return `[error] Antigravity 不可用：${error.message}`
  }

  const started = Date.now()

  // --- REQ-03: quota-aware tier selection --------------------------------
  let tier = desiredTier
  let downgraded
  let quotaNote
  let quotaCached = false
  if (cfg.quotaFallback.enabled) {
    try {
      // v0.5.0: reuse a recent read (unless the value is near the guard, where a
      // stale fraction is exactly what would be dangerous).
      const read = await quotaCache.read(server, cfg)
      quotaCached = read.cached
      if (read.quota !== undefined) {
        const decision = applyQuotaFallback(desiredTier, read.quota, cfg)
        tier = decision.tier
        downgraded = decision.downgraded
        quotaNote = decision.note
        if (quotaCached && quotaNote !== undefined) {
          quotaNote = `${quotaNote}（使用 ${Math.round((Date.now() - Number(read.quota.readAt)) / 1000)}s 前的额度快照）`
        }
      }
    } catch {
      // A quota read failure must never block a delegation.
    }
  }

  // --- REQ-07: git worktree deadlock pre-check ---------------------------
  let worktreeWarning
  try {
    const git = await checkWorktreeConfig(workspace)
    if (git.worktreeConfig) worktreeWarning = git.warning
  } catch {
    // Pre-check is advisory only.
  }

  const key = sessionKey(workspace, sessionId)
  const store = await state()
  const record = store[key] ?? {}
  const prompt = buildPrompt(workspace, taskSpec, { mode })

  // --- v0.5.0: human-like gap before starting the next turn ----------------
  // This never delays the *result* of a turn (that is settled below, as fast as
  // the RPC allows); it only tops up the gap between two consecutive
  // delegations so a tight reject-and-retry loop does not look scripted.
  let paced
  try {
    paced = await pacer.waitForTurnStart(cfg)
    if (paced.waitedMs > 0) {
      progressLog(`[antigravity] 拟人冷却：等待 ${Math.round(paced.waitedMs / 1000)}s 后开始下一轮`)
    }
  } catch {
    // Pacing is advisory; a failure must never block a delegation.
  }

  let conversationId = record.conversation_id
  let resumed = false
  let sinceIndex = 0
  /** Set when a persisted session turned out to be dead (v0.5.0 self-heal). */
  let evicted

  try {
    if (conversationId) {
      try {
        const prior = await readTranscript(conversationId, {
          server,
          preferFull: cfg.useFullTranscript,
        })
        sinceIndex =
          prior.steps.length === 0
            ? 0
            : Math.max(...prior.steps.map((step) => Number(step.step_index ?? 0))) + 1
        await agentapi(server, ['send-message', conversationId, prompt], timeoutMs)
        resumed = true
      } catch (error) {
        // v0.5.0 dead-session self-heal: the persisted mapping outlived the
        // conversation it points at (the user deleted the thread, or the brain
        // directory was cleared). Without evicting the record every future
        // delegation on this session_id would fail the same way forever, so the
        // persistence would be worse than not persisting at all.
        evicted = { conversationId, reason: error?.message ?? String(error) }
        conversationId = undefined
      }
    }
    if (!conversationId) {
      const title = String(sessionId).replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 40) || 'agy'

      // --- v0.6.0 / REQ-03: do not lose the thread's context -----------------
      // A dead mapping is only cheap to replace on turn 1. From turn 2 onwards
      // the planner's next message is usually an *increment* ("change line 40 of
      // that function"), which a blank conversation cannot possibly resolve — it
      // would guess, and guessing on a 200-file project is how a repair pass
      // turns into a rewrite. The banner re-states what the old thread had been
      // touching so the fresh conversation starts by reading the right files.
      const recovery =
        evicted === undefined ? undefined : contextRecoveryBanner(record, { sessionId })
      const freshPrompt = recovery === undefined ? prompt : `${recovery}\n\n${prompt}`

      const response = await agentapi(
        server,
        ['new-conversation', `--model=${tier}`, `--title=${title}`, freshPrompt],
        timeoutMs,
      )
      conversationId = response?.newConversation?.conversationId
      if (!conversationId) {
        return `[error] agentapi 没有返回 conversationId：${JSON.stringify(response).slice(0, 300)}`
      }
      const fresh = await readTranscript(conversationId, {
        server,
        preferFull: cfg.useFullTranscript,
      })
      sinceIndex =
        fresh.steps.length === 0
          ? 0
          : Math.max(...fresh.steps.map((step) => Number(step.step_index ?? 0))) + 1
      // A dead mapping was just replaced: drop it before writing the new one so
      // the persisted file cannot keep pointing at a conversation that is gone.
      if (evicted !== undefined) sessionStore.remove(store, workspace, sessionId)
      store[key] = sessionStore.set(store, {
        sessionId,
        workspace,
        conversationId,
        tier,
        // A brand-new conversation starts its own count.
        turns: 0,
      })
      await persist(store)
      resumed = false
      if (evicted !== undefined) {
        evicted = { ...evicted, recoveryBanner: recovery !== undefined }
      }
    }

    const remaining = Math.max(30_000, timeoutMs - (Date.now() - started))

    // --- REQ-04 / REQ-05: streaming audit + mid-flight kill switch --------
    // The auditor is stateful: it walks the turn in step order so a `cd` in one
    // step changes how a relative path in the next one resolves.
    //
    // v0.5.0 SPLITS THE CIRCUIT BREAKER IN TWO:
    //   - a destructive command (`reg delete`, `diskpart`, recursive delete, …)
    //     is stopped whenever `realtimeKillSwitch` is on, *regardless of
    //     `failOnEscape`*. `failOnEscape: false` means "I tolerate the executor
    //     reading outside my workspace"; it was never meant to mean "I tolerate
    //     `reg delete`". Tying the two together is what made the shipped 0.4.0
    //     default silently disarm the breaker entirely.
    //   - an ordinary workspace escape (`cd-outside`, `write-outside`) still
    //     requires `failOnEscape`, so tolerant profiles keep working as before.
    const auditor = cfg.audit ? createAuditor(workspace) : undefined
    const breakOnDestructive = cfg.audit && cfg.realtimeKillSwitch
    const breakOnEscape = cfg.audit && cfg.realtimeKillSwitch && cfg.failOnEscape
    let killed
    /** Tools that look like they will never exit, tracked across ticks (v0.5.0). */
    const hanging = new Map()

    const progress = []
    const onEvent = (event) => {
      if (event.kind === 'progress' && event.text) {
        progress.push(event.text)
        progressLog(`[antigravity] ${event.text}`)
      }
    }
    const onStep = (step) => {
      // --- v0.5.0 / v0.6.0: remember dev servers and watch runners ----------
      // This runs whether or not the workspace auditor is enabled. It used to
      // sit *below* `if (auditor === undefined) return`, which meant
      // `audit: false` silently disabled hanging-command detection AND the 60 s
      // circuit breaker that depends on it — a guard that could not fire, the
      // exact class of bug this release exists to remove. Killing a turn that is
      // wedged on `npm run dev` is a *liveness* concern, not an audit one.
      for (const hit of findHangingCommands(step)) {
        const token = `${step?.step_index}:${hit.index}`
        if (!hanging.has(token)) hanging.set(token, { ...hit, stepIndex: step?.step_index, seenAt: Date.now() })
      }

      if (auditor === undefined) return undefined

      const verdict = auditor.push(step)
      const destructive = verdict.blockedDestructive === true
      const escape = verdict.blockedEscape === true
      if ((destructive && breakOnDestructive) || (escape && breakOnEscape)) {
        const findings = verdict.violations.filter((v) => {
          const kind = classifyFinding(v.kind)
          return (kind === 'destructive' && breakOnDestructive) || (kind === 'escape' && breakOnEscape)
        })
        const label = destructive ? '高危破坏性命令' : '工作区越界'
        return {
          block: true,
          reason:
            `事中熔断（${label}）：` +
            findings
              .map((v) => `${v.kind}${v.path ? ` ${v.path}` : ''}`)
              .join('; '),
        }
      }
      return undefined
    }

    /**
     * The wall-clock half of the kill switch (v0.6.0 / REQ-04).
     *
     * WHY `onStep` IS NOT ENOUGH
     * --------------------------
     * `onStep` only fires when a *new* trajectory step appears. A dev server is
     * the one failure mode that guarantees no further steps will ever appear: the
     * `run_command` step is emitted once, the cascade then sits BUSY until the
     * deadline, and the turn returns a bare timeout with zero diagnostics — the
     * exact 900-second wait this REQ exists to remove. v0.5.1 could only name the
     * command afterwards.
     *
     * `onTick` runs on every poll iteration instead, so the elapsed time is
     * finally observable while it matters. Two conditions must hold before we
     * cut, and both are load-bearing:
     *   1. the hanging command is still the NEWEST step (nothing newer arrived);
     *   2. it has been running for `hangingCommandTimeoutSeconds`.
     * Condition 1 is what keeps this from killing a healthy long build: a
     * `npm run build` that prints progress produces new steps, and the moment one
     * arrives the hang suspicion is dropped (the newest step is no longer the
     * suspect). Without it, a legitimate 3-minute build would be cut at 60s.
     */
    const hangTimeoutSeconds = Number(cfg.hangingCommandTimeoutSeconds)
    const cutHanging = cfg.realtimeKillSwitch && Number.isFinite(hangTimeoutSeconds) && hangTimeoutSeconds > 0
    const onTick = (tick) => {
      if (!cutHanging || hanging.size === 0) return undefined
      const steps = Array.isArray(tick?.steps) ? tick.steps : []
      const newest = steps.length === 0 ? undefined : steps[steps.length - 1]
      const newestIndex = Number(newest?.step_index)
      const newestHit = [...hanging.values()].find((hit) => hit.stepIndex === newestIndex)
      if (newestHit === undefined) return undefined

      const verdict = evaluateHangingTimeout({
        hanging: [...hanging.values()].map((hit) => ({
          stepIndex: Number(hit.stepIndex),
          since: Number(hit.seenAt),
        })),
        newestStepIndex: newestIndex,
        newestStepAt: Number(newestHit.seenAt),
        now: Date.now(),
        timeoutMs: hangTimeoutSeconds * 1000,
      })
      if (verdict.block !== true) return undefined

      // Name the command and the fix, not just the timeout: the executor's next
      // attempt is decided by whoever reads this line.
      return {
        block: true,
        reason:
          `Aborted after ${hangTimeoutSeconds}s: hanging/interactive command detected ` +
          `(${newestHit.command}). ` +
          `Use non-interactive/single-run flags (e.g. vitest run, CI=true).\n` +
          `  ${verdict.reason}\n` +
          `  cmd: ${newestHit.command}`,
      }
    }

    const outcome = await waitForTurn({
      conversationId,
      sinceIndex,
      server,
      cfg,
      signal,
      onEvent,
      onStep,
      onTick,
    })

    if (outcome?.killed !== undefined) killed = outcome.killed
    const settlement = outcome?.settlement ?? 'timeout'
    const terminationReason = outcome?.terminationReason
    const outcomeError = outcome?.error

    // A turn that settled without an answer is a failure, not a result: the
    // executor died (ERROR / HALTED_STEP), was cancelled, or simply never
    // replied. Report the real cause instead of an empty report with a CLEAN
    // audit, which reads as success.
    if (outcomeError !== undefined && (outcome?.answer === undefined || outcome?.answer === '')) {
      const hint =
        terminationReason === 'USER_CANCELED'
          ? '（本轮已被取消）'
          : ''
      throw new Error(`${outcomeError}${hint}`)
    }

    // --- REQ-02: anti-truncation read for the report ----------------------
    const transcript = await readTranscript(conversationId, {
      server,
      preferFull: cfg.useFullTranscript,
    })
    const answer = outcome?.answer ?? ''
    const trace = outcome?.trace ?? []

    // --- REQ-07 / v0.5.0: brain artifacts ("audit in full, report compactly") -
    let artifacts = []
    if (cfg.includeBrainArtifacts) {
      try {
        artifacts = await collectBrainArtifacts(conversationId, {
          sinceMs: started,
          maxInlineChars: cfg.maxArtifactInlineChars,
          oversizeHeadChars: cfg.maxArtifactHeadChars,
        })
      } catch {
        // Advisory: a missing brain dir never fails the delegation.
      }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    const traceBlock = trace.length > 0 ? trace.join('\n') : '  (no tool calls recorded)'

    // The audit re-reads the whole turn from the anti-truncated transcript, so
    // it also covers resumed turns and every call the streaming pass saw.
    let auditBlock = ''
    let failed = false
    let auditReport
    if (cfg.audit) {
      auditReport =
        auditor !== undefined
          ? auditor.report()
          : auditTurn(transcript.steps, sinceIndex, workspace)
      auditBlock = renderAudit(auditReport, workspace)
      failed = cfg.failOnEscape && auditReport.violations.some((v) => v.severity === 'error')
    }

    // --- v0.6.0 / REQ-07: git snapshot, taken while we still have the facts ---
    // The planner needs to know whether anything actually changed, and the only
    // way to know without a second tool round is to ask git here. It also powers
    // the "claims it edited files, worktree is clean" notice below — the cheapest
    // detector for a delegation that hallucinated its own success.
    let gitSummary
    let gitBlock
    if (cfg.includeGitSummary) {
      try {
        gitSummary = await readGitSummary(workspace, { timeoutMs: 3000 })
        gitBlock = renderGitSummary(gitSummary)
      } catch {
        // Advisory: a wedged repo must never fail a finished delegation.
      }
    }

    const head = failed
      ? '=== Antigravity executor report — REJECTED BY AUDIT ==='
      : killed !== undefined
        ? '=== Antigravity executor report — INTERRUPTED BY KILL SWITCH ==='
        : '=== Antigravity executor report (account login) ==='

    const out = [
      head,
      `tier         : ${tier} (thinking=${level.level}, from ${level.source})` +
        (downgraded !== undefined ? ` — downgraded: ${downgraded}` : ''),
      ...(level.note !== undefined ? [`level note   : ${level.note}`] : []),
      ...(quotaNote !== undefined ? [`quota note   : ${quotaNote}`] : []),
      `workspace    : ${workspace} (from ${placement.source})`,
      `session_id   : ${sessionId}`,
      ...(cfg.includeTaskModeHint ? [renderTaskMode(modeDecision)] : []),
      ...(modeDecision.note !== undefined ? [`mode note    : ${modeDecision.note}`] : []),
      `conversation : ${conversationId} (${resumed ? 'resumed' : 'new'})`,
      `duration     : ${elapsed}s (settled by ${settlement}` +
        (terminationReason !== undefined ? `, ${terminationReason}` : '') +
        ')',
      `transcript   : ${transcript.source}` +
        (transcript.truncatedSteps.length > 0
          ? ` (still truncated: steps ${transcript.truncatedSteps.join(', ')})`
          : ''),
      `tool calls   : ${trace.length}`,
    ]

    if (worktreeWarning !== undefined) out.push('', worktreeWarning)
    if (killed !== undefined) {
      out.push('', '--- kill switch ---', `${renderKilledStep(killed)}: ${killed.reason}`)
    }

    out.push(
      '',
      '--- executor message ---',
      answer.trim() || '(executor produced no final message)',
    )

    out.push('', '--- audited tool calls ---', traceBlock, '--- end ---')

    if (artifacts.length > 0) {
      out.push('', '--- brain artifacts ---')
      for (const artifact of artifacts) {
        const size = `${artifact.bytes}B`
        out.push(`  ${artifact.name} (${size}, ${artifact.updatedAt})`)
        out.push(`    path: ${artifact.path}`)
        if (artifact.inline === true) {
          // Short enough to hand over whole.
          if (artifact.summary) {
            out.push(`    content: ${artifact.summary.replace(/\n/g, '\n             ')}`)
          }
        } else {
          // Oversized: inline only the head, and say plainly where the rest is,
          // so the planner reads the file itself when it actually needs it.
          const shown = artifact.summary.length
          out.push(
            `    summary: (${shown}/${artifact.chars} chars shown — read the file above for the rest)`,
          )
          if (artifact.summary) {
            out.push(`    ${artifact.summary.replace(/\n/g, '\n    ')}`)
          }
        }
      }
    }

    // --- v0.5.0: a dev server / watcher would burn the whole budget ----------
    const warnSeconds = Number(cfg.hangingCommandWarnSeconds)
    if (hanging.size > 0 && Number.isFinite(warnSeconds) && warnSeconds > 0) {
      const now = Date.now()
      const blocked = [...hanging.values()].filter((hit) => now - hit.seenAt >= warnSeconds * 1000)
      if (blocked.length > 0) {
        out.push('', '--- long-running command warning ---')
        for (const hit of blocked) {
          out.push(
            `  step ${hit.stepIndex}: ${hit.id} — ${hit.why}（已持续 ${Math.round((now - hit.seenAt) / 1000)}s）`,
            `    cmd: ${hit.command}`,
          )
        }
        out.push(
          '  这类命令不会自己退出，会把回合拖到 maxSeconds 才超时。',
          '  下次派单请明确要求用一次性命令（`vitest run`、`CI=true npm test`、`npm run build`）。',
        )
      }
    }

    // --- v0.6.0 / REQ-07: the git snapshot the planner would otherwise re-run --
    if (gitBlock !== undefined) {
      out.push('', gitBlock)

      // "I changed the files" + a clean worktree is the signature of a delegation
      // that reported its own success without writing anything. Only claim it when
      // the turn was not cut short (a killed or timed-out turn legitimately has no
      // changes) AND the auditor saw no file write either — otherwise a legitimate
      // edit made through a path the snapshot cannot see would be slandered.
      const cleanWorktree = gitSummary?.changed === 0 && gitSummary?.untracked === 0
      const wroteNothing = !Number.isFinite(Number(auditReport?.fileWrites)) ||
        Number(auditReport?.fileWrites) === 0
      const finishedNormally = killed === undefined && settlement !== 'timeout' && outcomeError === undefined
      if (cleanWorktree && wroteNothing && finishedNormally) {
        out.push(
          '[Notice: Git working tree shows no modified or untracked files.]',
          '  审计器也没有看到任何文件写入步骤，但执行器声称已完成修改——',
          '  这通常意味着它只给了说明而没有真的落地，请按上面的「executor message」逐条核对。',
        )
      }
    }

    // --- v0.5.0: session hygiene -------------------------------------------
    // Persisting the mapping buys continuity, but a conversation that has run
    // for many turns re-sends an ever larger history every round, so the quota
    // cost per turn grows with it. Say so once the threshold is crossed.
    const turns = record?.turn_count
    if (Number.isFinite(Number(turns)) && Number(turns) >= Number(cfg.longSessionTurns)) {
      const hint = longSessionHint(
        { turn_count: Number(turns) + (resumed ? 1 : 0) },
        cfg.longSessionTurns,
      )
      if (hint !== undefined) out.push('', hint)
    }

    if (evicted !== undefined) {
      out.push(
        '',
        '--- session self-heal ---',
        `  旧映射 ${evicted.conversationId} 已失效（${evicted.reason.slice(0, 160)}），`,
        '  已从持久化表中剔除并自动开启新会话。',
        `  session_evicted_and_recreated: true` +
          (evicted.recoveryBanner === true
            ? '（已向新会话注入上下文恢复头：历史触碰文件 + 上一轮任务摘要）'
            : ''),
      )
    }

    if (progress.length > 0) {
      out.push('', `--- progress (${progress.length} steps) ---`)
      out.push(...progress.slice(-40))
    }

    if (auditBlock !== '') out.push('', auditBlock)

    // --- v0.6.0 / REQ-01: the Pass-1 creative gate -------------------------
    // In creative mode a syntax-clean first pass is the *expected* result and
    // precisely not the acceptance bar: the failure this REQ exists to fix is a
    // planner that sees "no errors" and stops, leaving a scene of bare boxes. The
    // gate is emitted only on turn 1 of a creative session — after Pass 2 the
    // same paragraph would just nag the planner into endless expansion rounds.
    const gate = creativeReviewGate({
      mode,
      turnCount: nextTurnCount(store[key] ?? record, conversationId),
    })
    if (gate !== undefined) out.push('', gate)

    out.push(
      '',
      'Reminder: review `git diff` and run the verification commands yourself.',
      'Note: agentapi conversations are not workspace-bound; the audit above inspects',
      'what actually happened, but it cannot stop an executor that ignores the preamble.',
    )

    if (failed) {
      throw new Error(`审计判定为越界，结果不予采纳。\n${out.join('\n')}`)
    }

    // --- v0.5.0 bookkeeping on the success path ---------------------------
    // A completed turn advances the session counter; the pacing clock is noted
    // in the `finally` below so a failed turn still spaces the next one.
    //
    // v0.6.0 / REQ-03: the same write also records WHAT this turn touched, so a
    // later dead-session eviction can hand the replacement conversation enough
    // context to act on an incremental instruction instead of guessing.
    try {
      const current = store[key] ?? {}
      store[key] = sessionStore.set(store, {
        sessionId,
        workspace,
        conversationId,
        tier,
        turns: nextTurnCount(current, conversationId),
        lastTouchedFiles: sessionTouchedFiles(auditReport),
        lastTaskHead: String(taskSpec ?? '').slice(0, 200),
      })
      await persist(store)
    } catch {
      // Bookkeeping is advisory; it must never fail a finished delegation.
    }

    return out.join('\n')
  } catch (error) {
    return (
      `[error] Antigravity 执行失败：${error.message}\n` +
      `workspace: ${workspace}\nsession_id: ${sessionId}` +
      (conversationId ? `\nconversation: ${conversationId}` : '')
    )
  } finally {
    // v0.5.0: any finished attempt starts the pacing clock, successful or not.
    // A reject-and-retry loop is exactly the pattern the jitter exists to soften,
    // so keying it off the success path only would leave the tightest loop
    // completely unpaced.
    try {
      pacer.noteTurnFinished()
    } catch {
      // Never let pacing bookkeeping escape a tool body.
    }
  }
}

// ---------------------------------------------------------------------------
// bundled skill
// ---------------------------------------------------------------------------

const SKILL_NAME = 'supervisor-workflow'
const SKILL_BODY_URL = new URL('../skills/supervisor-workflow/SKILL.md', import.meta.url)
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/supervisor-workflow/', import.meta.url)),
}

const SKILL_SUMMARY = {
  name: SKILL_NAME,
  description:
    '主从协同开发模式：把当前模型锁定为总策划与验收官（Planner），把所有代码改动委派给 ' +
    'Antigravity 执行器（已登录的桌面账号，gemini-3.8-flash），再用 git diff 与测试独立验收。' +
    '当任务涉及新建/修改项目源码、重构、或修复 bug 且本会话有 delegate_coding_task 工具时使用。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: 'antigravity-executor',
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
}

/**
 * Serves the bundled `supervisor-workflow` skill.
 *
 * The body lives in `skills/supervisor-workflow/SKILL.md` and ships with the
 * package, so the workflow and the tools it drives can never drift apart: an
 * upgrade replaces both at once.
 */
const skillProvider = {
  name: 'antigravity-executor',
  list: () => Promise.resolve([{ ...SKILL_SUMMARY, rank: 600, locator: SKILL_BODY_URL }]),
  async get() {
    return {
      ...SKILL_SUMMARY,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  // Merge the validated user config over the schema defaults. The nested blocks
  // are merged one level deep, so a partial block must not wipe the half that
  // was supplied.
  cfg = {
    ...DEFAULT_CONFIG,
    ...(config ?? {}),
    quotaFallback: { ...DEFAULT_CONFIG.quotaFallback, ...(config?.quotaFallback ?? {}) },
    pacing: { ...DEFAULT_CONFIG.pacing, ...(config?.pacing ?? {}) },
  }

  // Real-time progress (REQ-08) goes to the host log; a tool body has no
  // progress channel of its own, and the log is what a user watches while a
  // long delegation runs.
  const logger = ctx.logger?.('antigravity-executor')
  progressLog = (line) => {
    try {
      logger?.info?.(line)
    } catch {
      // A logging failure must never break a delegation.
    }
  }

  // Drop any cached server on startup: a previous process may have left a stale
  // port behind (REQ-06).
  invalidateDiscovery()

  // The workflow skill ships in this package, so it appears wherever the
  // plugin runs and disappears when the bundle is toggled off.
  ctx.skills.registerProvider(() => skillProvider)

  ctx.tools.register(
    defineTool({
      name: 'check_environment',
      description:
        'Report whether the Antigravity bridge is ready: the live desktop Language Server, ' +
        'its HTTP port, model tiers, the effective default thinking level, workspace policy, ' +
        'account quota (per-tier remaining fraction and reset countdown), git worktree ' +
        'deadlock pre-check and session bookkeeping. Cheap (no model call).',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => renderText(value) },
      async execute(_args, _exec) {
        return await checkEnvironment(ctx)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_conversations',
      description:
        'List recent Antigravity conversations started by this plugin (session id, ' +
        'workspace, tier, conversation id). The map is persisted on disk, so it survives ' +
        'a dsh restart. Useful for finding a thread to resume.',
      parameters: {
        limit: { type: 'number', description: 'How many rows to return (default 20).' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => renderText(value) },
      async execute(args) {
        return await listConversations(args.limit)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'delegate_coding_task',
      description:
        'Delegate a concrete coding task (create/edit files, refactor, run local tests) to ' +
        'the Antigravity agent signed in on this machine. By default it works in the current ' +
        "dsh session's working directory, so workspace_dir can be omitted. Returns the " +
        'executor report, an audited tool-call trace, a workspace audit of everything the ' +
        'executor touched, and any brain artifacts it produced. The turn settles on the ' +
        "server's own RPC state, so a finished turn returns within seconds instead of waiting " +
        'out a fixed quiet window. The caller must still review the diff and run the ' +
        'verification itself.',
      parameters: {
        task_spec: {
          type: 'string',
          required: true,
          description:
            'Full task specification: target file paths, required logic, edge cases, ' +
            'interface contracts and acceptance criteria.',
        },
        workspace_dir: {
          type: 'string',
          description:
            "Absolute path the executor may touch. Omit to use the current dsh session's " +
            'working directory (recommended). A path outside that directory is refused unless ' +
            'the plugin config sets allowOutsideWorkspace: true.',
        },
        task_mode: {
          type: 'string',
          enum: ['surgical', 'creative'],
          description:
            'Which persona to drive the executor with. OMIT IN NORMAL USE — the mode is ' +
            'auto-detected from task_spec (creative for 3D/Three.js/WebGL/Canvas/shader/' +
            'landing page/game/UI design, surgical for everything else). Passing it explicitly ' +
            'only overrides that detection. "surgical": bug fixes, backend logic, refactors, ' +
            'tests — minimal, scope-disciplined changes. "creative": 3D scenes, WebGL/Canvas, ' +
            'mini-games, high-interaction UI pages — visual density over code brevity, with a ' +
            'Pass-1 review gate in the result that tells you to run another pass on the same ' +
            'session_id if the scene came back skeletal.',
        },
        thinking_level: {
          type: 'string',
          enum: THINKING_LEVELS,
          description:
            'Per-call override of the configured default thinking level ' +
            '(minimal | low | medium | high | extra_high -> flash_lite/flash/pro). ' +
            'Omit to use the plugin config default selected in cordis.patch.yml; ' +
            'ignored entirely when the config sets allowOverride: false. ' +
            'A low-quota account may be auto-downgraded from pro to flash.',
        },
        session_id: {
          type: 'string',
          description:
            'Stable label for a feature/repair thread; reuse it to continue the same ' +
            'conversation on rework rounds.',
        },
        max_seconds: {
          type: 'number',
          description: 'Wall-clock budget for this delegation (default from plugin config, 900).',
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => renderText(value) },
      async execute(args, exec) {
        return await delegate({ ...args, signal: exec?.signal }, ctx, exec)
      },
    }),
  )
}
