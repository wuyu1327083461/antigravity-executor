/**
 * `Config` — the Standard Schema the Cordis loader validates user config against.
 *
 * WHY HAND-ROLLED INSTEAD OF SCHEMASTRY
 * -------------------------------------
 * `cordis`'s `resolveConfig` only requires an object shaped like Standard Schema
 * v1:
 *
 *     if (!runtime.Config) return config
 *     const result = runtime.Config['~standard'].validate(config)
 *     if ('then' in result) throw new TypeError('Async config validation is not supported')
 *     if (result.issues) throw new ValidationError(result.issues)
 *     else return result.value
 *
 * That is the entire contract, so this module implements it directly. A plugin
 * that statically imports schemastery fails to load *entirely* when that package
 * is hoisted inconsistently — the whole plugin disappears over an optional
 * nicety. A zero-dependency validator cannot fail that way.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * Every key added in this iteration is optional and carries a default, so a
 * profile written against 0.3.0 keeps loading unchanged: the old keys keep their
 * old meanings and the new keys simply take their defaults.
 *
 * @module antigravity-executor/lib/config-schema
 */

/** Thinking levels, in ascending capability order. Keys are the tool enum. */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'extra_high']

/** agentapi exposes three tiers; the five friendly levels fold onto them. */
export const THINKING_TIERS = {
  minimal: 'flash_lite',
  low: 'flash_lite',
  medium: 'flash',
  high: 'pro',
  extra_high: 'pro',
}

/** Where the `thinkingLevel` config may sit relative to the dispatchable levels. */
export const DEFAULT_THINKING_LEVEL = 'medium'

/** The three tiers the Language Server actually accepts on `--model=`. */
export const TIERS = ['flash_lite', 'flash', 'pro']

/**
 * Field specs. `type` drives validation; `default` is applied whenever a key is
 * absent, null, or fails validation, so a bad value degrades to a working
 * default instead of making the whole plugin refuse to load.
 */
const FIELD_SPEC = Object.freeze({
  // --- core: unchanged since 0.1.0, kept byte-for-byte compatible ----------
  thinkingLevel: {
    type: 'string',
    enum: THINKING_LEVELS,
    default: DEFAULT_THINKING_LEVEL,
  },
  allowOverride: { type: 'boolean', default: true },
  followSessionWorkspace: { type: 'boolean', default: true },
  allowOutsideWorkspace: { type: 'boolean', default: false },
  audit: { type: 'boolean', default: true },
  failOnEscape: { type: 'boolean', default: false },
  maxSeconds: { type: 'number', default: 900, min: 1 },
  quietWindowSeconds: { type: 'number', default: 45, min: 5 },

  // --- REQ-01 / REQ-02: turn settlement and anti-truncation ----------------
  pollIntervalSeconds: { type: 'number', default: 2, min: 0.2 },
  fastSettleSeconds: { type: 'number', default: 2, min: 0 },
  useFullTranscript: { type: 'boolean', default: true },

  // --- REQ-04 / REQ-06 / REQ-07: safety, persistence, artifacts -----------
  realtimeKillSwitch: { type: 'boolean', default: true },
  persistSessions: { type: 'boolean', default: true },
  includeBrainArtifacts: { type: 'boolean', default: true },

  // --- v0.5.0: context budget, session hygiene, pacing ---------------------
  /**
   * Inline cap for one brain artifact (characters). A shorter `.md` is returned
   * verbatim; a longer one is headed and accompanied by its absolute path so the
   * planner can `read_file` the rest only when it actually needs it.
   */
  maxArtifactInlineChars: { type: 'number', default: 4000, min: 0 },
  /** How much of an oversized artifact is still inlined. */
  maxArtifactHeadChars: { type: 'number', default: 2000, min: 0 },
  /** Turn count at which the result suggests switching to a fresh session. */
  longSessionTurns: { type: 'number', default: 8, min: 1 },
  /** Kill the turn when a dev server / watch process is still running after this. */
  hangingCommandWarnSeconds: { type: 'number', default: 45, min: 0 },

  // --- v0.6.0: adaptive task mode, hanging-command cut, git snapshot --------
  /**
   * Which persona the executor prompt is built from (REQ-01).
   *
   * `auto` is the point of the feature: the mode is decided per call from the
   * task spec, so a user never edits a file when moving from "fix this bug" to
   * "build a 3D scene". `surgical` / `creative` pin it for a profile that only
   * ever does one kind of work.
   */
  taskMode: { type: 'string', enum: ['auto', 'surgical', 'creative'], default: 'auto' },
  /**
   * Cut a turn that is stuck on a command which will never exit (REQ-04).
   *
   * v0.5.1 could only *warn* after the fact, so a stray `npm run dev` burned the
   * whole `maxSeconds` budget and came back as a bare timeout. 0 disables the
   * cut and restores the old warn-only behaviour.
   */
  hangingCommandTimeoutSeconds: { type: 'number', default: 60, min: 0 },
  /**
   * Inline `git status --porcelain` + `git diff --stat` into the result (REQ-07).
   *
   * Saves the planner a whole extra tool round after every delegation, and the
   * empty-worktree check it enables is the only cheap way to catch an executor
   * that reports success without touching a file.
   */
  includeGitSummary: { type: 'boolean', default: true },
  /** Show the resolved task_mode in the report (observability only). */
  includeTaskModeHint: { type: 'boolean', default: true },
})

