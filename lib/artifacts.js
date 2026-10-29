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

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const DEFAULT_MAX_FILES = 8
const DEFAULT_SUMMARY_CHARS = 600
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
 * @param {string} conversationId
 * @param {{sinceMs?: number, maxFiles?: number, summaryChars?: number, now?: number}} [opts]
 * @returns {Promise<Array<{name: string, path: string, bytes: number, updatedAt: string, summary: string}>>}
 */
export async function collectBrainArtifacts(
  conversationId,
  { sinceMs = 0, maxFiles = DEFAULT_MAX_FILES, summaryChars = DEFAULT_SUMMARY_CHARS, now } = {},
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

    let summary = ''
    if (chars > 0) {
      try {
        summary = (await readFile(full, 'utf8')).slice(0, chars).trim()
      } catch {
        summary = ''
      }
    }

    rows.push({
      name: entry.name,
      path: full,
      bytes: info.size,
      updatedAt: new Date(info.mtimeMs).toISOString(),
      summary,
      // Internal sort key; stripped before returning so the public shape stays
      // exactly `{name, path, bytes, updatedAt, summary}`.
      _mtime: info.mtimeMs,
    })
  }

  // Newest first: a long conversation's most recent report is the relevant one.
  rows.sort((a, b) => b._mtime - a._mtime)
  return rows.slice(0, cap).map(({ _mtime, ...rest }) => rest)
}
