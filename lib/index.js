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
  brainDir,
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
import { createUiProxy } from './proxy.mjs'
import { createSerialQueue, renderQueue } from './queue.js'
import { applyQuotaFallback, createQuotaCache, pickBillingBuckets, readQuota, renderQuota } from './quota.js'
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
import { createTelemetryBus, normalizeStep } from './telemetry.mjs'
import { readTranscript } from './transcript.js'
import { evaluateHangingTimeout, waitForTurn } from './turn.js'
import { startUiServer } from './ui-server.mjs'

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
// v0.7.0 / UI-REQ-01..06: the telemetry bus and the dashboard server
// ---------------------------------------------------------------------------

/**
 * The in-process bus every UI-visible fact is published to.
 *
 * Created once at module scope rather than per `apply()` so a Cordis HMR reload
 * can keep the settled-turn ring buffer: the point of the buffer is that a user
 * who opens the page *after* a fast turn still sees it, and dropping it on every
 * reload would defeat that exactly when the page is being reloaded too.
 */
const telemetry = createTelemetryBus({ recentTurnsLimit: DEFAULT_CONFIG.ui.recentTurnsLimit })

/** The live dashboard server handle, or undefined when UI is off/booting. */
let uiServer
/** The bound address reported by `check_environment`. */
let uiStatus = { online: false }

/**
 * Same-origin mount path inside the dsh Web GUI (v0.7.0).
 *
 * The in-app panel fetches `/antigravity-executor/api/state` and holds an
 * `EventSource` on `/antigravity-executor/api/events`; the Host half proxies both
 * to the loopback listener. Declared here so the route, the panel and the docs
 * cannot drift apart.
 */
export const UI_PROXY_PREFIX = '/antigravity-executor'

/**
 * The runtime-config overlay applied on top of `cordis.patch.yml`.
 *
 * WHY AN OVERLAY AND NOT A REWRITE OF `cfg`
 * -----------------------------------------
 * The dashboard's hot controls must take effect on the *next* turn without
 * restarting dsh, but they must not be persisted into the user's patch file
 * behind their back. Keeping the changes in `runtimeOverride` means a reload
 * discards them (back to the file), which is the honest behaviour: the file is
 * the durable declaration, the dashboard is a live tuning surface.
 */
let runtimeOverride = {}

/** The config as the dashboard and the turn dispatcher both see it. */
function effectiveConfig() {
  const pacing = { ...cfg.pacing, ...(runtimeOverride.pacing ?? {}) }
  return {
    ...cfg,
    ...runtimeOverride,
    pacing,
    quotaFallback: { ...cfg.quotaFallback, ...(runtimeOverride.quotaFallback ?? {}) },
  }
}

/** The turn currently being published to the dashboard, if any. */
let liveTurn

/**
 * Publish one audited step to the dashboard timeline.
 *
 * `turn` is captured by the closure in `delegateOnce`; this helper only adds the
 * normalisation, so the executor's auditing logic never has to know the wire
 * shape (and `telemetry.normalizeStep` stays the single place that decides it).
 *
 * @param {object} step raw trajectory step
 * @param {object} verdict the auditor's projection for this step
 */
function publishStep(step, verdict) {
  if (liveTurn === undefined) return
  try {
    telemetry.pushStep(
      liveTurn.turnId,
      normalizeStep(step, {
        ...verdict,
        virtualCwd: verdict.virtualCwd ?? liveTurn.workspaceDir,
        timestamp: Date.now(),
      }),
    )
  } catch {
    // Telemetry is observational: it must never fail a delegation.
  }
}

/**
 * Publish one quota read to the dashboard (UI-REQ-02).
 *
 * The bucket→family mapping is computed here with `quota.js`'s own classifier so
 * the page never re-implements "which bucket is the 5h window".
 *
 * @param {object} quota result of `readQuota`
 */
function publishQuota(quota) {
  try {
    const billing = pickBillingBuckets(quota)
    telemetry.setQuota(quota, {
      bucketsByFamily: { fiveHour: billing.fiveHour ?? null, weekly: billing.weekly ?? null },
    })
  } catch {
    // Observational only.
  }
}

