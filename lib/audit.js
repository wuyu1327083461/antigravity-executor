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
 * WHAT CHANGED IN 0.6.0 (REQ-05 / REQ-03 / REQ-07)
 * -----------------------------------------------
 * v0.5.1 could see a write leave the workspace, and could see a destructive
 * command, but it could not see the most valuable write of all: one that lands
 * *inside* the workspace, on Git metadata.
 *
 * Measured against the 0.5.1 tree: `Set-Content .git\hooks\pre-commit ...`
 * produced zero findings. `writeCount` incremented, `extractPaths` returned
 * nothing (the target is relative and unquoted — that function collects only
 * quoted, drive-absolute and `..`-climbing tokens), and even when it did return
 * something the path was inside the workspace, so `write-outside` was skipped by
 * design. With the shipped `failOnEscape: false` nothing blocked. Minutes later
 * the caller runs `git status` in that workspace and executes a hook the
 * executor wrote — or `.git/config` carrying `core.hooksPath`. Escape detection
 * was never the right control here: the path does not escape, it escalates
 * through the tooling that reads the workspace next.
 *
 * So 0.6.0 adds a finding that is *path-based and containment-independent*:
 * `destructive_git_metadata_write`. It deliberately has no `dangerous:` prefix
 * (that prefix means "the command line matched a dangerous-command rule"; this
 * one means "a write landed on git metadata") and it classifies as
 * `destructive`, so the v0.5.0 circuit breaker stops it on `realtimeKillSwitch`
 * alone, whatever `failOnEscape` says.
 *
 * Two blindnesses are fixed in the same pass:
 *   - `run_command` writes were only recognised through `extractPaths`, so a
 *     redirection to a bare relative target (`echo x > .git\config`) was
 *     invisible. `extractWriteTargets` reads redirections and the path
 *     arguments of write verbs, including bare relative targets.
 *   - native write tools (`write_to_file`, `replace_file_content`, …) had no
 *     handler at all, so a turn that edited files only through them was audited
 *     as if it had written nothing.
 *
 * The same pass grows the report the caller consumes (REQ-03 / REQ-07):
 * `touchedFiles` (the inside-workspace files a follow-up request such as "now
 * change line 40 of that function" refers to) and `fileWrites` (how many file
 * write *operations* really happened, which is what makes "the executor claims
 * it edited files but the worktree is clean" detectable).
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
 * v0.6.0 adds a third member to `destructive` and the reason it belongs there is
 * worth stating, because its *name* suggests the escape bucket: a write to
 * `.git/hooks/pre-commit` or `.git/config` never leaves the workspace, so under
 * `failOnEscape: false` an `escape` classification would leave it unstopped —
 * exactly the shipped configuration. It is destructive because of what happens
 * afterwards: the next `git status` in that workspace runs the written hook.
 * That is the same "path-independent, stop it now" property as `reg delete`, so
 * it is `destructive` and the caller needs no additional wiring.
 *
 * @param {string} kind - a finding's `kind` field.
 * @returns {'destructive'|'escape'|undefined}
 */
export function classifyFinding(kind) {
  const text = String(kind ?? '')
  if (text.startsWith('dangerous:')) return 'destructive'
  // No `dangerous:` prefix on purpose: that prefix is reserved for a *command
  // line* matching the rule table. This kind is a *path* landing on git metadata,
  // which can happen through a native write tool that has no command line at all.
  if (text === 'destructive_git_metadata_write') return 'destructive'
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
 * Is this path git metadata that turns a later `git status` into code execution?
 *
 * WHY THIS IS A PATH TEST AND NOT A CONTAINMENT TEST
 * --------------------------------------------------
 * REQ-05's v0.6.0 hole is a write that stays *inside* the workspace. Two paths
 * inside a git worktree are executable content rather than data:
 *
 *   - `.git/hooks/*` — any hook name (`pre-commit`, `post-checkout`, `pre-push`,
 *     and the `*.sample` names are inert but writing them is still a signal). Git
 *     runs a hook because it exists and is executable; the executor does not need
 *     to chmod it on Windows, where the executable bit is not consulted.
 *   - `.git/config` — `core.hooksPath = .` or `core.fsmonitor = <cmd>` are git
 *     configuration keys whose *value* is executed. Writing this file is
 *     equivalent to writing a hook, which is why it gets its own arm.
 *
 * Case and separator folding comes from `normalizePath`, so `.GIT\\Hooks\\X`
 * and `.git/hooks/x` are the same path here. `normalizePath` also collapses the
 * doubled backslashes the transcript stores, so `E:\\ws\\.git\\config` matches.
 *
 * `.gitignore` must NOT match: a naive `includes('.git')` or `.git` prefix test
 * reports it, and that false positive is common enough (every repo has one) to
 * train the user into ignoring the whole finding class. Hence the segment-wise
 * match: `.git` has to be a complete segment, followed by exactly `hooks` (any
 * depth below it) or `config`.
 *
 * @param {string} target - absolute or relative path, any separator/casing.
 * @returns {boolean}
 */
export function isGitMetadataPath(target) {
  const key = normalizePath(target)
  if (key === '') return false
  // Split on the normalised separator and look for the `.git` marker segment.
  const segments = key.split('\\')
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] !== '.git') continue
    const next = segments[i + 1]
    // `.git/hooks/x` — a hook at any depth below `hooks`.
    if (next === 'hooks' && segments.length > i + 2) return true
    // `.git/config` exactly, at any depth below the marker.
    if (next === 'config') return true
  }
  return false
}

