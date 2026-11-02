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
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative as relativePath, resolve } from 'node:path'
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
  projectSessionRow,
  rolloverSessionPatch,
} from './sessions.js'
import {
  creativePreamble,
  creativeReviewGate,
  // `documentPreamble()` already embeds the structure-summary requirement, so
  // `documentStructurePrompt()` is not imported separately: calling both would
  // inject the same instruction twice into the same prompt.
  documentPreamble,
  documentReviewGate,
  renderTaskMode,
  resolveTaskMode,
} from './task-mode.js'
import {
  extractRunCommands,
  renderCommandSummary,
  summarizeCommands,
  verificationWarning,
} from './commands.js'
import { renderEscalation, shouldEscalate } from './escalation.js'
import { buildRolloverBrief, isLongSession, renderRolloverPrompt } from './session-brief.js'
import {
  capturePreTurnSnapshot,
  renderRollback,
  renderSnapshot,
  rollbackTurn,
} from './snapshot.js'
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

/**
 * Rollover briefs waiting to ride on the next prompt (v0.8.0 / REQ-04).
 *
 * Keyed by the same `workspace::sessionId` composite the session store uses, and
 * consumed exactly once. Deliberately in-memory rather than persisted: the very
 * next delegation on that session is by definition the one that needs the brief,
 * and a brief that outlived a dsh restart would be describing a project state the
 * planner has already moved past. Keeping it out of the session record also means
 * `sessions.js` needs no "pending" key, so v0.7.0 records keep round-tripping
 * byte-identically.
 */
const pendingRollovers = new Map()

/** Per-session cumulative burn, so the session list can show `-5.4%` (UI-REQ-04). */
const sessionBurn = new Map()

/**
 * Snapshot + workspace per live/settled turn, so the rollback route can find what
 * to restore (v0.8.0 / REQ-03). The snapshot is a small plain object; keeping it
 * beside the turn id (rather than inside the telemetry snapshot, which is
 * serialised to the browser) avoids shipping an internal git sha to the page.
 */
const turnSnapshot = new Map()

/**
 * How many turns keep a restorable snapshot.
 *
 * Matches the ring buffer's default depth so "a turn you can still see in the
 * dashboard is a turn you can still roll back" holds exactly. Without a cap this
 * map would grow for the life of the process, and each entry pins a git sha.
 */
const MAX_TRACKED_SNAPSHOTS = 20

/** Record a turn's snapshot, evicting the oldest beyond the cap. */
function rememberTurnSnapshot(turnId, entry) {
  turnSnapshot.set(String(turnId), entry)
  while (turnSnapshot.size > MAX_TRACKED_SNAPSHOTS) {
    const oldest = turnSnapshot.keys().next()
    if (oldest.done === true) break
    turnSnapshot.delete(oldest.value)
  }
}

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
  // v0.8.0: the projection lives in sessions.js so the wire shape cannot drift
  // from the record shape. It adds taskMode / lastTurnFailed / burnCumulative /
  // cumulativeTurnCount, which the session list needs for the sticky-mode badge,
  // the retry-escalation hint and the `累计消耗: -5.4%` line (UI-REQ-04).
  return rows.map((row) => projectSessionRow(row, { longSessionTurns: limit }))
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

// ---------------------------------------------------------------------------
// v0.8.0: report helpers for the Universal Inspector (UI-REQ-01)
// ---------------------------------------------------------------------------

/**
 * Files this turn touched, as workspace-relative paths, for the rollback route.
 *
 * WHY NOT JUST PASS `gitSummary.changed`
 * --------------------------------------
 * `checkout <sha> -- .` restores the WHOLE tree, which reaches much further than
 * the turn did: an unrelated file the user had been editing gets reverted too.
 * Narrowing the restore to the files this turn actually wrote is what makes the
 * button safe to click on a dirty worktree. When the per-file list is unavailable
 * the caller falls back to the whole-tree form, which still never deletes a file
 * that predates the turn.
 *
 * @param {{status?: string}|undefined} gitSummary result of `readGitSummary`
 * @param {string} workspace absolute workspace root
 * @returns {string[]} relative, slash-separated paths
 */
