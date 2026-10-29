/**
 * Audit a finished Antigravity turn for work that escaped its workspace.
 *
 * WHY THIS EXISTS
 * ---------------
 * `agentapi` offers no workspace parameter. A conversation created through it
 * carries `workspaces: []` and `enforcedWorkspaceValidation: false` in its own
 * metadata, so the executor's filesystem reach is decided by the model's
 * cooperation, not by the Language Server. The only honest boundary available
 * from the outside is a reading of the transcript: every `read_file` and
 * `run_command` the executor issued is on disk, so we can classify them against
 * the workspace and report escape attempts instead of implying a containment
 * that does not exist.
 *
 * WHAT CHANGED IN 0.4.0 (REQ-04 / REQ-05)
 * ---------------------------------------
 * The auditor used to be a pure post-hoc pass over a finished turn. Two things
 * made that insufficient:
 *
 *   1. A post-hoc verdict cannot stop damage. `createAuditor` is *stateful*: it
 *      is fed one step at a time while the turn runs, so `push()` can report
 *      `blocked` and the caller can cancel the cascade mid-flight.
 *   2. A per-command check without memory is trivially bypassed. `cd ..\..` in
 *      one step changes how `..\secret.txt` resolves in the next, and PowerShell
 *      aliases (`sl`, `ri`, `pushd`) or `$env:USERPROFILE` never mention an
 *      absolute path at all. The auditor therefore tracks a **virtual working
 *      directory** across the whole turn and expands aliases and environment
 *      variables before classifying.
 *
 * It is still an AUDITOR, not a sandbox: it observes what was asked for and
 * reports it. With `failOnEscape` + `realtimeKillSwitch` the caller can act on
 * that observation, but containment itself remains prompt-level.
 *
 * @module antigravity-executor/lib/audit
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Windows drive-absolute (`C:\x`, `C:/x`) or UNC (`\\server\share`) path. */
const ABS_WIN = /^(?:[a-zA-Z]:[\\/]|\\\\)/
/** POSIX absolute path, used only when the workspace itself is POSIX. */
const ABS_POSIX = /^\/(?!\/)/

/**
 * Commands whose effect is destructive or reputationally dangerous when the
 * executor is not trusted. Matched case-insensitively against each command line.
 * Order matters only for reporting: the first match labels the finding.
 *
 * The 0.4.0 additions cover PowerShell's aliases and flag spellings, which the
 * original Windows-CMD-shaped rules missed entirely: `ri -Recurse` never
 * contains `Remove-Item`, and `del /f/s/q` never matches `del /s/q *`.
 */
const DANGEROUS_COMMANDS = [
  { id: 'format', re: /\bformat(?:\.com)?\s+[a-z]:/i, why: '格式化磁盘' },
  { id: 'diskpart', re: /\bdiskpart\b/i, why: '磁盘分区操作' },
  { id: 'rm-root', re: /\brm(?:dir)?\s+.*\s+[a-z]:[\\/]?\s*$/i, why: '删除盘符根目录' },
  { id: 'rd-recursive', re: /\b(?:rd|rmdir)\s+\/[sq]/i, why: '递归强制删除目录' },
  { id: 'del-recursive', re: /\bdel\s+\/[sq]\s+\*/i, why: '强制递归删除文件' },
  {
    id: 'del-wildcard',
    re: /\b(?:del|erase|Remove-Item)\b[^\n]*\s(?:[-*?]\s*)?\*\.?\*|\bRemove-Item\b[^\n]*\s\*\s*$/i,
    why: '通配删除（del *.* / Remove-Item *）',
  },
  {
    id: 'del-force-flags',
    re: /\bdel\s+(?=[^\n]*\/f)(?=[^\n]*\/[sq])|\berase\s+\/[fq]/i,
    why: '强制删除文件（/f 或 /q 组合）',
  },
  { id: 'remove-item-recurse', re: /Remove-Item\b.*-Recurse.*-Force/i, why: 'PowerShell 递归强删' },
  {
    id: 'remove-item-alias',
    re: /\b(?:ri|rm|rd|rmdir|del|erase)\b[^\n]*\s-(?:Recurse|Force)\b/i,
    why: 'PowerShell 删除别名带 -Recurse/-Force',
  },
  {
    id: 'remove-item-force-only',
    re: /\b(?:ri|del|erase)\b[^\n]*\s-Force\b/i,
    why: 'PowerShell 删除别名带 -Force',
  },
  {
    id: 'rm-recursive-posix',
    re: /\brm\s+(?:-[a-z]*[rf][a-z]*\s+){1,3}(?:\/|~|\$HOME|\.\.)/i,
    why: '递归删除 POSIX 路径',
  },
  { id: 'reg-delete', re: /\breg\s+delete\b/i, why: '删除注册表项' },
  { id: 'takeown', re: /\btakeown\b|\bicacls\b.*\/grant/i, why: '改写文件权限' },
  { id: 'disable-defender', re: /Set-MpPreference|Disable-WindowsOptionalFeature/i, why: '关闭安全防护' },
  { id: 'shutdown', re: /\b(?:shutdown|Restart-Computer|Stop-Computer)\b/i, why: '关机/重启系统' },
  { id: 'schtasks', re: /\bschtasks\s+\/create\b/i, why: '创建计划任务' },
  { id: 'net-user', re: /\bnet\s+user\b.*\/add/i, why: '创建系统账户' },
  { id: 'git-destructive', re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)/i, why: '破坏性 git 操作' },
  {
    id: 'curl-pipe',
    re: /\b(?:curl|wget|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression|sh|bash|node|python)/i,
    why: '远程脚本直接执行',
  },
  { id: 'npm-global', re: /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+(?:-g|--global)\b/i, why: '全局安装包' },
]