/**
 * Write verbs whose *path arguments* are files the command modifies.
 *
 * These are the canonical spellings. `expandAliases` rewrites the aliases the
 * caller is likely to use (`ri` -> `Remove-Item`), and the alias spellings are
 * listed again below because `extractWriteTargets` is exported and callers may
 * hand it raw command text that was never expanded.
 *
 * Stored lower-cased and compared against a lower-cased verb, because shell
 * verbs are case-insensitive on Windows and `SET-CONTENT` writes just as much
 * as `Set-Content` does.
 */
const WRITE_VERB_NAMES = new Set(
  [
    'Set-Content',
    'Add-Content',
    'Clear-Content',
    'Out-File',
    'New-Item',
    'Copy-Item',
    'Move-Item',
    'Rename-Item',
    'Remove-Item',
    'mkdir',
    'md',
    'cp',
    'copy',
    'mv',
    'move',
    'ren',
    'rm',
    'del',
    'erase',
    'rd',
    'rmdir',
    'tee',
    'tee-object',
    'touch',
    'export-content',
    'sp',
    'sc',
    'ac',
    'ni',
    'cpi',
    'mi',
    'rni',
    'ri',
  ].map((verb) => verb.toLowerCase()),
)

/**
 * Verbs that only *read* their argument, used as a guard so `Get-Content x` and
 * `type x` are not mistaken for writes. Listed explicitly because the write
 * detector below is deliberately recall-biased.
 */
const READ_VERB_NAMES = new Set([
  'get-content',
  'cat',
  'type',
  'gc',
  'more',
  'select-string',
  'findstr',
  'grep',
  'head',
  'tail',
  'less',
  'dir',
  'ls',
  'gci',
  'get-childitem',
])

/**
 * One token at the end of a verb's argument list: quoted, or bare up to the
 * next metacharacter. Quoted forms are captured without their quotes.
 */