function changedFilesForRollback(gitSummary, workspace) {
  const status = String(gitSummary?.status ?? '')
  const files = []
  for (const line of status.split(/\r?\n/)) {
    // Porcelain v1: `XY <path>`; a rename/copy is `XY <old> -> <new>`.
    const match = /^(.{2})\s+(.+)$/.exec(line)
    if (match === null) continue
    const code = match[1]
    // `??` is untracked: the snapshot does not contain it, so checking it out
    // would fail; the rollback path removes it instead (and only if it is new).
    if (code === '??') continue
    let path = match[2].trim()
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4).trim()
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    const absolute = resolve(workspace, path)
    // Never hand a path outside the workspace to `git checkout`.
    if (!isInside(workspace, absolute)) continue
    files.push(absolute.replace(/\\/g, '/'))
  }
  return [...new Set(files)]
}

/**
 * Per-file `+added / -removed` counts for the Diff tab's file pills.
 *
 * Uses `git diff --numstat`, whose output is already the two numbers the UI
 * draws (`42\t8\tpath`). Binary files print `-` for both counts and are reported
 * as zeros with a `binary` marker rather than as `NaN`.
 *
 * @param {string} workspace absolute workspace root
 * @returns {Promise<Array<{path: string, added: number, removed: number, binary?: boolean}>>}
 */
