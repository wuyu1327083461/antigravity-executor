/**
 * Git worktree deadlock pre-check and Antigravity brain artifact collection
 * (REQ-07).
 *
 * WHY THE WORKTREE CHECK EXISTS
 * -----------------------------
 * With `extensions.worktreeConfig = true`, git keeps `core.worktree` and
 * `core.bare` in a per-worktree config file. The Antigravity executor runs
 * `git` commands from a shell whose working directory it does not fully control
 * (agentapi conversations are not workspace-bound), so a `git` invocation that
 * resolves the wrong worktree can block on `.git/index.lock` or refuse every
 * command with "fatal: not a git repository". The pre-check surfaces that
 * configuration *before* a delegation starts, with the exact command that turns
 * it off.
 *
 * WHY BRAIN ARTIFACTS ARE COLLECTED
 * --------------------------------
 * Antigravity writes `walkthrough.md`, `implementation_plan.md`, `task.md` …
 * into the conversation's brain directory. Those are the executor's own
 * structured report and are often better than the chat transcript, so they are
 * harvested (with a size-capped summary) and appended to the delegation result.
 *
 * @module antigravity-executor/lib/artifacts
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DEFAULT_MAX_FILES = 8
const DEFAULT_SUMMARY_CHARS = 600
/**
 * Above this many bytes, an artifact is summarised instead of inlined (v0.5.0).
 *
 * WHY A SECOND THRESHOLD
 * ----------------------
 * 0.4.0 collected brain artifacts with a fixed 600-character summary, which is
 * fine for a short `task.md` and useless for a 40KB `walkthrough.md` — yet even
 * that summary is inlined on *every* delegation, and 0.4.0 also turned on the
 * full transcript. Three or four delegations of a complex task can then push
 * tens of kilobytes of executor prose into the planner's context, which costs
 * money, slows reasoning and dilutes attention.
 *
 * The rule is "audit in full, report compactly": the auditor and the final
 * report still read the whole `transcript_full.jsonl`, but a large artifact is
 * returned as its head plus its absolute path, so the planner can `read_file`
 * the rest only when it actually needs the detail.
 */
const DEFAULT_MAX_INLINE_CHARS = 4000
/** How much of an oversized artifact is still inlined. */
const DEFAULT_OVERSIZE_HEAD_CHARS = 2000
/** Only the report-shaped markdown files are worth harvesting. */
const ARTIFACT_EXT = '.md'

/** `~/.gemini/antigravity/brain` — the measured brain root. */
export function brainRoot() {
  return join(homedir(), '.gemini', 'antigravity', 'brain')
}

/** Absolute path of one conversation's brain directory. */
export function brainDir(conversationId) {
  return join(brainRoot(), String(conversationId))
}

/**
 * Read the first non-empty line of a git "pointer" file.
 *
 * `.git` (linked worktree / submodule) uses `gitdir: <path>`; `commondir` holds
 * a bare relative path with no prefix. Both are accepted here.
 * @returns {string|undefined} the raw path, un-resolved
 */
function parsePointerPath(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (line === undefined) return undefined
  const match = /^gitdir:\s*(.+)$/i.exec(line)
  return match === null ? line : match[1].trim()
}

/**
 * Read `extensions.worktreeConfig` out of a git config file.
 *
 * Git's config syntax allows several spellings, all of which are honoured:
 *   `[extensions]` + `worktreeConfig = true`   (the normal form)
 *   `[extensions "worktreeconfig"]`            (legacy quoted form)
 *   `[extensions] worktreeconfig = true` on one line
 *
 * @returns {'true'|'false'|undefined} undefined when the file does not set it
 */