/**
 * Classify a finding kind by which kill-switch granularity governs it.
 *
 * WHY THE SPLIT EXISTS (v0.5.0)
 * -----------------------------
 * `failOnEscape: false` is how most profiles say "I tolerate the executor
 * reading outside the workspace occasionally". It was never meant to say "I
 * tolerate `reg delete`". But the 0.4.0 kill switch armed itself only when
 * `failOnEscape && realtimeKillSwitch`, so with the shipped defaults the
 * mid-flight circuit breaker was permanently asleep — the single most
 * dangerous configuration the plugin could be in, silently.
 *
 * The fix is to give every finding a granularity:
 *   - `destructive`: the 15+ dangerous-command rules. Path-independent: a
 *     `Remove-Item -Recurse -Force` inside the workspace is exactly as
 *     blocking as one outside it. Governed by `realtimeKillSwitch` alone.
 *   - `escape`: `cd-outside` / `write-outside`. Still governed by
 *     `failOnEscape` + `realtimeKillSwitch`, as before.
 *   - `undefined` (read-outside, external reads): never blocks mid-flight.
 *
 * @param {string} kind - a finding's `kind` field.
 * @returns {'destructive'|'escape'|undefined}
 */
export function classifyFinding(kind) {
  const text = String(kind ?? '')
  if (text.startsWith('dangerous:')) return 'destructive'
  if (text === 'cd-outside' || text === 'write-outside') return 'escape'
  return undefined
}

/**
 * Commands that never exit on their own when run bare, so they would keep the
 * cascade BUSY until the delegation deadline (measured: a stray dev server
 * burns the whole `maxSeconds` budget and the turn comes back as a timeout
 * with zero diagnostics).
 *
 * Static recognition only — "has it been running too long" is the caller's
 * judgement, fed by `findHangingCommands` across successive scans.
 */