/**
 * Nested `quotaFallback` block (REQ-03). Kept separate from the flat specs so a
 * partial block (`{ enabled: false }` without `proMinFraction`) still validates
 * — the missing half takes its default instead of failing the whole row.
 */
const QUOTA_FALLBACK_SPEC = Object.freeze({
  enabled: { type: 'boolean', default: true },
  proMinFraction: { type: 'number', default: 0.05, min: 0, max: 1 },
  /**
   * Higher reserve for the weekly window (v0.5.0). A drained 5h window costs
   * hours; a drained weekly window can cost days, so it is guarded earlier.
   */
  weeklyProMinFraction: { type: 'number', default: 0.15, min: 0, max: 1 },
  /** Set false to keep only the 5h guard. */
  weeklyGuard: { type: 'boolean', default: true },
  /** Skip the weekly guard when the window resets within this many hours. */
  weeklyReserveHours: { type: 'number', default: 24, min: 0 },
  /** Reuse a quota read this long (seconds); 0 disables caching. */
  cacheTtlSeconds: { type: 'number', default: 180, min: 0 },
})

/**
 * Nested `pacing` block (v0.5.0): human-like spacing between delegations.
 *
 * The turn itself is never delayed — only the gap between two consecutive
 * `delegate_coding_task` calls is topped up, so a planner that re-dispatches a
 * second after the previous result does not produce a perfectly-spaced stream
 * of requests against a real signed-in account.
 */
const PACING_SPEC = Object.freeze({
  enabled: { type: 'boolean', default: true },
  minGapSeconds: { type: 'number', default: 15, min: 0 },
  jitterMinSeconds: { type: 'number', default: 6, min: 0 },
  jitterMaxSeconds: { type: 'number', default: 15, min: 0 },
})

/** The default config, exported so tests and tools can assert against it. */
export const DEFAULT_CONFIG = Object.freeze({
  ...Object.fromEntries(Object.entries(FIELD_SPEC).map(([key, spec]) => [key, spec.default])),
  quotaFallback: Object.freeze({
    ...Object.fromEntries(
      Object.entries(QUOTA_FALLBACK_SPEC).map(([key, spec]) => [key, spec.default]),
    ),
  }),
  pacing: Object.freeze({
    ...Object.fromEntries(Object.entries(PACING_SPEC).map(([key, spec]) => [key, spec.default])),
  }),
})

/** @returns {any} parsed value, appending an issue per problem. */
function parseField(value, spec, key, issues) {
  if (value === undefined || value === null) return spec.default

  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push({ message: `${key} must be a boolean`, path: [key] })
        return spec.default
      }
      return value
    case 'string':
      if (typeof value !== 'string') {
        issues.push({ message: `${key} must be a string`, path: [key] })
        return spec.default
      }
      if (spec.enum && !spec.enum.includes(value)) {
        issues.push({
          message: `${key} must be one of ${spec.enum.join(', ')} (got ${JSON.stringify(value)})`,
          path: [key],
        })
        return spec.default
      }
      return value
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ message: `${key} must be a finite number`, path: [key] })
        return spec.default
      }
      if (spec.min !== undefined && value < spec.min) {
        issues.push({ message: `${key} must be >= ${spec.min}`, path: [key] })
        return spec.default
      }
      if (spec.max !== undefined && value > spec.max) {
        issues.push({ message: `${key} must be <= ${spec.max}`, path: [key] })
        return spec.default
      }
      return value
    }
    default:
      return value
  }
}

/** Parse the nested `quotaFallback` block without letting a bad half kill the row. */
function parseQuotaFallback(value, issues) {
  const input = value && typeof value === 'object' ? value : {}
  const out = {}
  for (const [key, spec] of Object.entries(QUOTA_FALLBACK_SPEC)) {
    out[key] = parseField(input[key], spec, `quotaFallback.${key}`, issues)
  }
  return out
}

/** Parse the nested `pacing` block the same way. */
function parsePacing(value, issues) {
  const input = value && typeof value === 'object' ? value : {}
  const out = {}
  for (const [key, spec] of Object.entries(PACING_SPEC)) {
    out[key] = parseField(input[key], spec, `pacing.${key}`, issues)
  }
  // A minimum above the maximum would make the jitter negative; clamp instead of
  // rejecting, because a still-pacing delegation is better than a dead plugin.
  if (out.jitterMaxSeconds < out.jitterMinSeconds) out.jitterMaxSeconds = out.jitterMinSeconds
  return out
}