export function parseWorktreeConfig(text) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)

  let inExtensions = false
  let value

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue

    // A new section header closes the previous one.
    const header = /^\[\s*([^\]"]+?)\s*(?:"[^"]*")?\s*\]$/.exec(line)
    if (header !== null) {
      inExtensions = header[1].trim().toLowerCase() === 'extensions'
      continue
    }
    if (!inExtensions) continue

    const pair = /^(\S+)\s*=\s*(.*)$/.exec(line)
    if (pair === null) {
      // Bare key means boolean true in git config.
      if (line.toLowerCase() === 'worktreeconfig') value = 'true'
      continue
    }
    if (pair[1].toLowerCase() !== 'worktreeconfig') continue
    value = pair[2].trim().replace(/^"(.*)"$/, '$1').toLowerCase()
  }

  if (value === undefined) return undefined
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return 'true'
  return 'false'
}

/** Read a file, returning undefined when it is absent or unreadable. */
async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** True when the path exists and is a regular file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Check whether a workspace has the worktree-config extension enabled.
 *
 * Handles all three layouts:
 *   - `.git` directory (ordinary checkout)          -> `.git/config`
 *   - `.git` file (linked worktree / submodule)     -> the pointed-at gitdir's
 *     `config` and, when `commondir` exists, the common repo's `config`
 *
 * @param {string} workspaceDir
 * @returns {Promise<{worktreeConfig: boolean, configPath: string|undefined, warning?: string}>}
 */
export async function checkWorktreeConfig(workspaceDir) {
  const workspace = resolve(String(workspaceDir ?? ''))
  if (String(workspaceDir ?? '').trim() === '') {
    return { worktreeConfig: false, configPath: undefined, warning: '未指定工作区目录，跳过 git worktree 预检。' }
  }

  const dotGit = join(workspace, '.git')
  let configPaths = []
  let gitFound = false

  if (await isFile(dotGit)) {
    gitFound = true
    const pointer = parsePointerPath(await readIfPresent(dotGit))
    if (pointer !== undefined) {
      // A relative pointer is resolved against the workspace that contains it.
      const gitdir = resolve(workspace, pointer)
      configPaths.push(join(gitdir, 'config'))

      // A linked worktree keeps its real config in the common dir, referenced
      // by a `commondir` file holding a (usually relative) path.
      const commonRelative = parsePointerPath(await readIfPresent(join(gitdir, 'commondir')))
      if (commonRelative !== undefined) {
        configPaths.push(join(resolve(gitdir, commonRelative), 'config'))
      }
    }
  } else {
    const dirConfig = join(dotGit, 'config')
    if (await isFile(dirConfig)) {
      gitFound = true
      configPaths.push(dirConfig)
    }
  }

  // De-duplicate while preserving order (the worktree config is consulted first).
  configPaths = [...new Set(configPaths)]

  if (!gitFound) {
    return {
      worktreeConfig: false,
      configPath: undefined,
      warning: `工作区不是 git 仓库（未找到 ${dotGit}），已跳过 worktree 预检。`,
    }
  }

  let enabledPath
  for (const path of configPaths) {
    const text = await readIfPresent(path)
    if (text === undefined) continue
    if (parseWorktreeConfig(text) === 'true') {
      enabledPath = path
      break
    }
  }

  if (enabledPath === undefined) {
    return { worktreeConfig: false, configPath: configPaths[0] }
  }

  return {
    worktreeConfig: true,
    configPath: enabledPath,
    warning:
      `检测到 git 配置启用了 extensions.worktreeConfig（${enabledPath}）。\n` +
      '该配置会让执行器在错误的 worktree 上运行 git 命令，可能造成 .git/index.lock 死锁或 ' +
      '「fatal: not a git repository」。\n' +
      `建议先执行：git config --unset extensions.worktreeConfig\n` +
      `（工作目录：${workspace}）`,
  }
}

// ---------------------------------------------------------------------------
// workspace git snapshot (REQ-07)
// ---------------------------------------------------------------------------

/** Per-command deadline for the snapshot; a wedged repo must not stall a turn. */
const DEFAULT_GIT_TIMEOUT_MS = 3000
/**
 * How many lines of each command are reported.
 *
 * WHY A CAP AT ALL
 * ----------------
 * `git status --porcelain` on a generated-output tree or a vendored `node_modules`
 * can print thousands of lines. Inlining that into the delegation result would
 * push the planner's context (and its token bill) over the edge for information
 * it will almost never read past the first screen. The count fields stay exact,
 * so the caller still knows the true size of the change.
 */
