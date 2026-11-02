/**
 * Pre-turn git snapshot and one-click rollback (REQ-03).
 *
 * WHY THIS EXISTS
 * ---------------
 * A delegated turn can leave the workspace in a state nobody asked for: three
 * files half-rewritten, a stray `debug.js` at the root, an `npm install` that
 * rewrote a lockfile. Before v0.8.0 the only recovery was "git diff, guess, hand
 * revert" — which is exactly the work the supervisor is supposed to remove.
 * So every turn gets a snapshot taken *before* the executor touches anything,
 * and a turn can be undone in one call.
 *
 * WHY IT IS SAFE (the four hard constraints)
 * ------------------------------------------
 * 1. ZERO SIDE EFFECTS. The snapshot is taken with `git stash create`, which only
 *    writes a dangling commit into `.git/objects`. It does not touch the working
 *    tree, the index, or the stash list. `git stash` / `git stash push` /
 *    `git checkout -- .` / `git reset` are never issued for *capture* — those
 *    mutate state and would destroy the very work a snapshot exists to protect.
 *    (Rollback deliberately restores files from the snapshot object; see 3.)
 * 2. A plain folder is not an error. `rev-parse --is-inside-work-tree` failing is
 *    the normal outcome for a non-repo workspace: `{isRepo:false}`, quietly.
 * 3. Rollback only writes inside the workspace. Every target path is `resolve`d
 *    against the workspace root and dropped (into `skipped`) when it escapes.
 * 4. Untracked files are only removed when they are new. A file counts as
 *    removable only if it is untracked *now* **and** absent from the snapshot's
 *    `preUntracked` list. Anything the user had on disk before the turn stays.
 *
 * Every git call goes through an injectable `run(args, {timeoutMs})` so tests can
 * exercise all of the above without a repository, and every call is wrapped so a
 * wedged repo or a throwing runner degrades to data instead of an exception.
 *
 * This module is deliberately dependency-free (only `node:*`) so it can be unit
 * tested on its own, exactly like the other v0.8.0 modules.
 *
 * @module antigravity-executor/lib/snapshot
 */

import { execFile } from 'node:child_process'
import { lstat, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Per-command deadline.
 *
 * Larger than the 3s status probe in `artifacts.js`: `stash create` actually
 * writes the snapshot commit, which on a cold page cache / big tree is several
 * times the cost of reading status. Still small enough that a wedged repo cannot
 * stall a turn for long.
 */
const DEFAULT_GIT_TIMEOUT_MS = 5000

/** Pathspec for "the whole tree" when the caller cannot name the touched files. */
const FULL_TREE = '.'

/** How many untracked names the rendered snapshot block lists before capping. */
const MAX_RENDER_UNTRACKED = 20

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

/**
 * Default runner: `execFile` without a shell, normalised to `{code, stdout, stderr}`.
 *
 * Never throws — a missing `git` binary, a non-zero exit and the timeout kill all
 * arrive as data, so callers never need a try/catch around a probe.
 *
 * @param {string[]} args
 * @param {{timeoutMs: number}} opts
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
      code: typeof error.code === 'number' ? error.code : -1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error?.message ?? error),
    }
  }
}

/**
 * Call an injectable runner and guarantee the `{code, stdout, stderr}` shape.
 *
 * The contract says `run` must never throw, but a caller-supplied fake (or a
 * future refactor) can still reject; swallowing that here keeps the "never
 * throws" promise of the exported functions honest at the single choke point.
 */
async function callRun(run, args, opts) {
  try {
    const result = await run(args, opts)
    if (result === null || typeof result !== 'object') {
      return { code: -1, stdout: '', stderr: 'git runner 返回了非法结果' }
    }
    return {
      code: typeof result.code === 'number' && Number.isFinite(result.code) ? result.code : -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? ''),
      stderr: typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? ''),
    }
  } catch (error) {
    return { code: -1, stdout: '', stderr: String(error?.message ?? error) }
  }
}