const ARG_TOKEN = /(?:(['"])(.*?)\1|([^\s;&|<>]+))/g

/**
 * Flags whose following token is *content*, not a path (`-Value 'pwned'`).
 *
 * The distinction matters: `-Path` / `-LiteralPath` / `-Destination` take a
 * path and must be kept, while `-Value` / `-Encoding` take data that would
 * otherwise land in the report as a bogus target. Everything not listed here
 * keeps its value, because guessing wrong on a *path* flag means missing a
 * write — the failure mode this whole function exists to prevent.
 */
const NON_PATH_VALUE_FLAGS = new Set([
  '-value',
  '-encoding',
  '-itemtype',
  '-type',
  '-filter',
  '-depth',
  '-stream',
  '-totalcount',
  '-replace',
  '-match',
  '-pattern',
])

/**
 * A cmd.exe-style switch: `/f`, `/s`, `/q`, `/f/s/q`.
 *
 * Deliberately length-capped at two characters per part so a POSIX absolute
 * path (`/tmp/x`, `/usr/bin/node`) is never swallowed as a switch — `rm -rf
 * /tmp/x` must still report `/tmp/x` as the deleted target.
 */
const SLASH_SWITCH = /^\/[a-z]{1,2}(?:\/[a-z]{1,2})*$/i

/**
 * Device sinks that discard output. A redirect into one writes no file, so
 * `npm test > /dev/null` must not become a `write-outside` finding — that is the
 * single most common shell idiom there is, and a false positive on it would make
 * the report noise on nearly every turn.
 */
const NULL_SINKS = new Set(['/dev/null', 'nul', 'nul:', '/dev/stdout', '/dev/stderr', '-'])

/**
 * Close any quote left open at the end of the text.
 *
 * `splitCommandLine` strips a *wrapping* pair of quotes from the whole command
 * line, because Antigravity sometimes sends the entire command wrapped. That
 * legitimate strip turns `echo "a > b"` into `echo "a > b` — one quote short —
 * and every scanner downstream then mis-parses the tail (`>` looks like a
 * redirect, `"b c.txt` splits into two tokens). Restoring the closing quote is
 * exactly what a shell would do with the same text: keep reading until it ends.
 */
function balanceQuotes(text) {
  let quote = ''
  for (const ch of String(text ?? '')) {
    if (quote === '') {
      if (ch === '"' || ch === "'") quote = ch
    } else if (ch === quote) {
      quote = ''
    }
  }
  return quote === '' ? String(text ?? '') : `${text}${quote}`
}

/**
 * Blank out quoted spans that contain shell operators, before scanning.
 *
 * `echo "a > b"` writes no file at all, but a naive scan sees `>` and reports a
 * target called `b`. A quoted span that *contains* an operator (`>`, `|`, `;`,
 * `&`) therefore becomes an empty quoted pair, while a quoted span that is just
 * a path with spaces (`Set-Content "my file.txt"`) is left intact — blanking
 * everything would lose the very targets this function exists to collect.
 */
function blankQuoted(text) {
  return String(text ?? '').replace(/'[^']*'|"[^"]*"/g, (span) =>
    /[>|;&]/.test(span) ? "''" : span,
  )
}

/**
 * Targets a command creates or removes *as directories*, so `touchedFiles` can
 * leave them out.
 *
 * `mkdir dist`, `rd /s /q build` and `New-Item -ItemType Directory build` name
 * directories, and "now change line 40 of dist" is not a meaningful follow-up.
 * Detected statically — the paths usually do not exist on the auditing machine,
 * so `stat` is not an option here.
 *
 * THE HARD PART IS `Remove-Item`, AND THE RULE IS NARROW ON PURPOSE
 * ----------------------------------------------------------------
 * After `expandAliases` every delete spelling (`rm`, `del`, `rd`, `ri`) becomes
 * `Remove-Item`, and `Remove-Item notes.txt` deletes a *file* — the very kind of
 * touch worth reporting. So `Remove-Item` is only treated as a directory delete
 * when it carries `-Recurse` (a recursive delete walks a tree) or when the verb
 * was `rd`/`rmdir` before expansion. `mkdir`/`md`/`New-Item -ItemType Directory`
 * are always directories.
 *
 * @param {string} command
 * @param {string} [rawCommand] - the pre-expansion text, used to tell `rd` from
 *   `del` after `expandAliases` has folded both into `Remove-Item`.
 * @returns {Set<string>} normalised paths
 */
function directoryTargets(command, rawCommand) {
  const out = new Set()
  // Match verbs on the operator-blanked copy so `echo "mkdir x"` does not
  // register a directory. Positions are irrelevant, so the two views only need
  // to agree on which verbs appear.
  const text = blankQuoted(balanceQuotes(command))
  // Which delete spellings the author actually used, before expansion.
  const rawLower = String(rawCommand ?? '').toLowerCase()
  const rawSaysDirectory = /(?:^|[;&|]\s*)(?:rd|rmdir)\b/.test(rawLower)

  for (const m of text.matchAll(
    /(?:^|[;&|]\s*)(mkdir|md|rd|rmdir|del|erase|Remove-Item)\b([^\n]*)/gi,
  )) {
    const verb = m[1].toLowerCase()
    const args = m[2]

    if (verb === 'del' || verb === 'erase') continue // file deletes
    if (verb === 'remove-item' && !/-recurse\b/i.test(args) && !rawSaysDirectory) continue

    for (const token of splitArgTokens(args)) out.add(token)
  }
  for (const m of text.matchAll(/(?:^|[;&|]\s*)New-Item\b([^\n]*)/gi)) {
    // `-ItemType Directory` may sit anywhere in the argument list.
    if (!/-ItemType\s+['"]?(?:Directory|dir)\b/i.test(m[1])) continue
    for (const token of splitArgTokens(m[1])) {
      // Skip the value of `-ItemType` itself: `Directory` is a type, not a path.
      if (/^(?:directory|dir|file|symboliclink|junction|hardlink)$/i.test(token)) continue
      out.add(token)
    }
  }
  return new Set([...out].map((token) => normalizePath(token)))
}

/** Bare/quoted argument tokens of one argument list, flags removed. */
function splitArgTokens(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(ARG_TOKEN)) {
    const token = (m[2] ?? m[3] ?? '').trim()
    if (token === '' || token.startsWith('-') || token.startsWith('/')) continue
    out.push(token)
  }
  return out
}

/**
 * Paths a command line visibly writes to.
 *
 * WHY `extractPaths` IS NOT ENOUGH
 * --------------------------------
 * `extractPaths` answers "which paths are mentioned here", and it only reports
 * quoted tokens, drive-absolute tokens and `..`-climbing tokens. That is the
 * right answer for the *escape* check (an escape has to look absolute or climb),
 * and it is exactly the wrong answer here: `echo x > .git\config` mentions a
 * bare relative path, so `extractPaths` returns `[]` and the 0.5.1 audit saw a
 * write to git metadata as no write at all. Two arms close that:
 *
 *   1. Redirects — `>`, `>>`, `1>`, `2>`, `2>&1` handled so the `&` does not
 *      swallow the target, and `| Out-File x` / `| tee x` / `> file` shapes.
 *   2. Write verbs — the path arguments of `Set-Content` / `Remove-Item` / `cp`
 *      / … including bare relative ones.
 *
 * DELIBERATELY RECALL-BIASED: a false negative here is a security bug (a write
 * to `.git\hooks\pre-commit` that we never classify), while a false positive is
 * only a noise finding in a report that is fail-closed by design. So the write
 * verbs contribute *every* non-flag argument, not just the "obvious" ones: for
 * `Copy-Item a b` both `a` and `b` are reported, and the caller resolves each
 * against the virtual cwd. Over-reporting costs a redundant `write-outside`
 * line; under-reporting costs the whole control.
 *
 * @param {string} command - one command line (expanded or raw; both work).
 * @returns {string[]} de-duplicated targets, in first-seen order.
 */
export function extractWriteTargets(command) {
  const raw = String(command ?? '')
  if (raw.trim() === '') return []
  // `splitCommandLine` strips a *wrapping* quote pair from the whole line, which
  // leaves a genuinely quoted argument (`echo "a > b"`) one quote short. Restore
  // it first, or the operator/blanks below mis-parse the tail.
  const balanced = balanceQuotes(raw)
  // Operators are scanned on a copy with operator-bearing quoted spans blanked,
  // so `echo "a > b"` yields nothing instead of the bogus target `b`. Quoted
  // path arguments (`Set-Content "my file.txt"`) survive, because that is
  // exactly the target this function exists to collect.
  const text = blankQuoted(balanced)

  const out = new Set()
  /** Strip quotes and the trailing punctuation that clings to a bare token. */
  const add = (raw) => {
    const value = String(raw ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/[\\/,;]+$/, '')
    if (value === '') return
    // A device sink discards the write: it is not a file on any filesystem.
    if (NULL_SINKS.has(value.toLowerCase())) return
    out.add(value)
  }

  // --- arm 1: redirections -------------------------------------------------
  // `> target`, `>> target`, `1> target`, `N> target`, with or without a space.
  // `2>&1` / `2>&-` are descriptor duplications, not file targets, so the `&`
  // form is excluded rather than reported as a file.
  for (const m of text.matchAll(/(?:\d?>>?)(?!&)\s*(?:(['"])(.*?)\1|([^\s;&|<>]+))/g)) {
    add(m[2] ?? m[3])
  }
  // `| Out-File x`, `| Out-File -FilePath x`, `| tee x`, `Out-File -Append x`.
  for (const m of text.matchAll(
    /\|\s*(?:Out-File|tee(?:-object)?)\b((?:\s+(?:(['"])(.*?)\2|[^\s;&|<>]+))*)/gi,
  )) {
    collectVerbArgs(m[1], add)
  }
  // `Out-File` may also appear without a pipe (`Out-File -FilePath x`).
  for (const m of text.matchAll(/(?:^|[;&|]\s*)(?:Out-File|tee(?:-object)?)\b([^\n]*)/gi)) {
    collectVerbArgs(m[1], add)
  }

  // --- arm 2: write verbs --------------------------------------------------
  // A verb is at a command boundary: start of line, or after `;` `&&` `||` `|`.
  // `expandAliases` canonicalises the aliases, so both spellings are covered by
  // comparing case-insensitively against the union of the two lists.
  const verbRe =
    /(?:^|[;&|]\s*|\|\|\s*|&&\s*)([A-Za-z][\w-]*)((?:[^\n;&|]|&(?![&]))*)/g
  for (const m of text.matchAll(verbRe)) {
    const verb = m[1].toLowerCase()
    if (!WRITE_VERB_NAMES.has(verb)) continue
    collectVerbArgs(m[2], add)
  }

  return [...out]
}

/**
 * Collect the path-looking arguments of one verb's argument text.
 *
 * PowerShell's parameter grammar is `-Flag value`, and only some flags take a
 * path. `-Path`/`-LiteralPath`/`-Destination` name the target and keep their
 * value; `-Value`/`-Encoding` carry data that must not be reported as a path.
 * Bare tokens (no leading `-`) are always offered, because `.git\config` — the
 * exact shape that motivated this function — is bare and relative.
 */
function collectVerbArgs(argText, add) {
  const text = String(argText ?? '')
  let skipNext = false
  for (const m of text.matchAll(ARG_TOKEN)) {
    const token = (m[2] ?? m[3] ?? '').trim()
    if (token === '') continue
    const lower = token.toLowerCase()

    if (skipNext) {
      // The previous token was `-Value` (or similar): this one is payload.
      skipNext = false
      continue
    }

    // A switch. `-Flag` may take a value we need; `/f` never does.
    if (lower.startsWith('-') && lower.length > 1) {
      skipNext = NON_PATH_VALUE_FLAGS.has(lower)
      continue
    }
    if (SLASH_SWITCH.test(lower)) continue

    // A read-verb name appearing as an argument is not a target.
    if (READ_VERB_NAMES.has(lower)) continue
    add(token)
  }
}

/**
 * Is this Antigravity tool name a file-write tool?
 *
 * v0.5.1's `classifyCall` handled only read tools and command tools, so the
 * native write path — the one the executor uses for most real edits — was not
 * audited at all. `writeCount` stayed 0 and a turn that rewrote a hook through
 * `write_to_file` looked like a turn that wrote nothing.
 *
 * The list mixes the names Antigravity actually emits (`write_to_file`,
 * `replace_file_content`, `multi_replace_file_content`, the notebook editor) with
 * plausible spellings other builds use (`edit_file`, `create_file`,
 * `apply_patch`), because a name we do not recognise is a file write we do not
 * audit. Matching is case-insensitive.
 *
 * @param {string} name - a tool call's `name`.
 * @returns {boolean}
 */
export function isWriteTool(name) {
  const key = String(name ?? '').toLowerCase()
  if (key === '') return false
  return (
    key === 'write_to_file' ||
    key === 'replace_file_content' ||
    key === 'multi_replace_file_content' ||
    key === 'edit_file' ||
    key === 'create_file' ||
    key === 'apply_patch' ||
    key === 'delete_file' ||
    key === 'insert_content' ||
    key === 'notebook_edit' ||
    key === 'notebook_write'
  )
}

/**
 * Arg keys a write tool may use for its target, in probe order.
 *
 * `TargetFile` is what `write_to_file` / `replace_file_content` send; the rest
 * are the spellings seen across Antigravity builds and the transcript's own
 * normalisation. `uri` / `absolutePathUri` carry a `file://` URL rather than a
 * plain path (the same carrier `lib/transcript.js` decodes for reads).
 */
const WRITE_TOOL_PATH_KEYS = [
  'TargetFile',
  'AbsolutePath',
  'target_file',
  'Target',
  'path',
  'Path',
  'file_path',
  'filePath',
  'filename',
  'FileName',
  'uri',
  'absolutePathUri',
]

/** Strip a leading `file://` and percent-decode, as `lib/transcript.js` does. */
function uriToPath(value) {
  const text = String(value ?? '')
  if (!text.startsWith('file://')) return text
  let rest = text.slice('file://'.length)
  // `file:///F:/x` -> `/F:/x`; drop the leading slash so the drive letter leads.
  if (rest.startsWith('/')) rest = rest.slice(1)
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}

/**
 * The target path inside a write tool's args, or undefined.
 *
 * Probes the known keys in order and returns the first non-empty string. A
 * `file://` URI is decoded so the containment check compares plain paths —
 * without that, `file:///E:/ws/a.js` would never match the workspace and every
 * native write would be reported as an escape.
 *
 * @param {object} args - a tool call's `args`.
 * @returns {string|undefined}
 */
export function writeToolPath(args) {
  if (args === null || args === undefined || typeof args !== 'object') return undefined
  for (const key of WRITE_TOOL_PATH_KEYS) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const text = uriToPath(value).trim()
    if (text !== '') return text
  }
  return undefined
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

  /**
   * Inside-workspace files the executor read or wrote, in first-touch order.
   *
   * WHY THE CAP AND THE SEPARATE COMPARISON SET
   * -------------------------------------------
   * The consumer (REQ-03) re-embeds this list in the *next* prompt, so an
   * unbounded list would grow the prompt every turn. 20 entries is far more than
   * the caller keeps (it slices to 10) and still bounded. Comparison uses
   * `normalizePath` so `E:\ws\A.js` and `e:/ws/a.js` collapse to one entry, but
   * the *stored* value keeps the original casing: the caller shows these paths
   * to a user who has to find the file, and lower-casing them on Windows
   * happened to match the filesystem only by accident.
   */
  const touchedFiles = []
  const touchedKeys = new Set()
  const TOUCHED_CAP = 20

  /** Count a file-write *operation* (one per call, not one per path). */
  let fileWrites = 0

  const benign = (absPath) =>
    BENIGN_READ_PREFIXES.some((prefix) => normalizePath(absPath).includes(prefix))

  /**
   * Remember one touched file, if it is a real file inside the workspace.
   *
   * Directories are excluded on purpose: `cd src` and `mkdir dist` touch a
   * directory, and "change line 40 of src" means nothing. So is the workspace
   * root itself (the dispatcher's `Set-Location -LiteralPath '<ws>';` prefix
   * mentions it on every single command).
   */
  function touch(target) {
    if (target === '' || !isAbsoluteAnywhere(target)) return
    if (!isInside(root, target)) return
    // The workspace root: `isInside` says yes, but it is not a file.
    if (normalizePath(target) === normalizePath(root)) return
    // A directory write verb's argument is usually a directory, but we cannot
    // stat from here (the path may not exist yet on this machine). Extensions
    // and the `.git` marker are the cheap signal; everything else is kept,
    // because a false positive here only adds a path to a prompt.
    const key = normalizePath(target)
    if (touchedKeys.has(key)) return
    if (touchedFiles.length >= TOUCHED_CAP) return
    touchedKeys.add(key)
    touchedFiles.push(target)
  }

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

  /**
   * Classify one path a write landed on.
   *
   * Two independent questions, deliberately kept separate:
   *   1. Is this git metadata? (containment-independent — the 0.6.0 hole)
   *   2. Does it leave the workspace? (the 0.4.0 escape check)
   *
   * Both can be true for one path, and then both findings are recorded. An
   * attacker who writes `C:\shared\.git\config` gets `destructive_git_metadata_write`
   * *and* `write-outside`, which is the honest answer: it escaped, and it also
   * armed a hook. Dedup is per (kind, path, command) inside `record`.
   */
  function classifyWriteTarget(stepIndex, tool, target, rawCommand, isDirectory = false) {
    if (!isAbsoluteAnywhere(target)) return
    if (isGitMetadataPath(target)) {
      // Git metadata fires even when the verb was `Remove-Item` on a hook: a
      // deleted hook is one the attacker replaced with something inert, and the
      // finding is still worth the kill.
      record({
        step: stepIndex,
        tool,
        kind: 'destructive_git_metadata_write',
        severity: 'error',
        path: target,
        why: '修改 Git 元数据（hooks/config），会让后续 git 命令执行任意代码',
        ...(rawCommand === undefined ? {} : { command: String(rawCommand).slice(0, 200) }),
      })
    }
    if (isInside(root, target)) {
      // A real inside-workspace write: this is the file the next request is
      // about, so it belongs in `touchedFiles` — unless it is a directory.
      if (!isDirectory) touch(target)
      return
    }
    record({
      step: stepIndex,
      tool,
      kind: 'write-outside',
      severity: 'error',
      path: target,
      why: '在工作区之外写入或删除',
      ...(rawCommand === undefined ? {} : { command: String(rawCommand).slice(0, 200) }),
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
      if (isInside(root, target)) {
        // A read inside the workspace is exactly "the file the user may follow
        // up on", so it counts as a touch even though it is not a finding.
        touch(target)
        return
      }
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

    // --- native file-write tools (0.6.0) -----------------------------------
    // v0.5.1 had no branch here at all, so `write_to_file` — the tool the
    // executor uses for most real edits — was audited as if it did nothing:
    // no writeCount, no escape check, no git-metadata check.
    if (isWriteTool(name)) {
      fileWrites += 1
      writeCount += 1
      const rawPath = writeToolPath(args)
      if (rawPath === undefined) return
      const target = resolveVirtualPath(virtualCwd, rawPath)
      classifyWriteTarget(stepIndex, name, target, undefined)
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

      // `extractWriteTargets` exists because `extractPaths` only reports paths
      // that *look* absolute or climbing. `echo x > .git\config` mentions a bare
      // relative path, so 0.5.1 saw no target and no finding — the REQ-05 hole.
      //
      // The two sources are combined asymmetrically on purpose:
      //   - `extractWriteTargets` is authoritative (it only reports write
      //     targets: redirections and write-verb arguments), so it applies to
      //     every command, including one whose verb is not write-shaped
      //     (`echo x > .git\config` has verb `echo`).
      //   - `extractPaths` keeps its 0.5.1 role and only contributes when the
      //     command is write-shaped. Letting it contribute unconditionally would
      //     turn `Get-Content C:\notes.txt` into a `write-outside` finding — a
      //     regression in the escape check's precision.
      const verbTargets = extractWriteTargets(command)
      const candidates = new Set(writeShaped ? [...extractPaths(command), ...verbTargets] : verbTargets)
      // Resolve the directory set through the same cwd as the targets themselves:
      // `mkdir dist` yields the relative token `dist`, while the target resolves
      // to `<cwd>\dist`, so comparing raw spellings would never match. The raw
      // text is passed too: `expandAliases` folds `rd` and `del` into
      // `Remove-Item`, and only `rd` means "a directory".
      const directories = new Set(
        [...directoryTargets(command, raw)].map((relative) =>
          normalizePath(resolveVirtualPath(virtualCwd, relative)),
        ),
      )

      if (writeShaped) writeCount += 1
      // A command that names any write target is a file-write operation even
      // when its verb is not in the write table (`echo x > out.txt`).
      if (writeShaped || candidates.size > 0) fileWrites += 1

      for (const candidate of candidates) {
        const target = resolveVirtualPath(virtualCwd, candidate)
        classifyWriteTarget(stepIndex, name, target, command, directories.has(normalizePath(target)))
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
     *            blockedDestructive: boolean, blockedEscape: boolean,
     *            touchedFiles: string[], fileWrites: number }}
     *   `blocked` is true when this push produced a finding that should stop the
     *   turn under the old (combined) semantics; `blockedDestructive` /
     *   `blockedEscape` split that verdict by granularity so the caller can
     *   cancel on destructive commands even when `failOnEscape` is false (see
     *   {@link classifyFinding}).
     *
     *   `touchedFiles` / `fileWrites` are snapshots, not per-step deltas: the
     *   caller only needs the total, and a delta view would have to be merged by
     *   every consumer to be useful. They are additive (v0.6.0) — no v0.5.1 field
     *   moved or disappeared.
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
        touchedFiles: [...touchedFiles],
        fileWrites,
        blocked: fresh.some((v) => v.severity === 'error'),
        blockedDestructive: fresh.some((v) => v.severity === 'error' && classifyFinding(v.kind) === 'destructive'),
        blockedEscape: fresh.some((v) => v.severity === 'error' && classifyFinding(v.kind) === 'escape'),
      }
    },

    /**
     * The accumulated verdict for the whole turn.
     *
     * v0.6.0 adds two fields (REQ-03 / REQ-07) and keeps the five v0.5.1 fields
     * exactly as they were. `touchedFiles` is what lets the caller re-seed a
     * rebuilt session with "the files this thread was working on"; `fileWrites`
     * is what lets it notice that the executor reported edits while the git
     * worktree stayed clean.
     */
    report() {
      return {
        violations,
        externalReads,
        commandCount,
        writeCount,
        readCount,
        touchedFiles: [...touchedFiles],
        fileWrites,
      }
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

/**
 * Human-readable audit block appended to every delegation result.
 *
 * Two rules govern this renderer, both learned from the v0.6.0 review:
 *   - The `activity` line keeps its exact wording. It is the one line every
 *     downstream reader recognises, and `writeCount` counts *write-shaped
 *     command lines*, not file operations — changing the label to say "file
 *     writes" would make the number mean something it does not measure.
 *   - The closing advice must name the actual hazard. Telling a user "the
 *     executor wrote outside the workspace" when the damage is a `.git/hooks`
 *     write *inside* it sends them looking in the wrong place: the file is
 *     already inside their repo and their next `git status` runs it.
 *
 * @param {object} report - a `createAuditor().report()` result.
 * @param {string} workspace - the workspace the turn was dispatched for.
 * @returns {string}
 */
export function renderAudit(report, workspace) {
  const { violations, externalReads, commandCount, writeCount, readCount } = report
  const touches = Array.isArray(report.touchedFiles) ? report.touchedFiles : []
  const lines = []
  lines.push(`--- workspace audit (soft sandbox) ---`)
  lines.push(`workspace    : ${workspace}`)
  lines.push(
    `activity     : ${commandCount} command(s), ${readCount} read(s), ${writeCount} write-shaped command(s)`,
  )

  if (violations.length === 0) {
    lines.push('verdict      : CLEAN - no out-of-workspace access detected in the transcript')
    // Only worth a line when there *was* file activity: a bare "touched: 0"
    // every turn is noise, and the caller highlights the false-edit case
    // itself (REQ-07). Here it just explains a CLEAN verdict.
    if (touches.length > 0) {
      lines.push(`files touched: ${touches.length} inside the workspace (first ${Math.min(3, touches.length)}: ${touches.slice(0, 3).join(', ')})`)
    }
  } else {
    const errors = violations.filter((v) => v.severity === 'error').length
    lines.push(
      `verdict      : ${errors > 0 ? 'ESCAPED' : 'WARN'} - ${violations.length} finding(s), ${errors} blocking`,
    )
    for (const v of violations) {
      const where = v.path ? ` ${v.path}` : ''
      lines.push(`  [${v.severity}] step ${v.step} ${v.kind}:${where} — ${v.why}`)
      if (
        v.command &&
        (v.kind.startsWith('dangerous:') ||
          v.kind === 'write-outside' ||
          v.kind === 'destructive_git_metadata_write')
      ) {
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
    // The git-metadata hazard gets its own paragraph because it inverts the
    // usual mental model: the file is *inside* the workspace the user trusts.
    const gitHits = violations.filter((v) => v.kind === 'destructive_git_metadata_write')
    if (gitHits.length > 0) {
      lines.push(
        'DANGEROUS GIT METADATA: the executor wrote .git metadata inside the workspace',
        `(${gitHits.map((v) => v.path).filter(Boolean).join(', ')}).`,
        'These paths stay inside the workspace, so they were never an "escape", but a hook or a',
        '`core.hooksPath` / `core.fsmonitor` value written here executes as YOUR user the next time',
        'you run `git status`, `git diff` or `git commit` in this workspace. Do NOT run git in it',
        'until you have inspected and reverted those files by hand.',
      )
    }
    if (violations.some((v) => v.kind !== 'destructive_git_metadata_write' && v.severity === 'error')) {
      lines.push(
        'DO NOT ACCEPT this result as-is: the executor wrote outside the workspace or ran a',
        'dangerous command. Inspect the paths above, revert what should not have changed, and',
        're-dispatch with a tighter task spec before trusting the report.',
      )
    }
  }
  return lines.join('\n')
}