async function diffStatPerFile(workspace) {
  const result = await run('git', ['-C', workspace, 'diff', '--numstat'], {
    timeout: 3000,
  }).catch(() => undefined)
  if (result === undefined || result.code !== 0) return []
  const rows = []
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (match === null) continue
    const binary = match[1] === '-' || match[2] === '-'
    rows.push({
      path: match[3].trim(),
      added: binary ? 0 : Number(match[1]),
      removed: binary ? 0 : Number(match[2]),
      ...(binary ? { binary: true } : {}),
    })
  }
  return rows
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
  const document = mode === 'document'

  // The scope rule is the one line that has to flip with the persona: "do not
  // widen the scope" is precisely what turns a 3D scene into placeholder boxes,
  // and it is equally wrong for an office document, where the deliverable IS the
  // styling. v0.8.0 adds the third branch (REQ-05).
  const scopeRule = creative
    ? `${nextNote + 1}. 在任务规格给定的文件范围内工作，但**不要为了代码简洁而阉割视觉表现**：
   该有的几何体、材质、贴图、灯光、交互都要真的写出来，而不是留一个只有单个 primitive 的骨架。
   允许在规格描述的场景范围内自由发挥细节（道具、陈列、氛围、动画），
   但不要引入规格之外的构建系统、框架或新的运行时依赖。`
    : document
      ? `${nextNote + 1}. 严格按任务规格执行，不要擅自扩大范围去重构任务之外的模块。
   但**不要为了代码简洁而阉割文档的版式与结构**：该有的工作表、样式、层级、页眉页脚都要真的写出来。
   交付物是文档本身，版式就是验收对象，不是可有可无的装饰。`
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
${creative ? `\n${creativePreamble()}\n` : ''}${document ? `\n${documentPreamble()}\n` : ''}--- 任务规格（Task Spec）---
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
        ? 'auto-detected per call (creative for 3D/WebGL/Canvas/UI, ' +
          'document for xlsx/pptx/docx/pdf/csv, surgical otherwise) + session-sticky'
        : `pinned to ${cfg.taskMode} by config`
    }`,
    `session hint : suggest a new session_id after ${cfg.longSessionTurns} turns`,
    // --- v0.8.0 policy lines ---------------------------------------------
    `escalation   : ${
      cfg.autoEscalateOnRetry
        ? `flash -> ${cfg.retryEscalationLevel} (pro) on a rework round` +
          ` / a failed previous turn / creative mode; still bounded by the quota guard`
        : 'off (every turn uses the configured level)'
    }`,
    `pre-turn snap: ${
      cfg.preTurnGitSnapshot
        ? 'git stash create before each turn (zero side effects); rollback from the dashboard'
        : 'off (no rollback point is recorded)'
    }`,
    `rollover     : ${
      cfg.autoRolloverLongSessions
        ? `automatic after ${cfg.longSessionTurns} turns (memory brief carried over)`
        : `manual (UI button or POST /api/sessions/rollover) after ${cfg.longSessionTurns} turns`
    }`,
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

  // Workspace: explicit argument > the dsh session cwd.
  const placement = resolveWorkspace(workspaceDir, ctx, exec)
  if (placement.error !== undefined) return placement.error
  const workspace = placement.workspace

  if (!isDirectory(workspace)) {
    return `[error] workspace 不是已存在的目录：${workspace}`
  }

  // v0.8.0 / REQ-05 / REQ-01: the session record is read BEFORE the mode and the
  // level are decided, because both now depend on what previous turns established.
  //
  //   - mode stickiness: a resumed session inherits the mode it chose on turn 1.
  //     Without it, a multi-turn 3D build whose later instructions read like plain
  //     engineering ("现在把地板换成瓷砖") silently degrades creative -> surgical
  //     mid-flight — the exact regression REQ-05 exists to stop.
  //   - escalation: `last_turn_failed` is the retry signal, so the record has to
  //     be in hand before the tier is chosen.
  const store = await state()
  const key = sessionKey(workspace, sessionId)
  const record = store[key] ?? {}

  const modeDecision = resolveTaskMode({
    task_mode: taskModeArg ?? (live.taskMode !== 'auto' ? live.taskMode : undefined),
    task_spec: taskSpec,
    sessionTaskMode: record.task_mode,
  })
  const mode = modeDecision.mode

  // Thinking level: explicit call argument > configured default.
  const level = resolveThinking(thinking)
  if (level.error !== undefined) return level.error
  let desiredTier = THINKING_TIERS[level.level]

  // --- v0.8.0 / REQ-01: retry & complexity auto-escalation -----------------
  // Computed BEFORE the quota guard below, and the two stay orthogonal on purpose:
  // escalation says "this looks hard, spend more"; the quota guard says "the
  // account cannot afford it". Running escalation second would let it silently
  // overwrite a downgrade that was protecting the weekly reserve — exactly the
  // "burn the last 5%" failure the quota guard exists to prevent. Quota wins.
  const escalation = shouldEscalate({
    // Only an explicit call argument suppresses escalation; the config default is
    // what the feature is allowed to raise.
    explicitLevel: level.source === 'call' ? level.level : undefined,
    configuredLevel: live.thinkingLevel,
    effectiveMode: mode,
    // The escalation module reads camelCase; a persisted record is snake_case.
    session: { ...record, lastTurnFailed: record.last_turn_failed === true },
    taskSpec,
    config: {
      autoEscalateOnRetry: live.autoEscalateOnRetry,
      retryEscalationLevel: live.retryEscalationLevel,
    },
  })
  if (escalation.escalate === true) {
    desiredTier = THINKING_TIERS[escalation.to] ?? desiredTier
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
  /**
   * v0.8.0 / UI-REQ-04: the 5h fraction observed at turn start, so the settled
   * card can show `🔋 本轮消耗: -1.3%`. Deliberately the 5h bucket rather than
   * the weekly one: a single turn's burn is measurable against the short window
   * and noise against the weekly pool.
   */
  let burnBefore
  if (cfg.quotaFallback.enabled) {
    try {
      // v0.5.0: reuse a recent read (unless the value is near the guard, where a
      // stale fraction is exactly what would be dangerous).
      const read = await quotaCache.read(server, cfg)
      quotaCached = read.cached
      if (read.quota !== undefined) {
        publishQuota(read.quota)
        const billing = pickBillingBuckets(read.quota)
        burnBefore = Number(billing.fiveHour?.remainingFraction)
        if (!Number.isFinite(burnBefore)) burnBefore = undefined
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

  // --- v0.8.0 / REQ-03: zero-side-effect pre-turn git snapshot --------------
  // Taken here — after the workspace is resolved, before the turn writes anything,
  // and before the pacing wait so the snapshot reflects the state the user
  // intended to start from rather than a state some other process moved on.
  //
  // `git stash create` is the whole trick: it writes a dangling tree object into
  // `.git/objects` and nothing else. It does not touch the working tree, the
  // index, or `stash list`, so running it on every turn costs ~30ms and cannot
  // surprise the user by "stashing their work". A non-repo workspace degrades to
  // `{isRepo:false}` and the rollback button simply never appears.
  let snapshot
  if (live.preTurnGitSnapshot === true) {
    try {
      snapshot = await capturePreTurnSnapshot(workspace)
    } catch {
      // The snapshot is a safety net, not a precondition: a filesystem or git
      // failure must never block a delegation that would otherwise run.
      snapshot = undefined
    }
  }

  const basePrompt = buildPrompt(workspace, taskSpec, { mode })

  // --- v0.8.0 / REQ-04: the rollover brief rides on the FIRST prompt --------
  // A long session that was rolled over keeps its memory as a prompt header: the
  // fresh Antigravity conversation has no history, so without this it would spend
  // a dozen read_file calls rediscovering a project the previous thread already
  // knew.
  //
  // The brief is consumed exactly once, via an in-memory pending set rather than a
  // persisted "pending" flag. Two reasons: the very next delegation is by
  // definition the one that needs it (a rollout that has not been used yet cannot
  // survive a dsh restart in any useful sense — the planner's next message will
  // have moved on), and keeping it out of the record means `sessions.js` needs no
  // new key and v0.7.0 records still round-trip byte-identically.
  const rolloverHead = pendingRollovers.get(key)
  if (rolloverHead !== undefined) pendingRollovers.delete(key)
  const prompt = rolloverHead === undefined ? basePrompt : `${rolloverHead}\n\n${basePrompt}`

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
      // v0.8.0: the dashboard's "why is this turn on pro?" answer, the rollback
      // button's precondition, and the rollover badge's evidence.
      ...(escalation.escalate === true
        ? { escalation: { from: escalation.from, to: escalation.to, reason: escalation.reason } }
        : {}),
      ...(snapshot?.isRepo === true && snapshot.snapshotSha !== null
        ? { snapshotSha: snapshot.snapshotSha }
        : {}),
      ...(rolloverHead === undefined
        ? {}
        : {
            rolloverBrief: {
              previousTurnCount: Number(record.rollover_brief?.previous_turn_count) || 0,
              files: Array.isArray(record.rollover_brief?.cumulative_touched_files)
                ? record.rollover_brief.cumulative_touched_files.slice(0, 15)
                : [],
            },
          }),
    })
    liveTurn = turn
    rememberTurnSnapshot(turn.turnId, { snapshot, workspace })
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

    // --- v0.8.0 / UI-REQ-04: burn delta ------------------------------------
    // Re-read the quota after the turn and diff it against the value captured at
    // turn start. A negative-or-zero delta is reported as "no measurable burn"
    // rather than as a gain: a quota read that crossed a window reset, or a cached
    // read, would otherwise show a turn that *added* quota.
    let burnDelta
    if (burnBefore !== undefined) {
      try {
        const after = await readQuota(server, { timeoutMs: 8000 })
        publishQuota(after)
        const billing = pickBillingBuckets(after)
        const burnAfter = Number(billing.fiveHour?.remainingFraction)
        if (Number.isFinite(burnAfter)) {
          const delta = burnBefore - burnAfter
          if (delta > 0) burnDelta = Number(delta.toFixed(4))
        }
      } catch {
        // A post-turn quota read is advisory: never fail a finished delegation.
      }
    }
    if (burnDelta !== undefined) {
      const prior = sessionBurn.get(key) ?? 0
      const cumulative = Number((prior + burnDelta).toFixed(4))
      sessionBurn.set(key, cumulative)
      try {
        telemetry.recordBurn({ deltaFraction: burnDelta, cumulativeFraction: cumulative, window: '5h' })
      } catch {
        // Observational only.
      }
    }

    // --- v0.8.0: files the Universal Inspector's Diff tab lists -------------
    // `changedFiles` drives the file pills (path + added/removed); `touchedFiles`
    // is the precise rollback input, so a rollback only restores what this turn
    // actually wrote instead of checking out the whole tree.
    const touchedFiles = changedFilesForRollback(gitSummary, workspace)
    const changedFiles = await diffStatPerFile(workspace)

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

    // --- v0.8.0 / REQ-02: command execution results ------------------------
    // The single most expensive blind spot before this: the report listed which
    // commands ran but never whether they SUCCEEDED, so a delegation whose test
    // run failed still came back reading like a clean finish. Both halves matter —
    // the structured rows let the planner see `Exit 1`, and `verificationWarning`
    // is the hard "do not accept this" banner for the case where the executor
    // reports success anyway.
    //
    // Read from the anti-truncated transcript (not the streaming steps) so resumed
    // turns and steps that flushed after settlement are both covered.
    const commands = extractRunCommands(transcript.steps)
    const commandSummary = summarizeCommands(commands)
    const warning = verificationWarning(commands)

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
      // v0.8.0 / REQ-01: kept on its OWN line next to the downgrade line, never
      // merged with it. "escalated to pro, then downgraded back to flash by the
      // quota guard" is the one state a user most needs to see spelled out.
      ...(escalation.escalate === true ? [renderEscalation(escalation)] : []),
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

    // --- v0.8.0 / REQ-02: the fake-success interlock -----------------------
    // Placed immediately after the header/status block and BEFORE the executor's
    // own message, because the whole point is that a reader who stops after the
    // first screenful must already know the verification failed. The executor's
    // confident prose comes later and cannot undo it.
    if (warning !== undefined) out.push('', warning)

    // --- v0.8.0 / REQ-02: the structured per-command table -----------------
    const commandBlock = renderCommandSummary(commands)
    if (commandBlock !== undefined) out.push('', commandBlock)

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

    // --- v0.8.0 / REQ-03: the rollback point this turn recorded -------------
    // Stated in the report for one reason: a user who is about to hand-fix a bad
    // turn should know in advance whether the one-click rollback is available
    // (it is not, in a non-git workspace) instead of discovering that after the
    // fact. `renderSnapshot` renders nothing for a non-repo workspace.
    const snapshotBlock = renderSnapshot(snapshot)
    if (snapshotBlock !== undefined) out.push('', snapshotBlock)

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
    // `isLongSession` is the single source of truth for the watermark, so the
    // report and the session list can never disagree about when a session counts
    // as long.
    if (
      isLongSession(
        { turn_count: Number(turns) + (resumed ? 1 : 0) },
        { longSessionTurns: cfg.longSessionTurns },
      )
    ) {
      const hint = longSessionHint(
        { turn_count: Number(turns) + (resumed ? 1 : 0) },
        cfg.longSessionTurns,
      )
      if (hint !== undefined) out.push('', hint)

      // --- v0.8.0 / REQ-04: offer the memory-preserving rollover -----------
      // `longSessionHint` already says "换新 session_id"; what it could not say
      // is that a plain swap throws away everything the thread had learned. The
      // rollover is the alternative, so it is offered on the same line of sight
      // (and triggered by `autoRolloverLongSessions` or the dashboard button).
      out.push(
        '',
        '--- session rollover available ---',
        `  该会话已 ${Number(turns) + (resumed ? 1 : 0)} 轮，换新会话能显著降低单轮配额消耗。`,
        '  本插件支持「带记忆结转」：新底层会话会自动继承已改文件列表与进度摘要，',
        '  不需要重新全盘扫描项目。触发方式：War Room 会话卡片上的 [🔄 带记忆结转] 按钮，',
        '  或把配置 autoRolloverLongSessions 设为 true 由插件自动执行。',
        `  auto_rollover: ${cfg.autoRolloverLongSessions === true}`,
      )

      // --- v0.8.0 / REQ-04: automatic rollover, when the profile opts in ----
      // Deliberately last and deliberately off by default: a rollover swaps the
      // conversation mid-project, so the turn that finishes is the last one on the
      // old thread and the workspace state is the best it will ever be for
      // building a brief. Doing it here (rather than before the turn) means the
      // brief includes what THIS turn just changed.
      if (cfg.autoRolloverLongSessions === true && conversationId) {
        try {
          const rollover = await rolloverSession(sessionId)
          if (rollover.ok === true) {
            out.push(
              '',
              '--- session rolled over (auto) ---',
              `  新底层会话将在下一轮建立；已结转 ${rollover.cumulativeFiles.length} 个文件的记忆摘要。`,
            )
          }
        } catch (error) {
          out.push('', `[Notice: 自动结转失败（不影响本轮结果）：${error.message}]`)
        }
      }
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

    // --- v0.8.0 / REQ-05: the document gate --------------------------------
    // Unlike the creative gate this fires on EVERY document turn. The two guard
    // different things: the creative gate controls how much effort to invest (so
    // it must not nag after pass 1), while the document gate guards against a
    // missing proof. `git diff` is blind to layout changes inside an .xlsx, so
    // without the printed structure summary there is literally nothing to review
    // — and that blind spot does not close as the session gets longer.
    //
    // `hasSummary` scans the executor's own final message for the marker the
    // preamble asked it to print, so a compliant turn gets no gate at all.
    const documentGate = documentReviewGate({
      mode,
      turnCount: nextTurnCount(store[key] ?? record, conversationId),
      hasSummary: /\[DOCUMENT STRUCTURE SUMMARY\]/i.test(answer),
    })
    if (documentGate !== undefined) out.push('', documentGate)

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
        // --- v0.8.0 fields ---------------------------------------------
        // `taskMode` is what makes REQ-05's stickiness work on the NEXT call.
        // It is written from the RESOLVED mode, not the caller's argument, so a
        // turn whose mode was auto-detected still pins the session.
        taskMode: mode,
        // `lastTurnFailed` is the retry signal REQ-01 escalates on. It has to be
        // written on the success path too (as `false`), otherwise a session that
        // failed once would keep escalating forever: nothing would ever clear it.
        lastTurnFailed: false,
        ...(burnDelta === undefined ? {} : { burnCumulative: sessionBurn.get(key) ?? 0 }),
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
      // --- v0.8.0: everything the Universal Inspector renders without a second
      // round trip: the command table (Tab 2), the file list (Tab 1), the burn
      // delta badge and the rollback precondition.
      ...(commandBlock === undefined ? {} : { commands: commandSummary }),
      ...(changedFiles.length === 0 ? {} : { changedFiles }),
      ...(touchedFiles.length === 0 ? {} : { touchedFiles }),
      ...(burnDelta === undefined ? {} : { burn: { fraction: burnDelta, label: '5h' } }),
    })
    publishCollectionState(store)

    return out.join('\n')
  } catch (error) {
    // --- v0.8.0 / REQ-01: record the failure so the NEXT round escalates --
    // This is the whole input to the retry signal: a turn that was interrupted,
    // whose verification command exited non-zero, or that produced no files gets
    // `last_turn_failed: true`, and the next call on this session_id starts on
    // `pro` instead of repeating the same failure on `flash`.
    //
    // Written here (not only on the success path) because the escalating caller
    // is by definition the one that runs after an unsuccessful turn.
    try {
      const current = store[key] ?? {}
      store[key] = sessionStore.set(store, {
        sessionId,
        workspace,
        conversationId,
        tier,
        turns: nextTurnCount(current, conversationId),
        taskMode: mode,
        lastTurnFailed: true,
      })
      await persist(store)
    } catch {
      // Bookkeeping must never mask the original failure.
    }

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
      (conversationId ? `\nconversation: ${conversationId}` : '') +
      '\n提示：该会话已记录 last_turn_failed=true，下一轮会自动升档到 pro 攻坚（REQ-01）。'
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
 * Read the unified diff for one file (or the whole turn) — UI-REQ-01 Tab 1.
 *
 * WHY THE WHOLE ARM IS GUARDED HERE RATHER THAN IN THE SERVER
 * -----------------------------------------------------------
 * `ui-server.mjs` already refuses a path outside the workspace, but that guard
 * needs an *active* workspace, and the workspace of a historical turn is not
 * necessarily the one the bus currently points at. So the turn's own workspace is
 * recovered from the snapshot map and re-validated here: a diff must come from
 * the tree the turn actually ran in, never from "whatever workspace is current".
 *
 * The caller may also ask for no file at all, which is the "all changed files"
 * view; that is served from a single `git diff` rather than by concatenating
 * per-file diffs, because rename detection and binary markers only work on the
 * full run.
 *
 * @param {{turnId?: string, file?: string|null, relative?: string|null}} [options]
 * @returns {Promise<{file: string|null, diffText: string, stats: {added: number, removed: number}}>}
 */
async function readWorkspaceDiff({ turnId, file, relative } = {}) {
  const remembered = turnId === undefined ? undefined : turnSnapshot.get(String(turnId))
  const workspace = remembered?.workspace ?? telemetry.workspaceDir()
  if (typeof workspace !== 'string' || workspace === '') {
    throw new Error('当前没有可用的工作区，Diff 不可用')
  }
  // `file` arrives already resolved by the server guard; re-check it anyway so
  // this function is safe to call from anywhere.
  if (file !== null && file !== undefined && !isInside(workspace, resolve(file))) {
    throw new Error(`Diff 目标不在工作区内：${file}`)
  }

  const args = ['-C', workspace, 'diff', '--no-color']
  if (file !== null && file !== undefined) {
    // `git diff -- <path>` wants a path RELATIVE to the repository (or a
    // pathspec); handing it an absolute Windows path matches nothing and would
    // silently render an empty diff. Relativise against the workspace, and keep
    // the slash form so Git for Windows does not misread the backslashes as
    // escapes.
    const absolute = resolve(file)
    const rel = relativePath(workspace, absolute).replace(/\\/g, '/')
    args.push('--', rel === '' ? String(relative ?? '') : rel)
  }
  const result = await run('git', args, { timeout: 5000 })
  const diffText = result.code === 0 ? String(result.stdout ?? '') : String(result.stdout ?? '')
  if (result.code !== 0 && diffText === '') {
    throw new Error(String(result.stderr ?? '').trim() || 'git diff 执行失败')
  }

  let added = 0
  let removed = 0
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { file: relative ?? null, diffText, stats: { added, removed } }
}

/**
 * Restore a turn's files to the snapshot taken before it started (REQ-03).
 *
 * The precise file list is the whole point: a whole-tree checkout would also
 * revert edits the user made by hand on files this turn never touched, which on a
 * long-lived dirty worktree is a data-loss bug wearing a safety feature's clothes.
 *
 * @param {string|undefined} turnId defaults to the most recent turn
 * @returns {Promise<{ok: boolean, turnId: string, restoredFiles: string[],
 *                    removedUntracked: string[], skipped: string[], error?: string}>}
 */
async function rollbackTurnById(turnId) {
  const snapshotInfo = telemetry.snapshot()
  const target =
    turnId === undefined
      ? (snapshotInfo.recentTurns?.[0]?.turnId ?? undefined)
      : String(turnId)
  if (target === undefined) throw new Error('没有可回滚的回合')

  const remembered = turnSnapshot.get(target)
  if (remembered === undefined) {
    throw new Error(`回合 ${target} 没有盘前快照（可能已超出缓冲窗口，或快照功能已关闭）`)
  }
  const { snapshot: snap, workspace } = remembered
  if (snap === undefined || snap?.isRepo !== true) {
    return {
      ok: false,
      turnId: target,
      restoredFiles: [],
      removedUntracked: [],
      skipped: ['该回合的工作区不是 git 仓库，无法回滚'],
    }
  }

  const record = snapshotInfo.recentTurns?.find((row) => row.turnId === target)
  const touched = Array.isArray(record?.touchedFiles) ? record.touchedFiles : []

  const result = await rollbackTurn(workspace, snap, { touchedFiles: touched })
  // `marked` tells the caller whether the badge could actually be drawn. The
  // rollback itself can succeed while `markRolledBack` returns false (the turn
  // aged out of the ring buffer), and the page needs to distinguish "rolled back
  // and recorded" from "rolled back, but this turn is no longer in the list".
  let marked = false
  if (result.ok === true) {
    try {
      marked =
        telemetry.markRolledBack(target, {
          restoredFiles: result.restoredFiles,
          removedUntracked: result.removedUntracked,
        }) === true
    } catch {
      // The rollback already happened; failing to draw the badge must not undo it.
    }
    // `renderRollback` is the one canonical phrasing of what a rollback did, and
    // it is returned to the dashboard so the toast and the log say the same thing
    // instead of the page inventing its own sentence.
    const summary = renderRollback(result)
    progressLog(`[antigravity] ${summary}`)
    return { ...result, turnId: target, marked, summary }
  }
  return { ...result, turnId: target, marked }
}

/**
 * Roll a long session over with a memory brief (REQ-04).
 *
 * The sequence matters: build the brief from the record FIRST (it describes the
 * conversation being abandoned), then drop the mapping so the next delegation
 * opens a fresh conversation, then queue the brief so that very delegation
 * carries it. Dropping the mapping before building the brief would lose the
 * `last_touched_files` / `last_task_head` the brief is made of.
 *
 * @param {string} sessionId
 * @returns {Promise<{ok: boolean, sessionId: string, briefSummary: string,
 *                    previousConversationId: string|null, cumulativeFiles: string[]}>}
 */
async function rolloverSession(sessionId) {
  const wanted = String(sessionId ?? '').trim()
  if (wanted === '') throw new Error('sessionId 不能为空')

  const store = await state()
  const keys = Object.keys(store).filter((key) => store[key]?.session_id === wanted)
  if (keys.length === 0) {
    return { ok: false, error: `会话 ${wanted} 不存在`, sessionId: wanted }
  }

  let brief
  let briefSummary = ''
  let previousConversationId = null
  let removed = 0
  for (const key of keys) {
    const record = store[key]
    const workspace = record?.workspace_dir ?? ''
    // The plan head is preferred over `last_task_head` when a brain artifact is
    // readable, because task.md tracks the *remaining* work rather than the last
    // instruction, which is what the next planner actually needs.
    let planText
    const conversationId = String(record?.conversation_id ?? '')
    if (conversationId !== '') {
      try {
        const text = await readBrainArtifact(conversationId, 'task.md')
        if (typeof text === 'string' && text.trim() !== '') planText = text
      } catch {
        // A missing artifact simply falls back to `last_task_head`.
      }
    }
    const next = buildRolloverBrief(
      { ...record, workspace_dir: workspace },
      { planText },
    )
    if (brief === undefined) brief = next
    previousConversationId = previousConversationId ?? (record?.conversation_id ?? null)
    briefSummary = renderRolloverPrompt(next) ?? ''

    // Replace the conversation mapping with a fresh one on the next delegation:
    // removing the record is exactly the "open a new conversation" signal the
    // dispatcher already understands (it is the same path a dead session takes).
    sessionStore.remove(store, workspace, wanted)
    removed += 1
    // Persist the brief into the surviving session row so the UI can show what
    // was carried over, and so a later rollover can merge onto it.
    store[sessionKey(workspace, wanted)] = sessionStore.set(store, {
      sessionId: wanted,
      workspace,
      ...rolloverSessionPatch(record, { brief: { ...next } }),
      conversationId: null,
    })
    pendingRollovers.set(sessionKey(workspace, wanted), briefSummary)
  }
  await persist(store)
  publishCollectionState(store)

  try {
    telemetry.markRolledOver(wanted, {
      toConversationId: null,
      brief: {
        previousTurnCount: Number(brief?.previousTurnCount) || 0,
        files: Array.isArray(brief?.cumulativeTouchedFiles) ? brief.cumulativeTouchedFiles : [],
      },
    })
  } catch {
    // Observational only.
  }
  progressLog(`[antigravity] 会话 ${wanted} 已带记忆结转（${removed} 条映射，累计 ${brief?.cumulativeTouchedFiles?.length ?? 0} 个文件）`)
  return {
    ok: true,
    sessionId: wanted,
    briefSummary,
    previousConversationId,
    cumulativeFiles: Array.isArray(brief?.cumulativeTouchedFiles) ? brief.cumulativeTouchedFiles : [],
  }
}

/**
 * Persist the dashboard's in-memory policy changes into `cordis.patch.yml`
 * (UI-REQ-04 §2).
 *
 * WHY THIS IS NOT JUST A FILE WRITE
 * ---------------------------------
 * `cordis.patch.yml` ships with the package and is the user's declaration; the
 * dashboard only holds an overlay. Writing the overlay back means editing YAML,
 * and a hand-rolled YAML rewriter that mangles an unrelated comment would be a
 * far worse bug than "the setting did not persist". So this updates ONLY the
 * keys the overlay actually contains, by rewriting those indented `key: value`
 * lines in place and leaving every other byte (including all comments) alone.
 *
 * @returns {Promise<{savedPath: string, applied: string[]}>}
 */
async function persistRuntimeConfig() {
  const applied = Object.keys(runtimeOverride)
  if (applied.length === 0) throw new Error('没有需要在内存中生效的策略改动')

  const file = join(PKG_DIR, 'cordis.patch.yml')
  const original = await readFile(file, 'utf8')
  let text = original
  const pending = { ...runtimeOverride }
  // `pacing` is nested; only its `enabled` flag is ever set by the dashboard.
  const pacingEnabled = pending.pacing?.enabled
  delete pending.pacing

  const wrote = []
  for (const [key, value] of Object.entries({ ...pending, ...(pacingEnabled === undefined ? {} : { pacing: { enabled: pacingEnabled } }) })) {
    if (key === 'pacing') continue
    const line = `${key}: ${formatYamlScalar(value)}`
    // Match an existing top-level key line at the config block's indentation and
    // replace only its value, keeping trailing comments.
    const pattern = new RegExp(`^(\\s+)${key}:(\\s*)([^#\\r\\n]*)(#.*)?$`, 'm')
    if (pattern.test(text)) {
      text = text.replace(pattern, (_m, indent, gap, _old, comment) => `${indent}${key}: ${formatYamlScalar(value)}${comment ?? ''}`)
      wrote.push(key)
    }
  }
  if (pacingEnabled !== undefined) {
    // `pacing.enabled` is the one nested key the UI toggles.
    const pattern = /^(\s+)enabled:(\s*)([^#\r\n]*)(#.*)?$/m
    const blockIndex = text.indexOf('pacing:')
    if (blockIndex !== -1) {
      const before = text.slice(0, blockIndex)
      const after = text.slice(blockIndex)
      const nextAfter = after.replace(pattern, (_m, indent, _gap, _old, comment) => `${indent}enabled: ${pacingEnabled === true}${comment ?? ''}`)
      text = before + nextAfter
      wrote.push('pacing.enabled')
    }
  }
  if (wrote.length === 0) throw new Error('未能在 cordis.patch.yml 中定位到对应策略键')

  await writeFile(file, text, 'utf8')
  progressLog(`[antigravity] 运行时策略已写回 ${file}：${wrote.join(', ')}`)
  return { savedPath: file, applied: wrote }
}

/** YAML scalar formatting for the values the dashboard can set. */
function formatYamlScalar(value) {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const text = String(value)
  // Quote only when the plain form would be ambiguous to a YAML reader.
  return /^[\w.\-/]+$/.test(text) ? text : JSON.stringify(text)
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
      // --- v0.8.0 control surface ---------------------------------------
      readDiff: (options) => readWorkspaceDiff(options),
      rollbackTurnFn: (turnId) => rollbackTurnById(turnId),
      rolloverSessionFn: (sessionId) => rolloverSession(sessionId),
      saveConfig: () => persistRuntimeConfig(),
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