const DEFAULT_GIT_MAX_LINES = 40

/**
 * Default executor: `execFile` without a shell, resolved to a uniform shape.
 *
 * Never throws — a failure (including the timeout kill) is reported as a
 * non-zero `code` plus whatever output arrived, matching the pattern
 * `checkWorktreeConfig` already relies on for its own probes.
 *
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function execGit(args, { timeoutMs }) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error?.message ?? error),
    }
  }
}

/** Cap a block of text at `maxLines`, marking how much was withheld. */
function capLines(text, maxLines) {
  const lines = String(text ?? '').replace(/\s+$/, '').split(/\r?\n/)
  if (lines.length === 1 && lines[0] === '') return ''
  // `0` (or a negative value) means "do not cap": the caller asked for all of it.
  if (!Number.isFinite(maxLines) || maxLines <= 0 || lines.length <= maxLines) return lines.join('\n')
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join('\n')
}

/** Count porcelain entries: `??` is untracked, everything else is a change. */
function countPorcelain(status) {
  let changed = 0
  let untracked = 0
  for (const line of String(status ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    if (line.startsWith('??')) untracked += 1
    else changed += 1
  }
  return { changed, untracked }
}

/** Does this failure mean "there is no repository here at all"? */
function isNotARepo(text) {
  return /not a git repository|并非(一个)?\s*git\s*仓库/i.test(String(text ?? ''))
}

/**
 * Read the workspace's git state, so the delegation result can carry it.
 *
 * WHY THIS EXISTS (REQ-07)
 * ------------------------
 * After every delegation the planner had to spend a whole extra tool round on
 * `git status` + `git diff --stat` just to see whether anything changed — and
 * that round was also the only way to catch an executor that reports success
 * without touching a file. Running two read-only commands here costs one round
 * trip *inside* a turn that was already happening.
 *
 * Read-only by construction: `status --porcelain` and `diff --stat` never write
 * to the index or the working tree, so this can run even while the executor
 * still holds the repo.
 *
 * Every failure mode degrades instead of throwing: a non-repo, a missing `git`
 * binary, a timeout, or a wedged index all come back as data (with `error` set),
 * because a delegation must never be blocked by its own status probe.
 *
 * @param {string} workspaceDir
 * @param {{timeoutMs?: number, maxLines?: number,
 *   run?: (args: string[], opts: {timeoutMs: number}) => Promise<{code: number,
 *   stdout: string, stderr: string}>}} [opts] `run` is injectable so tests never
 *   touch a real repository
 * @returns {Promise<{isRepo: boolean, status: string, diffStat: string,
 *   changed: number, untracked: number, error?: string}>} `changed`/`untracked`
 *   are always numbers when `isRepo` is true, so `changed === 0 && untracked === 0`
 *   is a safe clean check.
 */
export async function readGitSummary(workspaceDir, { timeoutMs = DEFAULT_GIT_TIMEOUT_MS, maxLines = DEFAULT_GIT_MAX_LINES, run } = {}) {
  const empty = { isRepo: false, status: '', diffStat: '', changed: 0, untracked: 0 }
  const workspace = String(workspaceDir ?? '').trim()
  if (workspace === '') return { ...empty, error: '未指定工作区目录' }

  const exec = typeof run === 'function' ? run : (args, opts) => execGit(args, opts)
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_GIT_TIMEOUT_MS
  const cap = Number.isFinite(Number(maxLines)) && Number(maxLines) >= 0
    ? Math.trunc(Number(maxLines))
    : DEFAULT_GIT_MAX_LINES

  const base = ['-C', workspace]
  const statusResult = await exec([...base, 'status', '--porcelain'], { timeoutMs: timeout })
  const diffResult = await exec([...base, 'diff', '--stat'], { timeoutMs: timeout })
  const statusStderr = `${statusResult.stderr ?? ''}${statusResult.stdout ?? ''}`

  // "Not a git repository" is the normal outcome for a plain folder, so it is a
  // quiet `isRepo: false` rather than an error the caller must handle. Without
  // the status list there is nothing to report, so this is the one fatal case.
  if (statusResult.code !== 0 && isNotARepo(statusStderr)) return empty
  if (statusResult.code !== 0) return { ...empty, error: firstLine(statusStderr) }

  const status = capLines(statusResult.stdout, cap)
  const diffStat = capLines(diffResult.stdout, cap)
  const { changed, untracked } = countPorcelain(statusResult.stdout)

  const summary = { isRepo: true, status, diffStat, changed, untracked }
  // A failing `diff --stat` alone leaves the more useful status list intact, so
  // the snapshot is still delivered — with the reason it is partial.
  if (diffResult.code !== 0) summary.error = firstLine(`${diffResult.stderr ?? ''}${diffResult.stdout ?? ''}`)
  return summary
}

/** First non-empty line of a message, so an error stays one tidy line. */
function firstLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  return line === undefined ? 'git 命令失败' : line
}