const HANGING_COMMANDS = [
  // Package-script dev/preview/serve servers. The script name must end with
  // dev/preview/serve (word-bounded), so `npm run device-tests` stays clean.
  {
    id: 'dev-server',
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve)(?![\w-])|\b(?:npm|pnpm|yarn|bun)\s+run\s+[\w:-]*(?:dev|preview|serve)\b/i,
    why: '启动了常驻开发服务器（dev/preview/serve）',
  },
  { id: 'dev-server', re: /(?:^|[;&|\s])(?:npx\s+)?vite(?![\w-])(?!\s+(?:build|optimize|preview-bash|pack|bundle)\b)/i, why: '裸跑 vite 开发服务器' },
  { id: 'dev-server', re: /\bnext\s+dev\b|\bnuxt\s+dev\b|\bng\s+serve\b/i, why: '框架 dev server' },
  { id: 'dev-server', re: /\brails\s+(?:server|s)\b|\bphp\s+artisan\s+serve\b/i, why: '应用服务器进程' },
  // Watch-mode test runners. Bare `vitest` defaults to --watch; `jest` does
  // NOT (a bare `jest` runs once), so jest only matches with an explicit watch
  // flag below. `vitest run` / `--run` / `--watch=false` / `--ci` opt out.
  {
    id: 'watch-mode',
    re: /(?:^|[;&|\s])(?:npx\s+)?vitest\b/i,
    why: 'vitest 默认进入 watch 模式',
    veto: /(?:^|\s)(?:npx\s+)?vitest\b[^\n]*?(?:\b-{0,2}(?:run|ci)\b|--watch=false|--coverage\b)/i,
  },
  { id: 'watch-mode', re: /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b[^\n]*--\s+--watch(?:All)?\b/i, why: 'npm test 显式 watch 模式' },
  // File watchers / reloaders, including explicit jest watch flags.
  { id: 'watch-mode', re: /\btsc\s+--watch\b|\bsass\s+--watch\b|\bwebpack\s+--watch\b|\bjest\s+(?:-[a-z]+\s+)*--watch(?:All)?\b/i, why: '文件监视进程' },
  {
    id: 'reloader',
    re: /\bnodemon(?![\w-])|\buvicorn\b[^\n]*--reload\b|\bpython\s+-m\s+http\.server\b/i,
    why: '自动重载/常驻服务进程',
  },
]

/**
 * Recognise a command that will not exit by itself.
 *
 * A rule with a `veto` pattern only fires when the veto does NOT match: the
 * vitest/jest family opts out of watch mode with `--run` / `--ci` /
 * `--watch=false`, so `vitest run` must stay clean while bare `vitest` is
 * flagged.
 *
 * @param {string} command - one `run_command` command line.
 * @returns {{id: string, why: string}|undefined} the first matching rule, or
 *   undefined for one-shot commands.
 */
export function parseHangingCommand(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return undefined
  for (const rule of HANGING_COMMANDS) {
    if (!rule.re.test(text)) continue
    if (rule.veto !== undefined && rule.veto.test(text)) continue
    return { id: rule.id, why: rule.why }
  }
  return undefined
}

/**
 * All hanging-command hits among one step's tool calls, keyed by call index.
 * The caller keeps the map between scans: a hit whose command keeps running
 * across ticks becomes a "long-running blocker" warning.
 *
 * @param {object} step - a normalized step (CONTRACT §4).
 * @returns {Array<{index: number, command: string, id: string, why: string}>}
 */
export function findHangingCommands(step) {
  const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : []
  const out = []
  calls.forEach((call, index) => {
    const name = String(call?.name ?? '')
    if (name !== 'run_command' && name !== 'run_terminal_command') return
    const raw = String(call?.args?.CommandLine ?? call?.args?.command ?? '')
    const hit = parseHangingCommand(raw)
    if (hit !== undefined) out.push({ index, command: raw.slice(0, 200), ...hit })
  })
  return out
}

/**
 * Paths that are normal, expected, read-only context even outside the workspace:
 * the executor legitimately consults its own guide/skills and the transcript.
 * Reads there are reported separately (as `externalReads`) rather than as
 * violations, so ordinary orientation does not drown a real escape.
 */
const BENIGN_READ_PREFIXES = [
  '.gemini\\antigravity\\builtin',
  '.gemini/antigravity/builtin',
  '.gemini\\antigravity\\brain',
  '.gemini/antigravity/brain',
  '.gemini\\antigravity\\skills',
  '.gemini/antigravity/skills',
  'appdata\\local\\programs\\antigravity',
  'appdata/roaming/antigravity',
  '/applications/antigravity.app',
]

/**
 * Aliases that change the working directory, mapped to the canonical verb.
 * PowerShell's `sl`/`chdir` and bash's `pushd` all end up here so one state
 * machine handles both shells.
 */
const CD_ALIASES = new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'popd', 'push-location', 'pop-location'])

/** Aliases that delete, mapped to `remove`. */
const DELETE_ALIASES = new Set(['rm', 'del', 'erase', 'rd', 'ri', 'rmdir', 'remove-item', 'unlink'])

/** Aliases that write/copy/move, used to count write-shaped commands. */
const WRITE_ALIASES = new Set([
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'ni',
  'copy-item',
  'cp',
  'copy',
  'move-item',
  'mv',
  'move',
  'rename-item',
  'ren',
  'mkdir',
  'md',
  'tee-object',
  'touch',
  ...DELETE_ALIASES,
])