/**
 * Project the persisted session map into the dashboard's wire shape.
 *
 * The shape is flattened on purpose: the page renders a row per session, and
 * making it reach into `record.last_touched_files` for a snake_case field would
 * couple the UI to the on-disk schema. `longSession` is pre-computed here because
 * the threshold lives in config, not in the record.
 *
 * @param {object} [store] session map; defaults to the in-memory mirror
 * @returns {Array<object>}
 */
function projectSessions(store) {
  const rows = sessionStore.list(store ?? sessionState ?? {}, 100)
  const limit = Number(effectiveConfig().longSessionTurns) || 8
  return rows.map((row) => {
    const turns = Number(row.turn_count) || 0
    return {
      sessionId: row.session_id ?? '?',
      conversationId: row.conversation_id ?? null,
      workspaceDir: row.workspace_dir ?? null,
      tier: row.tier ?? null,
      turnCount: turns,
      longSession: turns >= limit,
      lastTouchedFiles: Array.isArray(row.last_touched_files) ? row.last_touched_files : [],
      lastTaskHead: row.last_task_head ?? null,
      updatedAt: row.updated_at ?? null,
    }
  })
}

/**
 * Push the current session list (and, best-effort, the artifact index) to the UI.
 *
 * Artifact discovery touches the filesystem, so it is deliberately fire-and-
 * forget: a settled delegation must not wait on a `readdir` of the brain root,
 * and a failure there is never worth reporting as a turn failure.
 *
 * @param {object} [store] session map
 */
function publishCollectionState(store) {
  try {
    telemetry.setSessions(projectSessions(store))
  } catch {
    // Observational only.
  }
  refreshArtifactIndex().catch(() => {})
}

/**
 * Rebuild the artifact index from the brain directories of known conversations.
 *
 * Only the three report-shaped files are collected, because those are the ones
 * the drawer offers to open; listing an entire brain directory would surface
 * `.system_generated` internals the user cannot usefully read.
 */
const ARTIFACT_NAMES = ['walkthrough.md', 'implementation_plan.md', 'task.md']

async function refreshArtifactIndex() {
  const rows = sessionStore.list(sessionState ?? {}, 50)
  const seen = new Set()
  const artifacts = []
  for (const row of rows) {
    const conversationId = String(row.conversation_id ?? '').trim()
    if (conversationId === '' || seen.has(conversationId)) continue
    seen.add(conversationId)
    const dir = brainDir(conversationId)
    for (const name of ARTIFACT_NAMES) {
      try {
        const info = await statFile(join(dir, name))
        if (info === undefined) continue
        artifacts.push({
          sessionId: row.session_id ?? '?',
          conversationId,
          name,
          bytes: info.size,
          updatedAt: new Date(info.mtimeMs).toISOString(),
        })
      } catch {
        // A missing artifact is the normal case.
      }
    }
  }
  telemetry.setArtifacts(artifacts)
}