/**
 * Render the git snapshot as a report block for the delegation result.
 *
 * Chinese, matching every other user-facing line in this plugin. The header
 * states the purpose outright ("无需再跑 git status") because the whole point is
 * to stop the planner from spending an extra round on the same information.
 *
 * @param {{isRepo?: boolean, status?: string, diffStat?: string, changed?: number,
 *   untracked?: number, error?: string}|undefined} summary
 * @returns {string|undefined} the block, or undefined when there is no repo
 */
export function renderGitSummary(summary) {
  if (summary === null || typeof summary !== 'object') return undefined
  if (summary.isRepo !== true) return undefined

  const changed = Number.isFinite(Number(summary.changed)) ? Number(summary.changed) : 0
  const untracked = Number.isFinite(Number(summary.untracked)) ? Number(summary.untracked) : 0
  // Trailing whitespace only: git's leading columns carry the status code pair
  // (`" M"` unstaged, `"M "` staged) and `diff --stat` pads names to align, so a
  // plain `trim()` would silently rewrite the data this block exists to show.
  const status = String(summary.status ?? '').replace(/\s+$/, '')
  const diffStat = String(summary.diffStat ?? '').replace(/\s+$/, '')

  const lines = ['--- 工作区 Git 快照（无需再跑 git status）---']
  // The two counts are exact even when the listing below is capped, so this line
  // is the one a caller may rely on to decide "did anything change at all?".
  lines.push(`branch/state : ${changed} modified, ${untracked} untracked`)

  if (status === '') {
    lines.push('status       : clean (工作区无改动或未跟踪文件)')
  } else {
    lines.push('status --porcelain:')
    for (const line of status.split(/\r?\n/)) lines.push(`  ${line}`)
  }

  if (diffStat !== '') {
    lines.push('diff --stat:')
    for (const line of diffStat.split(/\r?\n/)) lines.push(`  ${line}`)
  }

  if (summary.error !== undefined) lines.push(`注意         : ${summary.error}`)
  return lines.join('\n')
}

/**
 * Collect the root-level `.md` artifacts of one conversation's brain directory.
 *
 * Only files directly in `brain/<conversationId>/` are returned: `.system_generated`
 * (logs and task dumps) and every subdirectory are excluded by construction, so
 * the result is exactly the executor's own report files.
 *
 * A missing brain directory is normal (the conversation may have produced no
 * artifacts) and yields `[]` — never an error.
 *
 * INLINE POLICY (v0.5.0)
 * ----------------------
 *   - file ≤ `maxInlineChars`     -> `summary` is the whole text, `inline: true`
 *   - file >  `maxInlineChars`     -> `summary` is its head (`oversizeHeadChars`),
 *                                    `inline: false`, `chars`/`bytes` say how much
 *                                    was withheld, and `path` is the absolute file
 *                                    the planner can read for the rest.
 *
 * `path` is always absolute and always present, so the caller never has to guess
 * where an artifact lives.
 *
 * @param {string} conversationId
 * @param {{sinceMs?: number, maxFiles?: number, summaryChars?: number,
 *          maxInlineChars?: number, oversizeHeadChars?: number, now?: number}} [opts]
 * @returns {Promise<Array<{name: string, path: string, bytes: number, chars: number,
 *   updatedAt: string, summary: string, inline: boolean}>>}
 */