/** First non-empty line, so a diagnostic stays one tidy line. */
function firstLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  return line === undefined ? 'git 命令失败' : line
}

/** First whitespace-delimited token (a sha, a `true`, …). */
function firstToken(text) {
  const token = String(text ?? '').trim().split(/\s+/)[0]
  return token === undefined ? '' : token
}

/** Does this failure mean "there is no repository here at all"? */
function isNotARepo(text) {
  return /not a git repository|并非(一个)?\s*git\s*仓库|不是\s*git\s*仓库/i.test(String(text ?? ''))
}

/** Split `-z` output into paths, dropping the trailing empty record. */
function parseZ(stdout) {
  return String(stdout ?? '')
    .split('\0')
    .filter((value) => value !== '')
}

/** Short sha for reports; `null` stays `null` instead of printing "null". */
function shortSha(sha) {
  const text = typeof sha === 'string' ? sha.trim() : ''
  return text === '' ? null : text.slice(0, 7)
}

// ---------------------------------------------------------------------------
// path safety
// ---------------------------------------------------------------------------

/** Normalise a workspace-relative path to git's forward-slash form. */
function toRelPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Comparison key for untracked paths; see `keyOf` note below. */
function pathKey(value) {
  // Deliberately case-insensitive on every platform: the only consumer is the
  // "is this file new?" test, and a false positive here means "don't delete",
  // which is the safe direction. On Windows it is also simply correct.
  return toRelPath(value).toLowerCase()
}

/**
 * Lexical containment test. `abs` must be strictly below `root`.
 *
 * `resolve()` also collapses `..`, so `sub/../../etc/passwd` is caught. Symlinks
 * are not followed: rollback only ever removes a link or restores a path inside
 * the work tree, and git itself refuses to write outside it.
 */