/**
 * The config schema handed to Cordis. Shaped as Standard Schema v1 so the
 * loader can validate it without any dependency of ours.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'antigravity-executor',
    /**
     * Synchronous validation. Unknown keys pass through untouched; a recognised
     * key of the wrong type produces `{issues}` and makes cordis refuse the row.
     */
    validate(value) {
      const input = value && typeof value === 'object' ? value : {}
      const issues = []
      const out = { ...input }
      for (const [key, spec] of Object.entries(FIELD_SPEC)) {
        out[key] = parseField(input[key], spec, key, issues)
      }
      out.quotaFallback = parseQuotaFallback(input.quotaFallback, issues)
      out.pacing = parsePacing(input.pacing, issues)
      return issues.length > 0 ? { issues } : { value: out }
    },
  }),
  /** Human-facing field metadata. */
  meta: Object.freeze({
    thinkingLevel: {
      description:
        '默认思考档位 (minimal|low|medium|high|extra_high)。工具调用未显式指定时用它。',
    },
    allowOverride: {
      description:
        '允许模型在单次 delegate_coding_task 调用里用 thinking_level 覆盖默认档位。',
    },
    followSessionWorkspace: {
      description:
        'true 时省略 workspace_dir 即采用当前 dsh 会话的工作目录；false 时必须显式传入。',
    },
    allowOutsideWorkspace: {
      description:
        '⚠️ 允许委派到 dsh 会话工作区之外的目录。默认 false（软沙箱只审计本会话工作区）。',
    },
    audit: { description: '委派结束后扫描 transcript，报告工作区越界与危险命令。' },
    failOnEscape: {
      description: '⚠️ 审计发现越界写入或危险命令时，把本次委派判为失败而非仅提示。',
    },
    maxSeconds: { description: '单次委派的默认墙钟时间（秒），调用参数可覆盖。' },
    quietWindowSeconds: {
      description:
        'RPC 状态不可用时判定一轮结束所需的 transcript 静默时长（秒）。仅在长轮询降级时生效。',
    },
    pollIntervalSeconds: {
      description: '轮询 transcript / RPC 状态的基础间隔（秒）。默认 2。',
    },
    fastSettleSeconds: {
      description:
        'RPC 确认 IDLE 后再观察的确认窗口（秒）。用来挡住工具轮之间的短暂间隙，默认 2。',
    },
    useFullTranscript: {
      description:
        '优先读取 transcript_full.jsonl，避免 4000 字符以上的报告被静默截断。默认 true。',
    },
    quotaFallback: {
      description:
        '账号额度保护：目标档位额度低于阈值时自动降级到 flash，避免任务卡死。' +
        'pro 与 flash 共用 Gemini Models 额度池，降级本质是降低单位任务燃烧速率。',
    },
    maxArtifactInlineChars: {
      description:
        '单个 brain 产物（walkthrough.md 等）内联到结果里的字符上限。' +
        '超出时只内联开头片段并附上绝对路径，避免主模型上下文膨胀。',
    },
    maxArtifactHeadChars: {
      description: '超出内联上限时，仍然内联的开头字符数。',
    },
    longSessionTurns: {
      description:
        '同一 session_id 累计多少轮后，在结果末尾提示换新会话（会话越长每轮携带的历史越大，配额消耗越高）。',
    },
    hangingCommandWarnSeconds: {
      description:
        '常驻命令（dev server / watch 模式）持续超过这个秒数仍未退出时，在结果中给出明确警告。',
    },
    // --- v0.6.0 -----------------------------------------------------------
    taskMode: {
      description:
        '执行器人格：auto（默认，按 task_spec 自动判定）| surgical（修 Bug/后端/重构，最小化改动）' +
        '| creative（3D/Three.js/WebGL/界面/小游戏，高密度视觉）。' +
        'auto 下你不需要在任何任务类型之间切换时修改配置。',
    },
    hangingCommandTimeoutSeconds: {
      description:
        '⚠️ 挂起命令主动熔断：疑似常驻/交互式命令持续超过这个秒数且期间无新步骤时，' +
        '立即中断本轮，而不是苦等 maxSeconds。0 = 关闭（退回只告警）。',
    },
    includeGitSummary: {
      description:
        '结算后自动跑 git status --porcelain 与 git diff --stat（各 3s 超时）并附在报告里，' +
        '主模型无需再额外跑一轮 git；同时用「工作区干净但声称改了」提示识破假改。',
    },
    includeTaskModeHint: {
      description: '在返回报告里显示本次判定的 task_mode 与判定来源（排查用，纯观测）。',
    },
    pacing: {
      description:
        '拟人冷却：连续两次委派之间补足最小间隔并叠加随机抖动。单轮结算不受影响，只作用于下一轮的开始。',
    },
    realtimeKillSwitch: {
      description:
        '⚠️ 事中熔断：命中高危破坏性命令（含 .git/hooks 与 .git/config 写入）时立即调用 ' +
        'CancelCascadeInvocation 中断本轮，无条件生效；普通工作区越界才额外需要 failOnEscape。',
    },
    persistSessions: {
      description: '把 session_id → conversation_id 映射落盘，dsh 重启后仍可续聊。',
    },
    includeBrainArtifacts: {
      description:
        '回收 Antigravity brain 目录下的 walkthrough.md / implementation_plan.md / task.md 等结构化产物。',
    },
  }),
})

export default Config