/**
 * Environment variables and shorthands that resolve to a *sensitive* location
 * outside the workspace. The value is a resolver, because the real path depends
 * on the machine: mapping `~` to a literal `/home/user` would be wrong here.
 *
 * A resolved path is only treated as an escape when the workspace is not itself
 * inside it (see `isSensitive`), so a project that legitimately lives under the
 * user profile is not reported against itself.
 */
const ENV_RESOLVERS = [
  { re: /\$env:(?:USERPROFILE|HOME)\b/gi, resolve: () => homedir() },
  { re: /%USERPROFILE%/gi, resolve: () => homedir() },
  { re: /\$env:APPDATA\b/gi, resolve: () => process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') },
  { re: /%APPDATA%/gi, resolve: () => process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') },
  { re: /\$env:LOCALAPPDATA\b/gi, resolve: () => process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local') },
  { re: /%LOCALAPPDATA%/gi, resolve: () => process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local') },
  { re: /\$env:TEMP\b|\$env:TMP\b/gi, resolve: () => process.env.TEMP ?? process.env.TMP ?? join(homedir(), 'AppData', 'Local', 'Temp') },
  { re: /%TEMP%|%TMP%/gi, resolve: () => process.env.TEMP ?? process.env.TMP ?? join(homedir(), 'AppData', 'Local', 'Temp') },
  { re: /\$env:ProgramFiles\b/gi, resolve: () => process.env.ProgramFiles ?? 'C:\\Program Files' },
  { re: /\$env:SystemRoot\b/gi, resolve: () => process.env.SystemRoot ?? 'C:\\Windows' },
  { re: /\$HOME\b/g, resolve: () => homedir() },
  { re: /(?<![\w$])~(?![\w])/g, resolve: () => homedir() },
]

/**
 * Normalise to a comparison key: forward slashes, lower case, no trailing
 * separator.
 *
 * WHY DOUBLED BACKSLASHES ARE FOLDED
 * ----------------------------------
 * The transcript records the arguments Antigravity received, and for
 * `run_command` those arrive PowerShell-escaped: a real path
 * `E:\work\proj` is stored as `E:\\work\\proj`. Comparing that raw against a
 * plain workspace path reports the workspace itself as an escape — a false
 * positive that would train the user to ignore the audit. Collapsing runs of
 * two-or-more backslashes to one makes both spellings agree. Single
 * backslashes are left alone so ordinary paths are untouched.
 */
export function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\//g, '\\')
    .replace(/\\{2,}/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

/**
 * Is `target` inside `root`? Compares normalised absolute paths, so `C:\a\b`
 * counts as inside `C:\a` while `C:\ab` does not (a naive startsWith would say
 * it does — that off-by-one is exactly how "contained" checks leak).
 */
export function isInside(root, target) {
  const r = normalizePath(root)
  const t = normalizePath(target)
  if (r === '' || t === '') return false
  if (t === r) return true
  return t.startsWith(`${r}\\`)
}

/** Is this an absolute path in whichever dialect the text uses? */
function isAbsoluteAnywhere(value) {
  const text = String(value ?? '').trim()
  return ABS_WIN.test(text) || ABS_POSIX.test(text)
}

/**
 * Expand PowerShell/Bash aliases and environment variables into a command text
 * whose paths are all absolute (REQ-05).
 *
 * The expansion is deliberately textual: we do not try to be a shell parser, we
 * only make sure that a command written with `sl $env:USERPROFILE` or `cd ..\..`
 * exposes the absolute path it really touches, so the containment check has
 * something concrete to compare. Aliases are rewritten to their canonical verb
 * (`sl` -> `Set-Location`, `ri` -> `Remove-Item`) so the rule table and the
 * write detector only need one spelling each.
 */
export function expandAliases(command) {
  let text = String(command ?? '')

  // 1. Environment variables / shorthands -> real absolute paths.
  for (const { re, resolve: resolveValue } of ENV_RESOLVERS) {
    text = text.replace(re, () => resolveValue())
  }

  // 2. Aliases -> canonical verbs. Word-boundary anchored so a flag or a path
  //    that merely contains the letters is not rewritten.
  text = text.replace(/(^|[;&|(]\s*|\s)([A-Za-z][\w-]*)\b/g, (match, lead, word) => {
    const lower = word.toLowerCase()
    if (CD_ALIASES.has(lower) && lower !== 'set-location') return `${lead}Set-Location`
    if (DELETE_ALIASES.has(lower) && lower !== 'remove-item') return `${lead}Remove-Item`
    return match
  })

  return text
}

/**
 * Resolve a possibly-relative path against a virtual working directory.
 *
 * This is the heart of REQ-05: `..\..\secret.txt` means nothing on its own, but
 * against the directory the executor is actually sitting in it is an exact
 * path, and that is what has to be compared with the workspace.
 */
export function resolveVirtualPath(cwd, target) {
  const raw = String(target ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
  if (raw === '') return raw
  if (isAbsoluteAnywhere(raw)) return raw
  // `..` / `.` / `sub/dir` are all relative: join onto the virtual cwd.
  try {
    return resolve(String(cwd ?? '.'), raw)
  } catch {
    return raw
  }
}

/**
 * Split a command line into `cd` segments and the remaining work, tolerating
 * every directory-change spelling rather than only `Set-Location -LiteralPath`.
 *
 * The dispatcher prefixes commands with `Set-Location -LiteralPath '<ws>';`, so
 * a leading chain of those is expected and peeled off. Everything after the
 * last directory change is what the command actually does.
 */
function splitCommandLine(raw) {
  const text = String(raw ?? '')
    .replace(/^"|"$/g, '')
    .trim()
  const segments = []
  let rest = text

  // Set-Location / cd / sl / chdir / pushd, with an optional quoted or bare path.
  const re =
    /^\s*(?:Set-Location|cd|chdir|sl|pushd|Push-Location)\s+(?:-LiteralPath\s+|-Path\s+)?(?:(['"])(.*?)\1|([^\s;&|]+))\s*;?\s*/i
  for (;;) {
    const m = re.exec(rest)
    if (m === null) break
    segments.push({ kind: 'cd', path: (m[2] ?? m[3] ?? '').trim() })
    rest = rest.slice(m[0].length)
  }

  // A mid-command directory change still moves the rest of the line.
  for (const m of rest.matchAll(
    /[;&|]\s*(?:Set-Location|cd|chdir|sl|pushd|Push-Location)\s+(?:-LiteralPath\s+|-Path\s+)?(?:(['"])(.*?)\1|([^\s;&|]+))/gi,
  )) {
    segments.push({ kind: 'cd', path: (m[2] ?? m[3] ?? '').trim() })
  }

  return { segments, command: rest.trim() }
}

/** Every path-looking token in a command line, absolute or relative. */
export function extractPaths(command) {
  const out = new Set()
  const text = String(command ?? '')

  // Quoted tokens first, so spaces survive.
  for (const m of text.matchAll(/(['"])((?:[a-zA-Z]:|\\|\/|\.\.?[\\/])[^'"]+)\1/g)) out.add(m[2])
  // Bare drive-absolute tokens.
  for (const m of text.matchAll(/(?<![\w'"-])([a-zA-Z]:[\\/][^\s;|&,)"']*)/g)) out.add(m[1])
  // Bare relative tokens that climb (`..\x`, `./x`), which is how escapes look.
  for (const m of text.matchAll(/(?<![\w'"-])(\.\.[\\/][^\s;|&,)"']*)/g)) out.add(m[1])

  return [...out]
    .map((p) => p.replace(/[\\/,;]+$/, ''))
    .filter((p) => p !== '')
}

/** The verb of a simple command, lower-cased, for alias classification. */
function commandVerb(text) {
  const m = /(?:^|[;&|]\s*)([A-Za-z][\w-]*)/.exec(String(text ?? ''))
  return m === null ? '' : m[1].toLowerCase()
}

/**
 * A stateful auditor that walks a turn step by step (REQ-04 / REQ-05).
 *
 * WHY STATEFUL
 * ------------
 * Two reasons, both load-bearing:
 *   - The virtual working directory only means anything if it carries across
 *     steps: step 3's `cd ..\..` decides what step 4's `..\secret.txt` is.
 *   - The kill switch needs an answer *per step*, while the turn is running, not
 *     once at the end when the damage is already done.
 *
 * `auditTurn()` is implemented on top of this so the post-hoc report and the
 * streaming verdict can never disagree.
 */
export function createAuditor(workspace) {
  const root = resolve(String(workspace ?? '.'))
  const violations = []
  const externalReads = []
  const seen = new Set()

  let virtualCwd = root
  let commandCount = 0
  let writeCount = 0
  let readCount = 0
  let lastStep = -1

  const benign = (absPath) =>
    BENIGN_READ_PREFIXES.some((prefix) => normalizePath(absPath).includes(prefix))

  /**
   * Record one finding, deduplicated by (kind, path, command): a retry loop must
   * not inflate the count, and the streaming pass must not double-report what
   * the final pass will see again.
   */
  function record(entry) {
    const key = `${entry.kind}|${entry.path ?? ''}|${entry.command ?? ''}`
    if (seen.has(key)) return undefined
    seen.add(key)
    if (entry.kind === 'external-read') externalReads.push(entry)
    else violations.push(entry)
    return entry
  }

  /** Classify a `cd`-like segment and move the virtual cwd. */
  function applyCd(stepIndex, tool, rawPath, rawCommand) {
    const target = resolveVirtualPath(virtualCwd, rawPath)
    if (target === '') return
    // Move the virtual cwd even when the target is outside: a later relative
    // path must resolve from where the executor really is, not where we wish.
    virtualCwd = target
    if (!isAbsoluteAnywhere(target)) return
    if (isInside(root, target)) return
    record({
      step: stepIndex,
      tool,
      kind: 'cd-outside',
      severity: 'error',
      path: target,
      why: '把工作目录切到工作区之外',
      command: String(rawCommand ?? '').slice(0, 200),
    })
  }

  /** Classify one tool call. */
  function classifyCall(stepIndex, tool, args) {
    const name = String(tool ?? '')

    if (name === 'read_file' || name === 'view_file' || name === 'read_notebook') {
      readCount += 1
      const rawPath = String(args.Path ?? args.path ?? args.file_path ?? '')
      if (rawPath.trim() === '') return
      const target = resolveVirtualPath(virtualCwd, rawPath)
      if (!isAbsoluteAnywhere(target)) return
      if (isInside(root, target)) return
      if (benign(target)) {
        record({ step: stepIndex, tool: name, kind: 'external-read', path: target })
        return
      }
      record({
        step: stepIndex,
        tool: name,
        kind: 'read-outside',
        severity: 'warn',
        path: target,
        why: '读取工作区之外的文件',
      })
      return
    }

    if (name === 'run_command' || name === 'run_terminal_command') {
      commandCount += 1
      const raw = String(args.CommandLine ?? args.command ?? '')
      const expanded = expandAliases(raw)
      const { segments, command } = splitCommandLine(expanded)

      for (const seg of segments) applyCd(stepIndex, name, seg.path, raw)

      // Match the rule table against BOTH spellings. `expandAliases` canonicalises
      // `ri` to `Remove-Item`, which is what makes the write detector work — but it
      // also erases the alias the dangerous-rule table recognises (`ri -Recurse`).
      // Checking the raw text as well keeps alias-specific rules alive.
      const dangerText = `${command}\n${splitCommandLine(raw).command}`
      for (const danger of DANGEROUS_COMMANDS) {
        if (danger.re.test(dangerText)) {
          record({
            step: stepIndex,
            tool: name,
            kind: `dangerous:${danger.id}`,
            severity: 'error',
            why: danger.why,
            command: command.slice(0, 200),
          })
        }
      }

      // Paths handed to write-capable verbs, resolved against the virtual cwd so
      // `..\..\x` and `$env:TEMP\x` are judged by where they really land.
      const verb = commandVerb(command)
      const writeShaped =
        WRITE_ALIASES.has(verb) ||
        /(?:^|[;&|]\s*)(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|mkdir|md|cp|mv|del|rd|rm|erase|ni|tee-object|touch)\b/i.test(
          command,
        )

      if (writeShaped) {
        writeCount += 1
        for (const candidate of extractPaths(command)) {
          const target = resolveVirtualPath(virtualCwd, candidate)
          if (!isAbsoluteAnywhere(target)) continue
          if (isInside(root, target)) continue
          record({
            step: stepIndex,
            tool: name,
            kind: 'write-outside',
            severity: 'error',
            path: target,
            why: '在工作区之外写入或删除',
            command: command.slice(0, 200),
          })
        }
      }
    }
  }

  return {
    /** The workspace this auditor judges against. */
    workspace: root,
    /** Current virtual working directory (advanced by `cd`-like commands). */
    get cwd() {
      return virtualCwd
    },

    /**
     * Feed one normalized step (CONTRACT §4). Steps may arrive more than once
     * (polling re-reads the transcript); only indices above the last seen one
     * are classified, so a re-read never double-counts.
     *
     * @returns {{ violations: object[], externalReads: object[], commandCount: number,
     *            writeCount: number, readCount: number, blocked: boolean,
     *            blockedDestructive: boolean, blockedEscape: boolean }}
     *   `blocked` is true when this push produced a finding that should stop the
     *   turn under the old (combined) semantics; `blockedDestructive` /
     *   `blockedEscape` split that verdict by granularity so the caller can
     *   cancel on destructive commands even when `failOnEscape` is false (see
     *   {@link classifyFinding}).
     */
    push(step) {
      const idx = Number(step?.step_index ?? -1)
      const before = violations.length
      if (Number.isFinite(idx) && idx > lastStep) {
        lastStep = idx
        const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : []
        for (const call of calls) classifyCall(idx, call?.name, call?.args ?? {})
      }
      const fresh = violations.slice(before)
      return {
        violations: fresh,
        externalReads,
        commandCount,
        writeCount,
        readCount,
        blocked: fresh.some((v) => v.severity === 'error'),
        blockedDestructive: fresh.some((v) => v.severity === 'error' && classifyFinding(v.kind) === 'destructive'),
        blockedEscape: fresh.some((v) => v.severity === 'error' && classifyFinding(v.kind) === 'escape'),
      }
    },

    /** The accumulated verdict for the whole turn. */
    report() {
      return { violations, externalReads, commandCount, writeCount, readCount }
    },
  }
}

/**
 * Classify every tool call in a finished turn (the post-hoc entry point).
 *
 * Implemented over `createAuditor` on purpose: the streaming verdict and the
 * final report must be produced by the same state machine, or a turn could be
 * reported CLEAN after the kill switch saw an escape.
 *
 * @param {Array<object>} steps - parsed transcript steps (all of them).
 * @param {number} sinceIndex - first `step_index` belonging to this turn.
 * @param {string} workspace - absolute workspace the turn was dispatched for.
 * @returns {{ violations: Array<object>, externalReads: Array<object>, commandCount: number, writeCount: number, readCount: number }}
 */
export function auditTurn(steps, sinceIndex, workspace) {
  const auditor = createAuditor(workspace)
  for (const step of steps ?? []) {
    const idx = Number(step?.step_index ?? -1)
    if (!Number.isFinite(idx) || idx < sinceIndex) continue
    auditor.push(step)
  }
  return auditor.report()
}

/** Human-readable audit block appended to every delegation result. */
export function renderAudit(report, workspace) {
  const { violations, externalReads, commandCount, writeCount, readCount } = report
  const lines = []
  lines.push(`--- workspace audit (soft sandbox) ---`)
  lines.push(`workspace    : ${workspace}`)
  lines.push(
    `activity     : ${commandCount} command(s), ${readCount} read(s), ${writeCount} write-shaped command(s)`,
  )

  if (violations.length === 0) {
    lines.push('verdict      : CLEAN - no out-of-workspace access detected in the transcript')
  } else {
    const errors = violations.filter((v) => v.severity === 'error').length
    lines.push(
      `verdict      : ${errors > 0 ? 'ESCAPED' : 'WARN'} - ${violations.length} finding(s), ${errors} blocking`,
    )
    for (const v of violations) {
      const where = v.path ? ` ${v.path}` : ''
      lines.push(`  [${v.severity}] step ${v.step} ${v.kind}:${where} — ${v.why}`)
      if (v.command && (v.kind.startsWith('dangerous:') || v.kind === 'write-outside')) {
        lines.push(`           cmd: ${v.command}`)
      }
    }
  }

  if (externalReads.length > 0) {
    lines.push(`external reads (benign, not counted): ${externalReads.length}`)
    for (const r of externalReads.slice(0, 8)) lines.push(`  step ${r.step} ${r.path}`)
    if (externalReads.length > 8) lines.push(`  … ${externalReads.length - 8} more`)
  }

  if (violations.some((v) => v.severity === 'error')) {
    lines.push(
      'DO NOT ACCEPT this result as-is: the executor wrote outside the workspace or ran a',
      'dangerous command. Inspect the paths above, revert what should not have changed, and',
      're-dispatch with a tighter task spec before trusting the report.',
    )
  }
  return lines.join('\n')
}