function isInside(root, abs) {
  const rel = relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Resolve a caller- or git-supplied path against the workspace root.
 * @returns {{abs: string, rel: string}|null} null when it escapes the workspace
 */
function resolveInside(root, raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  const abs = resolve(root, text)
  if (!isInside(root, abs)) return null
  return { abs, rel: toRelPath(relative(root, abs)) }
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/**
 * Take a zero-side-effect snapshot of the workspace before a turn starts.
 *
 * Order matters and follows CONTRACT §7.5:
 *   `rev-parse --is-inside-work-tree` → `rev-parse HEAD` → `stash create` →
 *   `ls-files --others --exclude-standard`.
 *
 * `rev-parse HEAD` failing on a freshly `git init`-ed repo is expected (unborn
 * branch): `headSha`/`snapshotSha` stay `null` and rollback degrades to
 * untracked cleanup only.
 *
 * @param {string} workspaceDir
 * @param {{run?: (args: string[], opts: {timeoutMs: number}) =>
 *   Promise<{code: number, stdout: string, stderr: string}>,
 *   timeoutMs?: number}} [opts] `run` is injectable so tests never touch a repo
 * @returns {Promise<{isRepo: boolean, snapshotSha: string|null, headSha: string|null,
 *   preUntracked: string[], workspaceDir?: string, error?: string}>}
 */
export async function capturePreTurnSnapshot(workspaceDir, { run, timeoutMs } = {}) {
  const notRepo = { isRepo: false, snapshotSha: null, headSha: null, preUntracked: [] }
  const workspace = String(workspaceDir ?? '').trim()
  if (workspace === '') return { ...notRepo, error: '未指定工作区目录' }

  const root = resolve(workspace)
  const exec = typeof run === 'function' ? run : execGit
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_GIT_TIMEOUT_MS
  const git = (...args) => callRun(exec, ['-C', workspace, ...args], { timeoutMs: timeout })

  const inside = await git('rev-parse', '--is-inside-work-tree')
  if (inside.code !== 0) {
    // A plain folder is the normal case, so it is a quiet `isRepo:false` rather
    // than an error the caller has to handle. A missing directory or a broken
    // git install is a real problem and keeps its one-line reason.
    if (isNotARepo(`${inside.stderr}${inside.stdout}`)) return notRepo
    return { ...notRepo, error: firstLine(`${inside.stderr}${inside.stdout}`) }
  }
  // `--is-inside-work-tree` prints `false` inside `.git` and in a bare repo.
  if (String(inside.stdout).trim() !== 'true') return notRepo

  const head = await git('rev-parse', 'HEAD')
  const headSha = head.code === 0 ? firstToken(head.stdout) || null : null

  let snapshotSha = null
  let error
  if (headSha !== null) {
    // `stash create` writes ONE dangling commit and nothing else: no working
    // tree, index or stash-list mutation. On a clean tree it prints nothing.
    const stash = await git('stash', 'create')
    const sha = stash.code === 0 ? firstToken(stash.stdout) : ''
    snapshotSha = sha === '' ? headSha : sha
    if (stash.code !== 0) error = firstLine(`${stash.stderr}${stash.stdout}`)
  }

  // `ls-files` reports paths relative to the `-C` directory, which is what every
  // rollback call uses too, so the list needs no rebasing.
  const untracked = await git('ls-files', '--others', '--exclude-standard', '-z')
  const preUntracked = untracked.code === 0 ? parseZ(untracked.stdout) : []
  if (untracked.code !== 0 && error === undefined) error = firstLine(`${untracked.stderr}${untracked.stdout}`)

  const snapshot = { isRepo: true, snapshotSha, headSha, preUntracked, workspaceDir: root }
  if (error !== undefined) snapshot.error = error
  return snapshot
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

/**
 * Remove one file that the turn created, refusing anything that is not inside
 * the workspace or that is a directory.
 *
 * `lstat` (not `stat`) so a symlink is judged as a link: deleting it removes the
 * link itself, never its target.
 */
async function removeFileInside(root, abs) {
  if (!isInside(root, abs)) return { ok: false, reason: '越界跳过（不在工作区内）' }
  try {
    const info = await lstat(abs)
    if (info.isDirectory()) return { ok: false, reason: '目标是目录，拒绝删除' }
    await rm(abs, { force: true })
    return { ok: true }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: '文件已不存在' }
    return { ok: false, reason: `删除失败: ${firstLine(error?.message ?? error)}` }
  }
}

/**
 * Undo one turn.
 *
 * Tracked files named in `touchedFiles` are restored from the snapshot object
 * (`checkout <snapshotSha> -- <path>`); when the caller cannot name them the
 * whole tree is restored from the snapshot. Untracked files are removed only
 * when they are new since the snapshot — see constraint 4 in the file header.
 *
 * `ok` means "ran to completion". Policy skips (out of workspace, pre-existing
 * untracked, `removeUntracked:false`, untracked at snapshot time, empty
 * snapshot) do not clear it; an actual git failure or a failed deletion does.
 *
 * @param {string} workspaceDir
 * @param {{isRepo?: boolean, snapshotSha?: string|null, headSha?: string|null,
 *   preUntracked?: string[]}} snapshot result of `capturePreTurnSnapshot`
 * @param {{run?: Function, touchedFiles?: string[], removeUntracked?: boolean,
 *   timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, restoredFiles: string[],
 *   removedUntracked: string[], skipped: string[], error?: string}>}
 */
export async function rollbackTurn(workspaceDir, snapshot, { run, touchedFiles, removeUntracked = true, timeoutMs } = {}) {
  const failed = { ok: false, restoredFiles: [], removedUntracked: [], skipped: [] }
  const workspace = String(workspaceDir ?? '').trim()
  if (workspace === '') return { ...failed, error: '未指定工作区目录' }

  const snap = snapshot !== null && typeof snapshot === 'object' ? snapshot : null
  if (snap === null) return { ...failed, error: '缺少回合前快照，无法回滚' }
  if (snap.isRepo !== true) {
    // Nothing was recorded, so there is nothing to restore and nothing to delete.
    return { ok: true, restoredFiles: [], removedUntracked: [], skipped: ['工作区不是 git 仓库，跳过回滚'] }
  }

  const root = resolve(workspace)
  const exec = typeof run === 'function' ? run : execGit
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_GIT_TIMEOUT_MS
  const git = (...args) => callRun(exec, ['-C', workspace, ...args], { timeoutMs: timeout })

  const restoredFiles = []
  const removedUntracked = []
  const skipped = []
  let hardFailure = false

  // --- 1. restore version-controlled files ---------------------------------
  const snapshotSha = typeof snap.snapshotSha === 'string' ? snap.snapshotSha.trim() : ''
  const touched = Array.isArray(touchedFiles) ? touchedFiles : []

  if (snapshotSha === '') {
    // Empty repository (no HEAD) or a capture that produced no object: there is
    // nothing to check out, so the turn can only be undone at the untracked level.
    skipped.push('快照为空（空仓库无 HEAD）：跳过 checkout，只清理本轮新增的未跟踪文件')
  } else {
    // Resolve + de-duplicate first: a path outside the workspace must never
    // reach git, and duplicates would cost one checkout each.
    const targets = []
    const seen = new Set()
    for (const entry of touched) {
      if (typeof entry !== 'string') continue
      const target = resolveInside(root, entry)
      if (target === null) {
        const text = String(entry).trim()
        if (text !== '') skipped.push(`越界跳过（不在工作区内）: ${text}`)
        continue
      }
      if (seen.has(target.rel)) continue
      seen.add(target.rel)
      targets.push(target)
    }

    if (targets.length === 0) {
      // No file list to work from: restore the whole tree from the snapshot.
      // Untracked files are not touched by this pathspec, so constraint 4 holds.
      const res = await git('--literal-pathspecs', 'checkout', snapshotSha, '--', FULL_TREE)
      if (res.code === 0) restoredFiles.push(FULL_TREE)
      else {
        hardFailure = true
        skipped.push(`整树 checkout 失败: ${firstLine(`${res.stderr}${res.stdout}`)}`)
      }
    } else {
      for (const target of targets) {
        // Only restore what the snapshot actually contains as a tracked path.
        // Anything else is either brand new this turn (handled below) or was
        // never version-controlled, and `checkout` would fail noisily on it.
        const tracked = await git('--literal-pathspecs', 'ls-tree', '-z', snapshotSha, '--', target.rel)
        const isTracked = tracked.code === 0 && String(tracked.stdout).length > 0
        if (!isTracked) {
          skipped.push(`快照时未受版本控制，跳过恢复: ${target.rel}`)
          continue
        }
        const res = await git('--literal-pathspecs', 'checkout', snapshotSha, '--', target.rel)
        if (res.code === 0) restoredFiles.push(target.rel)
        else {
          hardFailure = true
          skipped.push(`恢复失败: ${target.rel} (${firstLine(`${res.stderr}${res.stdout}`)})`)
        }
      }
    }
  }

  // --- 2. remove untracked files the turn created ---------------------------
  // Listed *after* the checkout so files the checkout just restored are no
  // longer untracked and cannot be mistaken for new ones.
  const preUntracked = new Set(
    (Array.isArray(snap.preUntracked) ? snap.preUntracked : []).map((value) => pathKey(value)),
  )
  const current = await git('ls-files', '--others', '--exclude-standard', '-z')
  if (current.code !== 0) {
    hardFailure = true
    skipped.push(`无法列出未跟踪文件: ${firstLine(`${current.stderr}${current.stdout}`)}`)
  } else {
    for (const raw of parseZ(current.stdout)) {
      const target = resolveInside(root, raw)
      if (target === null) {
        skipped.push(`越界跳过（不在工作区内）: ${raw}`)
        continue
      }
      // Constraint 4: a file the user already had on disk is never deleted —
      // even when the caller insists, even when it is "just a scratch file".
      if (preUntracked.has(pathKey(target.rel))) continue
      if (removeUntracked !== true) {
        skipped.push(`保留（removeUntracked=false）: ${target.rel}`)
        continue
      }
      const removal = await removeFileInside(root, target.abs)
      if (removal.ok) removedUntracked.push(target.rel)
      else {
        if (!removal.reason.startsWith('越界')) hardFailure = true
        skipped.push(`${target.rel}: ${removal.reason}`)
      }
    }
  }

  const result = { ok: !hardFailure, restoredFiles, removedUntracked, skipped }
  if (hardFailure) result.error = '部分文件未能从快照完整恢复，详见 skipped'
  return result
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * Render the snapshot for the delegation report / UI.
 * @param {object|undefined} snapshot
 * @returns {string|undefined} undefined when there is no repository
 */
export function renderSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  if (snapshot.isRepo !== true) return undefined

  const untracked = Array.isArray(snapshot.preUntracked) ? snapshot.preUntracked : []
  const headSha = shortSha(snapshot.headSha)
  const snapshotSha = shortSha(snapshot.snapshotSha)
  const lines = ['--- 回合前 Git 快照（零副作用，可一键回滚）---']

  if (snapshotSha === null) {
    lines.push('snapshot     : (空仓库无 HEAD，未生成快照对象，回滚只能清理未跟踪文件)')
  } else if (typeof snapshot.snapshotSha === 'string' && snapshot.snapshotSha.trim() === String(snapshot.headSha ?? '').trim()) {
    lines.push(`snapshot     : ${snapshotSha}（工作区干净，快照即 HEAD）`)
  } else {
    lines.push(`snapshot     : ${snapshotSha}（dangling 对象，stash create 生成，未进 stash list）`)
  }
  lines.push(`head         : ${headSha ?? '(无提交)'}`)
  lines.push(`preUntracked : ${untracked.length} 个盘前未跟踪文件（回滚时一律保留，不删）`)
  for (const file of untracked.slice(0, MAX_RENDER_UNTRACKED)) lines.push(`  ?? ${file}`)
  if (untracked.length > MAX_RENDER_UNTRACKED) {
    lines.push(`  … (${untracked.length - MAX_RENDER_UNTRACKED} more)`)
  }
  if (snapshot.error !== undefined) lines.push(`注意         : ${snapshot.error}`)
  return lines.join('\n')
}

/**
 * Render a rollback result. Always returns text so the caller can print it
 * unconditionally after a rollback request.
 * @param {object|undefined} result
 * @returns {string}
 */
export function renderRollback(result) {
  const data = result !== null && typeof result === 'object' ? result : {}
  const restored = Array.isArray(data.restoredFiles) ? data.restoredFiles : []
  const removed = Array.isArray(data.removedUntracked) ? data.removedUntracked : []
  const skipped = Array.isArray(data.skipped) ? data.skipped : []

  const lines = ['--- 回滚结果 ---']
  lines.push(
    `status       : ${data.ok === true ? '完成' : '未完成'}（${restored.length} 恢复 / ${removed.length} 删除 / ${skipped.length} 跳过）`,
  )

  if (restored.length > 0) {
    lines.push('restored     :')
    for (const file of restored) {
      lines.push(file === FULL_TREE ? '  ✅ 整树恢复（checkout <snapshot> -- .）' : `  ✅ ${file}`)
    }
  }
  if (removed.length > 0) {
    lines.push('removed      :')
    for (const file of removed) lines.push(`  🗑 ${file}`)
  }
  if (skipped.length > 0) {
    lines.push('skipped      :')
    for (const note of skipped) lines.push(`  ⏭ ${note}`)
  }
  if (restored.length === 0 && removed.length === 0 && skipped.length === 0) {
    lines.push('changes      : 没有需要回滚的改动（工作区与快照一致）')
  }
  if (data.error !== undefined) lines.push(`error        : ${data.error}`)
  return lines.join('\n')
}