export async function collectBrainArtifacts(
  conversationId,
  {
    sinceMs = 0,
    maxFiles = DEFAULT_MAX_FILES,
    summaryChars = DEFAULT_SUMMARY_CHARS,
    maxInlineChars = DEFAULT_MAX_INLINE_CHARS,
    oversizeHeadChars = DEFAULT_OVERSIZE_HEAD_CHARS,
    now,
  } = {},
) {
  const id = String(conversationId ?? '').trim()
  if (id === '') return []

  const dir = brainDir(id)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // No brain directory (or no permission): nothing to harvest.
    return []
  }

  const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0
  const cap = Number.isFinite(Number(maxFiles)) && Number(maxFiles) > 0 ? Math.trunc(Number(maxFiles)) : DEFAULT_MAX_FILES
  const chars =
    Number.isFinite(Number(summaryChars)) && Number(summaryChars) >= 0
      ? Math.trunc(Number(summaryChars))
      : DEFAULT_SUMMARY_CHARS
  const inlineCap =
    Number.isFinite(Number(maxInlineChars)) && Number(maxInlineChars) >= 0
      ? Math.trunc(Number(maxInlineChars))
      : DEFAULT_MAX_INLINE_CHARS
  const headChars =
    Number.isFinite(Number(oversizeHeadChars)) && Number(oversizeHeadChars) > 0
      ? Math.trunc(Number(oversizeHeadChars))
      : DEFAULT_OVERSIZE_HEAD_CHARS

  const rows = []
  for (const entry of entries) {
    // Root-level regular files only; `.system_generated` is a directory, so it
    // is excluded here rather than by a name blacklist.
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith(ARTIFACT_EXT)) continue

    const full = join(dir, entry.name)
    let info
    try {
      info = await stat(full)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    if (since > 0 && info.mtimeMs < since) continue

    let text = ''
    try {
      text = await readFile(full, 'utf8')
    } catch {
      text = ''
    }
    const totalChars = text.length
    const oversized = totalChars > inlineCap
    // `summaryChars` is the caller's explicit "how much prose may I afford"
    // knob. When it is left at its default, an oversized artifact gets the
    // oversize head instead — otherwise the 600-char default would silently
    // clamp the very summary this policy exists to produce.
    const explicitBudget = Number(summaryChars) !== DEFAULT_SUMMARY_CHARS
    let summary = ''
    if (oversized) {
      const head = explicitBudget && chars > 0 ? Math.min(headChars, chars) : headChars
      summary = text.slice(0, head).trim()
    } else if (chars > 0) {
      summary = text.slice(0, chars).trim()
    }
    // Inlined only when the whole text reached the caller unchanged.
    const inline = oversized === false && chars > 0 && summary.length >= text.trim().length

    rows.push({
      name: entry.name,
      path: full,
      bytes: info.size,
      chars: totalChars,
      updatedAt: new Date(info.mtimeMs).toISOString(),
      summary,
      inline,
      // Internal sort key; stripped before returning so the public shape stays
      // exactly `{name, path, bytes, chars, updatedAt, summary, inline}`.
      _mtime: info.mtimeMs,
    })
  }

  // Newest first: a long conversation's most recent report is the relevant one.
  rows.sort((a, b) => b._mtime - a._mtime)
  return rows.slice(0, cap).map(({ _mtime, ...rest }) => rest)
}