/** `stat` that resolves to undefined instead of throwing. */
async function statFile(path) {
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(path)
    return info.isFile() ? info : undefined
  } catch {
    return undefined
  }
}

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
    // UI-REQ-01 §2.3: the dashboard's address is part of the health report, so a
    // user can find the War Room without reading this plugin's source.
    renderDashboard(uiStatus),
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
  //
  // v0.7.0: the dashboard's hot controls live in `runtimeOverride`, so this reads
  // the *effective* config — a mode pinned from the dashboard applies to the very
  // next turn without a reload.
  const live = effectiveConfig()
  const modeDecision = resolveTaskMode({
    task_mode: taskModeArg ?? (live.taskMode !== 'auto' ? live.taskMode : undefined),
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
  // Handed to the dashboard's `/api/control/abort` route, which must cancel the
  // same server this turn is talking to.
  lastLiveServer = () => server

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
        publishQuota(read.quota)
        const decision = applyQuotaFallback(desiredTier, read.quota, cfg)
        tier = decision.tier
        downgraded = decision.downgraded
        quotaNote = decision.note
        // UI-REQ-02: the top bar's "low quota protection active" badge.
        telemetry.setActiveFallback(decision.downgraded !== undefined)
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
  //
  // v0.7.0 / UI-REQ-04: the same wait reports its planned delay to the dashboard
  // (`onStart`), so the pacing stage shows a live countdown and the "skip this
  // cooldown" button has something to skip. The pacer owns the cancellable timer
  // and `pacer.skip()` settles it from the control route.
  let paced
  try {
    paced = await pacer.waitForTurnStart(live, {
      onStart: (delayMs) => telemetry.setPhase('pacing', { pacingRemainingMs: delayMs }),
    })
    if (paced.skipped === true) {
      progressLog('[antigravity] 拟人冷却已由控制台手动跳过')
    } else if (paced.waitedMs > 0) {
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

    // --- v0.7.0 / UI-REQ-03: publish the turn before its first step ---------
    // The conversation id is only known now (a resumed turn reuses the stored
    // one, a fresh turn just got its id), and everything the dashboard's context
    // card shows — session, mode, requested vs effective tier, the downgrade
    // reason — is already decided. Publishing here means the War Room is
    // populated before the first tool call instead of after the last one.
    const turn = telemetry.startTurn({
      sessionId,
      conversationId,
      workspaceDir: workspace,
      effectiveMode: mode,
      requestedTier: desiredTier,
      effectiveTier: tier,
      ...(downgraded === undefined ? {} : { downgradedReason: downgraded }),
      taskSpecHead: taskSpec,
      turnCount: nextTurnCount(record, conversationId),
      turnLimit: live.longSessionTurns,
    })
    liveTurn = turn
    telemetry.setWorkspaceDir(workspace)

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
      const stepStartedAt = Date.now()
      for (const hit of findHangingCommands(step)) {
        const token = `${step?.step_index}:${hit.index}`
        if (!hanging.has(token)) hanging.set(token, { ...hit, stepIndex: step?.step_index, seenAt: Date.now() })
      }

      if (auditor === undefined) {
        // v0.7.0: with auditing off there is still a timeline worth showing — it
        // just has no verdict to report, so every row is CLEAN by construction.
        publishStep(step, { status: 'clean', elapsedMs: Date.now() - stepStartedAt })
        return undefined
      }

      const verdict = auditor.push(step)
      const destructive = verdict.blockedDestructive === true
      const escape = verdict.blockedEscape === true

      // --- v0.7.0 / UI-REQ-03: the verdict pill for this row -----------------
      // The streaming auditor already computes exactly what the timeline draws:
      // which finding fired, where the virtual cwd ended up, and whether the
      // path was outside the workspace. Re-deriving any of that in the browser
      // would duplicate the state machine (and drift from it), so the verdict is
      // projected here and the page only styles it.
      publishStep(step, {
        status: destructive ? 'destructive' : escape ? 'escape' : 'clean',
        ...(verdict.violations.length === 0
          ? {}
          : {
              kind: verdict.violations.map((v) => String(v.kind ?? '')).filter(Boolean).join('; '),
            }),
        elapsedMs: Date.now() - stepStartedAt,
        virtualCwd: auditor.cwd,
        isOutsideWorkspace: escape,
      })

      if ((destructive && breakOnDestructive) || (escape && breakOnEscape)) {
        const findings = verdict.violations.filter((v) => {
          const kind = classifyFinding(v.kind)
          return (kind === 'destructive' && breakOnDestructive) || (kind === 'escape' && breakOnEscape)
        })
        const label = destructive ? '高危破坏性命令' : '工作区越界'
        const reason =
          `事中熔断（${label}）：` +
          findings
            .map((v) => `${v.kind}${v.path ? ` ${v.path}` : ''}`)
            .join('; ')
        // The dashboard marks this row red the moment the breaker fires; the
        // cancel latency is filled in by the settlement path below.
        telemetry.abortTurn(turn.turnId, {
          trigger: destructive ? 'auto_destructive' : 'auto_escape',
          reason,
          stepIndex: Number(step?.step_index),
        })
        return { block: true, reason }
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

    // --- v0.7.0 / UI-REQ-04: tell the dashboard what cut this turn ----------
    // A kill that did not come from the dashboard still has to appear as one:
    // the hanging-command timer and a caller-side abort both land here, and a
    // timeline that silently shows "settled" would read as a clean finish.
    if (killed !== undefined) {
      telemetry.abortTurn(turn.turnId, {
        trigger: String(killed.reason ?? '').includes('hanging') ? 'auto_hanging' : 'auto_destructive',
        reason: String(killed.reason ?? '熔断器已触发'),
        stepIndex: Number(killed.step?.step_index ?? killed.step),
      })
    }

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

    // --- v0.7.0 / UI-REQ-05: flush the settled turn into the ring buffer ----
    // Done deliberately *after* the session write so `sessions:updated` and
    // `turn:settled` reach the page in the order they logically happened, and
    // so the replayer's turn count matches the persisted one.
    telemetry.settleTurn(turn.turnId, {
      status: killed !== undefined ? 'aborted' : 'ok',
      durationMs: Date.now() - started,
      finalReportHead: answer.trim() || out.join('\n').slice(0, 1200),
      gitSummary: gitBlock ?? null,
      artifacts: artifacts.map((artifact) => ({
        name: artifact.name,
        bytes: artifact.bytes,
        updatedAt: artifact.updatedAt,
        path: artifact.path,
      })),
      sessionRecreated: evicted !== undefined,
      turnCount: nextTurnCount(store[key] ?? record, conversationId),
    })
    publishCollectionState(store)

    return out.join('\n')
  } catch (error) {
    // The dashboard must show a failed turn as failed, not as a turn that never
    // happened: a page left on a stale "running" badge is worse than an error.
    if (liveTurn !== undefined) {
      telemetry.settleTurn(liveTurn.turnId, {
        status: String(error?.message ?? '').includes('取消') ? 'aborted' : 'failed',
        durationMs: Date.now() - started,
        finalReportHead: String(error?.message ?? error),
        turnCount: nextTurnCount(record, conversationId),
      })
      liveTurn = undefined
    }
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
    // The dashboard's live-turn pointer is per-call state, not per-plugin state.
    liveTurn = undefined
  }
}

// ---------------------------------------------------------------------------
// v0.7.0 / UI-REQ-01..05: dashboard control surface
// ---------------------------------------------------------------------------

/** The Language Server handle the control routes may cancel against. */
let lastLiveServer

/** `getServer()` memoised for the abort route; never blocks. */
function liveServer() {
  return lastLiveServer?.() ?? null
}

/**
 * Fields the dashboard may change at runtime, with their validators.
 *
 * WHY A WHITELIST
 * ---------------
 * `/api/control/config` is reachable from any page on the loopback interface.
 * Accepting arbitrary keys would let that page set `allowOutsideWorkspace` *or*
 * quietly rewrite `maxSeconds` to a value the user never chose — and a config
 * object that grows a field here must be a conscious decision, not a side effect
 * of spreading the request body into `cfg`.
 */
const RUNTIME_FIELDS = Object.freeze({
  thinkingLevel: (value) =>
    THINKING_LEVELS.includes(String(value)) ? String(value) : undefined,
  taskMode: (value) =>
    ['auto', 'surgical', 'creative'].includes(String(value)) ? String(value) : undefined,
  failOnEscape: (value) => (typeof value === 'boolean' ? value : undefined),
  realtimeKillSwitch: (value) => (typeof value === 'boolean' ? value : undefined),
  allowOutsideWorkspace: (value) => (typeof value === 'boolean' ? value : undefined),
  audit: (value) => (typeof value === 'boolean' ? value : undefined),
})

/**
 * Apply a runtime config patch from the dashboard (UI-REQ-04).
 *
 * Changes are kept in `runtimeOverride` and apply to the *next* turn; nothing is
 * written to `cordis.patch.yml`. A rejected field throws so the page can roll
 * its toggle back instead of showing a state the executor never accepted.
 *
 * @param {object} patch requested fields (`pacingEnabled` folds into `pacing.enabled`)
 * @returns {Promise<object>} the new effective runtime config
 */
async function applyRuntimeConfig(patch = {}) {
  const next = { ...runtimeOverride }
  const applied = []

  for (const [key, validator] of Object.entries(RUNTIME_FIELDS)) {
    if (!(key in patch)) continue
    const value = validator(patch[key])
    if (value === undefined) {
      throw new Error(`字段 ${key} 的取值非法：${JSON.stringify(patch[key])}`)
    }
    next[key] = value
    applied.push(key)
  }

  if ('pacingEnabled' in patch) {
    if (typeof patch.pacingEnabled !== 'boolean') {
      throw new Error('pacingEnabled 必须是布尔值')
    }
    next.pacing = { ...(next.pacing ?? {}), enabled: patch.pacingEnabled }
    applied.push('pacingEnabled')
  }

  if (applied.length === 0) {
    throw new Error(`没有可热更新的字段：${Object.keys(patch).join(', ') || '(空请求)'}`)
  }

  runtimeOverride = next
  const effective = effectiveConfig()
  const published = telemetry.setRuntimeConfig(effective)
  progressLog(`[antigravity] 运行时策略已热更新：${applied.join(', ')}`)
  return published
}

/**
 * Evict one `session_id` so its next delegation opens a fresh conversation.
 *
 * Every workspace-qualified record with that session id is dropped: the id is
 * what the user sees and clicks, and leaving a record for another workspace
 * behind would make "驱逐重置" silently ineffective on the next call.
 *
 * @param {string} sessionId
 * @returns {Promise<{evicted: number}>}
 */
async function evictSession(sessionId) {
  const store = await state()
  const wanted = String(sessionId)
  let evicted = 0
  for (const [key, record] of Object.entries(store)) {
    if (record?.session_id !== wanted) continue
    delete store[key]
    evicted += 1
  }
  if (evicted > 0) await persist(store)
  publishCollectionState(store)
  progressLog(`[antigravity] 已驱逐会话 ${wanted}（${evicted} 条映射）`)
  return { evicted }
}

/**
 * Probe the desktop bridge and publish the result.
 *
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<object>} the published bridge status
 */
async function probeBridge({ refresh = false } = {}) {
  try {
    const server = await discoverLanguageServer({ refresh })
    const status = telemetry.setBridge({
      online: true,
      pid: server.pid,
      port: server.port,
    })
    // The plan/e-mail only come from a quota read, which is the expensive half;
    // do it best-effort so a healthy bridge is never reported as offline just
    // because the account endpoint hiccuped.
    try {
      const quota = await readQuota(server)
      if (quota.plan !== undefined || quota.email !== undefined) {
        telemetry.setBridge({ ...status, plan: quota.plan, email: quota.email })
      }
      publishQuota(quota)
    } catch {
      // Quota is decorative here; the bridge itself is up.
    }
    return telemetry.snapshot().bridge
  } catch (error) {
    return telemetry.setBridge({ online: false, error: error?.message ?? String(error) })
  }
}

/**
 * Read one brain artifact for the drawer (UI-REQ-05).
 *
 * @param {string} conversationId
 * @param {string} file already validated by the route's filename pattern
 * @returns {Promise<string|null>}
 */
async function readBrainArtifact(conversationId, file) {
  const target = join(brainDir(conversationId), file)
  try {
    const text = await readFile(target, 'utf8')
    // The drawer renders markdown; a 4 MiB file would freeze the tab.
    return text.length > 4 * 1024 * 1024 ? `${text.slice(0, 4 * 1024 * 1024)}\n\n…（已截断）` : text
  } catch {
    return null
  }
}

/**
 * Render the dashboard's status as one `check_environment` line (UI-REQ-01 §2.3).
 *
 * The PRD asks for `dashboard : http://127.0.0.1:18420 (online)`, with the real
 * port when it had to step forward. A disabled or failed server says so plainly
 * instead of printing a URL nobody is listening on.
 *
 * @param {object} status the module-level `uiStatus`
 * @returns {string}
 */
export function renderDashboard(status = {}) {
  if (status.disabled === true) return 'dashboard    : off (config ui.enabled=false)'
  if (status.online !== true) {
    return `dashboard    : unavailable${status.error === undefined ? '' : ` (${status.error})`}`
  }
  const connected = typeof uiServer?.clients === 'number' ? uiServer.clients : 0
  return `dashboard    : ${status.url} (online, ${connected} client${connected === 1 ? '' : 's'})`
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
    ui: { ...DEFAULT_CONFIG.ui, ...(config?.ui ?? {}) },
  }
  // A fresh activation starts from the file's declared values; a hot reload must
  // not silently carry over tuning the user did in a previous server session.
  runtimeOverride = {}

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

  // --- v0.7.0 / UI-REQ-01: bring the dashboard up and tear it down properly ---
  // REGISTERED WITH `ctx.effect` ON PURPOSE. Cordis runs the returned disposer on
  // unload and on every HMR reload; that disposer is what ends the SSE streams
  // and frees port 18420, without which the reload would die on EADDRINUSE. The
  // effect is also why an `enabled: false` profile binds nothing at all.
  ctx.effect(() => {
    let disposed = false
    telemetry.setRuntimeConfig(effectiveConfig())
    publishCollectionState()

    if (cfg.ui.enabled !== true) {
      uiStatus = { online: false, disabled: true }
      return () => {}
    }

    // Seed the dashboard instead of leaving it on "Disconnected" until someone
    // clicks Rescan: the very first thing a user sees should be the real bridge
    // state, not an empty shell that looks like a broken plugin.
    //
    // Deliberately deferred and single-shot:
    //   - `apply()` must return fast (the web boot barrier samples fiber state), and
    //     discovery can take a second or two on a cold Language Server;
    //   - the probe reads the account quota, so it must never become a timer that
    //     keeps hitting the endpoint in the background;
    //   - a failure is silence, not an error: a closed Antigravity desktop is a
    //     perfectly normal state, and `setBridge({online:false,...})` already says so.
    const seedTimer = setTimeout(() => {
      if (disposed) return
      probeBridge({ refresh: false }).catch(() => {})
    }, 800)
    if (typeof seedTimer.unref === 'function') seedTimer.unref()

    startUiServer({
      bus: telemetry,
      host: cfg.ui.host,
      port: cfg.ui.port,
      log: progressLog,
      getControlServer: () => liveServer(),
      applyConfig: (patch) => applyRuntimeConfig(patch),
      evictSession: (sid) => evictSession(sid),
      listSessions: async () => projectSessions(),
      listArtifacts: async () => telemetry.snapshot().artifacts,
      skipPacing: () => pacer.skip(),
    })
      .then((handle) => {
        if (disposed === true) {
          // The plugin was unloaded while the listener was still binding: close
          // it immediately rather than leaking a port for the next reload.
          return handle.close().then(() => undefined)
        }
        uiServer = handle
        uiStatus = { online: true, url: handle.url, port: handle.port }
        handle.setAbortHooks({
          conversationId: () => {
            const snapshot = telemetry.snapshot()
            return snapshot.activeTurn?.conversationId ?? null
          },
          cancel: async (server, conversationId) => {
            const { rpcCall } = await import('./rpc.js')
            await rpcCall(server, 'CancelCascadeInvocation', { cascadeId: conversationId }, {
              timeoutMs: 10_000,
            })
          },
        })
        handle.setRescan(async () => {
          invalidateDiscovery()
          return probeBridge({ refresh: true })
        })
        handle.setArtifactReader(readBrainArtifact)
        progressLog(
          `[antigravity] 可视化控制台已就绪：${handle.url}` +
            (handle.note === null ? '' : `（${handle.note}）`),
        )
        return undefined
      })
      .catch((error) => {
        uiStatus = { online: false, error: error?.message ?? String(error) }
        progressLog(`[antigravity] 可视化控制台启动失败：${uiStatus.error}`)
      })

    return () => {
      disposed = true
      clearTimeout(seedTimer)
      const handle = uiServer
      uiServer = undefined
      uiStatus = { online: false }
      if (handle !== undefined) {
        handle.close().catch(() => {})
      }
    }
  }, 'antigravity-executor: ui server')

  // --- v0.7.0: the same-origin route the dsh panel talks to -----------------
  // The dashboard binds its own loopback port and the Web GUI has a different
  // origin, so a page inside the GUI cannot reach it directly (and the control
  // routes refuse foreign Origins on purpose). This registers a same-origin
  // prefix that streams straight through to the listener, which keeps the
  // standalone surface exactly as locked down as before while making the
  // in-app panel CORS-free. `webServer` is optional: a headless profile has no
  // carrier, and the standalone dashboard still works without it.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const handler = createUiProxy({
        target: () => (uiStatus.online === true && typeof uiStatus.url === 'string' ? uiStatus.url : null),
      })
      return webCtx.webServer.register({
        kind: 'prefix',
        path: UI_PROXY_PREFIX,
        handler: (req, res) => {
          handler(req, res)
        },
      })
    }, 'antigravity-executor: dashboard proxy route')
  })

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
