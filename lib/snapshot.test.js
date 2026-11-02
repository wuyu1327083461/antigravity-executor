/**
 * Tests for the pre-turn snapshot and rollback module (REQ-03).
 *
 * Two layers, on purpose:
 *
 * 1. **Scripted runners.** Every git call is injectable, so the safety rules
 *    (never leave the workspace, never delete a pre-existing untracked file,
 *    never run a mutating git command while capturing) are asserted against the
 *    exact argv we issue — no repository required, and a violation is visible.
 * 2. **A real repository.** Rules can look right in a fake and still fail on
 *    git's actual output (NUL-separated paths, unborn HEAD, CRLF on Windows,
 *    paths with spaces). The last block drives the module against a throwaway
 *    `git init` repo in a directory whose name contains a space.
 *
 * Run: node --test lib/snapshot.test.js
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  capturePreTurnSnapshot,
  renderRollback,
  renderSnapshot,
  rollbackTurn,
} from './snapshot.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Create a throwaway directory, removed when the test finishes. */
async function scratch(t, prefix = 'agy-snapshot-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Runner that records every argv and answers from a handler. */
function scriptedRun(handler) {
  const calls = []
  const run = async (args, opts) => {
    calls.push(args)
    const result = await handler(args, opts)
    return result ?? { code: 0, stdout: '', stderr: '' }
  }
  run.calls = calls
  /** All recorded calls joined for substring assertions. */
  run.text = () => calls.map((args) => args.join(' '))
  return run
}

const reply = (code, stdout = '', stderr = '') => ({ code, stdout, stderr })

/** Build the four responses `capturePreTurnSnapshot` asks for. */
function captureReplies(overrides = {}) {
  return {
    inside: reply(0, 'true\n'),
    head: reply(0, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'),
    stash: reply(0, ''),
    lsFiles: reply(0, ''),
    ...overrides,
  }
}

/**
 * Runner for `capturePreTurnSnapshot`, dispatching on the sub-command.
 * Order in the module is fixed: is-inside-work-tree → HEAD → stash create →
 * ls-files, so the recorded call list doubles as an order assertion.
 */
function captureRunner(replies = captureReplies(), extra = () => undefined) {
  return scriptedRun((args) => {
    const line = args.join(' ')
    if (line.includes('--is-inside-work-tree')) return replies.inside
    if (line.includes('rev-parse HEAD')) return replies.head
    if (line.includes('stash create')) return replies.stash
    if (line.includes('ls-files')) {
      const value = replies.lsFiles
      if (typeof value === 'function') return value(args)
      return value
    }
    return extra(args)
  })
}

/** Runner for `rollbackTurn`: `ls-tree`/`checkout`/`ls-files` lookups. */
function rollbackRunner({ tracked = [], untracked = [], checkoutCode = 0, lsFilesCode = 0 } = {}) {
  const trackedSet = new Set(tracked)
  return scriptedRun((args) => {
    const line = args.join(' ')
    if (line.includes('ls-files')) {
      if (lsFilesCode !== 0) return reply(lsFilesCode, '', 'fatal: index.lock exists')
      const out = untracked.length === 0 ? '' : `${untracked.join('\0')}\0`
      return reply(0, out)
    }
    if (line.includes('ls-tree')) {
      const rel = args[args.length - 1]
      return reply(0, trackedSet.has(rel) ? `100644 blob deadbeef\t${rel}\0` : '')
    }
    if (line.includes('checkout')) return reply(checkoutCode, '', checkoutCode === 0 ? '' : 'fatal: did not match any file')
    return reply(0, '')
  })
}

/** Collect the sub-commands a runner saw, without the `-C <dir>` prefix. */
function commands(run) {
  return run.calls.map((args) => {
    const rest = args.slice(0)
    // Drop `-C`, its value, and global option prefixes to get the real verb.
    const index = rest.indexOf('-C')
    return (index >= 0 ? rest.slice(index + 2) : rest).join(' ')
  })
}

const SNAPSHOT_SHA = 'b'.repeat(40)

// ---------------------------------------------------------------------------
// capturePreTurnSnapshot
// ---------------------------------------------------------------------------

test('capture: a plain folder is quiet {isRepo:false}, not an error', async () => {
  const run = captureRunner(captureReplies({
    inside: reply(128, '', 'fatal: not a git repository (or any of the parent directories): .git'),
  }))
  const snapshot = await capturePreTurnSnapshot('/tmp/plain-folder', { run })

  assert.equal(snapshot.isRepo, false)
  assert.equal(snapshot.snapshotSha, null)
  assert.equal(snapshot.headSha, null)
  assert.deepEqual(snapshot.preUntracked, [])
  assert.equal(snapshot.error, undefined)
  // Detection only: nothing may be written when there is no repository.
  assert.deepEqual(commands(run), ['rev-parse --is-inside-work-tree'])
})

test('capture: a bare repo / .git dir reports isRepo:false without an error', async () => {
  const run = captureRunner(captureReplies({ inside: reply(0, 'false\n') }))
  const snapshot = await capturePreTurnSnapshot('/tmp/bare.git', { run })
  assert.equal(snapshot.isRepo, false)
  assert.equal(snapshot.error, undefined)
})

test('capture: an unreachable workspace keeps its one-line reason', async () => {
  const run = captureRunner(captureReplies({
    inside: reply(128, '', 'fatal: cannot change to /nope: No such file or directory'),
  }))
  const snapshot = await capturePreTurnSnapshot('/nope', { run })
  assert.equal(snapshot.isRepo, false)
  assert.match(snapshot.error, /cannot change to/)
})

test('capture: an empty workspace argument is rejected before any git call', async () => {
  const run = captureRunner()
  const snapshot = await capturePreTurnSnapshot('   ', { run })
  assert.equal(snapshot.isRepo, false)
  assert.equal(snapshot.error, '未指定工作区目录')
  assert.equal(run.calls.length, 0)
})

test('capture: a clean tree turns `stash create` output "" into snapshotSha === headSha', async () => {
  const run = captureRunner()
  const snapshot = await capturePreTurnSnapshot('/repo', { run })

  assert.equal(snapshot.isRepo, true)
  assert.equal(snapshot.headSha, 'a'.repeat(40))
  assert.equal(snapshot.snapshotSha, snapshot.headSha)
})

test('capture: a dirty tree keeps the dangling stash-create commit as snapshotSha', async () => {
  const run = captureRunner(captureReplies({ stash: reply(0, `${SNAPSHOT_SHA}\n`) }))
  const snapshot = await capturePreTurnSnapshot('/repo', { run })

  assert.equal(snapshot.snapshotSha, SNAPSHOT_SHA)
  assert.notEqual(snapshot.snapshotSha, snapshot.headSha)
})

test('capture: an empty repository (unborn HEAD) yields null shas and skips stash create', async () => {
  const run = captureRunner(captureReplies({ head: reply(128, '', 'fatal: ambiguous argument HEAD') }))
  const snapshot = await capturePreTurnSnapshot('/fresh-repo', { run })

  assert.equal(snapshot.isRepo, true)
  assert.equal(snapshot.headSha, null)
  assert.equal(snapshot.snapshotSha, null)
  // `stash create` has nothing to snapshot without HEAD; not running it is the
  // difference between "empty repo" and "swallowed failure".
  assert.equal(run.text().some((line) => line.includes('stash create')), false)
})

test('capture: preUntracked comes from ls-files -z and is split on NUL', async () => {
  const run = captureRunner(captureReplies({ lsFiles: reply(0, 'debug.js\0src/new file.js\0') }))
  const snapshot = await capturePreTurnSnapshot('/repo', { run })

  assert.deepEqual(snapshot.preUntracked, ['debug.js', 'src/new file.js'])
})

test('capture: issues exactly the four documented calls, in order', async () => {
  const run = captureRunner()
  await capturePreTurnSnapshot('/repo', { run })

  assert.deepEqual(commands(run), [
    'rev-parse --is-inside-work-tree',
    'rev-parse HEAD',
    'stash create',
    'ls-files --others --exclude-standard -z',
  ])
})

test('capture: never issues a mutating git command (constraint 1)', async () => {
  const run = captureRunner(captureReplies({ stash: reply(0, `${SNAPSHOT_SHA}\n`) }))
  await capturePreTurnSnapshot('/repo', { run })

  const forbidden = [
    /\bstash\b (?!create)/, // stash / stash push / stash pop / stash drop…
    /\bcheckout\b/,
    /\breset\b/,
    /\bclean\b/,
    /\brm\b/,
    /\bcommit\b/,
    /\bapply\b/,
  ]
  const issued = commands(run)
  for (const verb of forbidden) {
    const hit = issued.find((line) => verb.test(line))
    assert.equal(hit, undefined, `capture must not run a mutating command, saw: ${hit}`)
  }
  // The one stash form that is allowed — and only that one.
  const stashCalls = issued.filter((line) => line.includes('stash'))
  assert.deepEqual(stashCalls, ['stash create'])
})

test('capture: a throwing runner is reported as data, never as an exception', async () => {
  const run = async () => {
    throw new Error('spawn git ENOENT')
  }
  const snapshot = await capturePreTurnSnapshot('/repo', { run })
  assert.equal(snapshot.isRepo, false)
  assert.match(snapshot.error, /spawn git ENOENT/)
})

test('capture: a runner returning junk is normalised, not trusted', async () => {
  const run = async () => null
  const snapshot = await capturePreTurnSnapshot('/repo', { run })
  assert.equal(snapshot.isRepo, false)
  assert.match(snapshot.error, /非法结果/)
})

test('capture: a failing stash create still returns the head sha with a reason', async () => {
  const run = captureRunner(captureReplies({
    stash: reply(1, '', 'fatal: unable to write new index file'),
  }))
  const snapshot = await capturePreTurnSnapshot('/repo', { run })

  assert.equal(snapshot.isRepo, true)
  assert.equal(snapshot.snapshotSha, snapshot.headSha)
  assert.match(snapshot.error, /unable to write new index file/)
})

// ---------------------------------------------------------------------------
// rollbackTurn — safety rules
// ---------------------------------------------------------------------------

test('rollback: snapshotSha null skips checkout, still cleans untracked, explains why', async (t) => {
  const ws = await scratch(t)
  await writeFile(join(ws, 'brand-new.txt'), 'x')
  const run = rollbackRunner({ untracked: ['brand-new.txt'] })

  const result = await rollbackTurn(ws, { isRepo: true, snapshotSha: null, headSha: null, preUntracked: [] }, { run })

  assert.equal(result.ok, true)
  assert.equal(commands(run).some((line) => line.includes('checkout')), false)
  assert.equal(existsSync(join(ws, 'brand-new.txt')), false)
  assert.deepEqual(result.removedUntracked, ['brand-new.txt'])
  assert.equal(result.skipped.some((note) => note.includes('空仓库无 HEAD')), true)
})

test('rollback: a non-repo snapshot is a no-op with a recorded reason', async (t) => {
  const ws = await scratch(t)
  const run = rollbackRunner()
  const result = await rollbackTurn(ws, { isRepo: false, snapshotSha: null, headSha: null, preUntracked: [] }, { run })

  assert.equal(result.ok, true)
  assert.deepEqual(result.restoredFiles, [])
  assert.equal(result.skipped.some((note) => note.includes('不是 git 仓库')), true)
  assert.equal(run.calls.length, 0)
})

test('rollback: paths escaping the workspace are skipped, never handed to git (constraint 3)', async (t) => {
  const ws = await scratch(t)
  const outside = join(ws, '..', `outside-${process.pid}.txt`)
  const run = rollbackRunner()

  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, {
    run,
    // `..` escape, an absolute path outside, and a Windows-style traversal.
    touchedFiles: ['../../etc/passwd', outside, 'sub/../../escape.txt', 'ok.txt'],
  })

  // No checkout/ls-tree may mention an escaping path.
  for (const line of commands(run)) {
    assert.equal(/passwd|outside-|escape\.txt/.test(line), false, `escaped path reached git: ${line}`)
  }
  // Only the in-workspace file is attempted; the rest are recorded.
  assert.deepEqual(result.restoredFiles, [])
  assert.equal(result.skipped.filter((note) => note.includes('越界跳过')).length, 3)
})

test('rollback: an untracked file present before the turn is never deleted (constraint 4)', async (t) => {
  const ws = await scratch(t)
  await writeFile(join(ws, 'user-notes.txt'), 'mine')
  await writeFile(join(ws, 'turn-scratch.txt'), 'theirs')

  // git reports both as untracked now, but only one existed before the turn.
  const run = rollbackRunner({ untracked: ['user-notes.txt', 'turn-scratch.txt'] })
  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: ['user-notes.txt'],
  }, { run })

  assert.equal(existsSync(join(ws, 'user-notes.txt')), true, '盘前已有文件必须保留')
  assert.equal(existsSync(join(ws, 'turn-scratch.txt')), false)
  assert.deepEqual(result.removedUntracked, ['turn-scratch.txt'])
})

test('rollback: removeUntracked:false reports candidates instead of deleting', async (t) => {
  const ws = await scratch(t)
  await writeFile(join(ws, 'turn-scratch.txt'), 'theirs')
  const run = rollbackRunner({ untracked: ['turn-scratch.txt'] })

  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, { run, removeUntracked: false })

  assert.equal(existsSync(join(ws, 'turn-scratch.txt')), true)
  assert.deepEqual(result.removedUntracked, [])
  assert.equal(result.skipped.some((note) => note.includes('removeUntracked=false')), true)
})

test('rollback: empty touchedFiles falls back to a whole-tree checkout', async (t) => {
  const ws = await scratch(t)
  const run = rollbackRunner()

  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, { run, touchedFiles: [] })

  const checkouts = commands(run).filter((line) => line.includes('checkout'))
  assert.equal(checkouts.length, 1)
  assert.match(checkouts[0], /checkout .* -- \.$/)
  assert.deepEqual(result.restoredFiles, ['.'])
})

test('rollback: a path that was not tracked at snapshot time is skipped, not checked out', async (t) => {
  const ws = await scratch(t)
  const run = rollbackRunner({ tracked: ['a.txt'] })

  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, { run, touchedFiles: ['a.txt', 'new.js'] })

  assert.deepEqual(result.restoredFiles, ['a.txt'])
  assert.equal(result.skipped.some((note) => note.includes('new.js')), true)
  const checkouts = commands(run).filter((line) => line.includes('checkout'))
  assert.equal(checkouts.length, 1)
  assert.match(checkouts[0], /a\.txt$/)
})

test('rollback: duplicate and backslash paths are normalised to one checkout', async (t) => {
  const ws = await scratch(t)
  const run = rollbackRunner({ tracked: ['src/a.js'] })

  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, { run, touchedFiles: ['src/a.js', 'src\\a.js', './src/a.js'] })

  assert.deepEqual(result.restoredFiles, ['src/a.js'])
  assert.equal(commands(run).filter((line) => /\bcheckout\b/.test(line)).length, 1)
})

test('rollback: a failing checkout clears ok and keeps the reason', async (t) => {
  const ws = await scratch(t)
  const run = rollbackRunner({ tracked: ['a.txt'], checkoutCode: 128 })

  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, { run, touchedFiles: ['a.txt'] })

  assert.equal(result.ok, false)
  assert.match(result.error, /未能从快照完整恢复/)
  assert.equal(result.skipped.some((note) => note.includes('恢复失败')), true)
})

test('rollback: a failed untracked listing clears ok instead of silently "succeeding"', async (t) => {
  const ws = await scratch(t)
  const run = rollbackRunner({ tracked: ['a.txt'], lsFilesCode: 128 })

  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, { run, touchedFiles: ['a.txt'] })

  assert.equal(result.ok, false)
  assert.equal(result.skipped.some((note) => note.includes('无法列出未跟踪文件')), true)
})

test('rollback: a missing snapshot object errors instead of guessing', async (t) => {
  const ws = await scratch(t)
  const run = rollbackRunner()
  const result = await rollbackTurn(ws, null, { run })
  assert.equal(result.ok, false)
  assert.equal(result.error, '缺少回合前快照，无法回滚')
  assert.equal(run.calls.length, 0)
})

test('rollback: issues only restore/list commands, never reset/clean/stash (constraint 1)', async (t) => {
  const ws = await scratch(t)
  await writeFile(join(ws, 'turn-scratch.txt'), 'theirs')
  const run = rollbackRunner({ tracked: ['a.txt'], untracked: ['turn-scratch.txt'] })

  await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, { run, touchedFiles: ['a.txt'] })

  for (const line of commands(run)) {
    assert.equal(/\b(reset|clean|stash|rm|commit|add)\b/.test(line), false, `unexpected mutating call: ${line}`)
  }
})

test('rollback: refuses to delete through a directory entry', async (t) => {
  const ws = await scratch(t)
  await mkdir(join(ws, 'generated'), { recursive: true })
  const run = rollbackRunner({ untracked: ['generated'] })

  const result = await rollbackTurn(ws, {
    isRepo: true,
    snapshotSha: SNAPSHOT_SHA,
    headSha: 'a'.repeat(40),
    preUntracked: [],
  }, { run })

  assert.equal(existsSync(join(ws, 'generated')), true)
  assert.equal(result.skipped.some((note) => note.includes('目标是目录')), true)
  assert.equal(result.ok, false)
})

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('renderSnapshot: undefined for a missing or non-repo snapshot', () => {
  assert.equal(renderSnapshot(undefined), undefined)
  assert.equal(renderSnapshot({ isRepo: false }), undefined)
  assert.equal(renderSnapshot(null), undefined)
})

test('renderSnapshot: a clean capture says the snapshot is HEAD', () => {
  const sha = 'a'.repeat(40)
  const text = renderSnapshot({ isRepo: true, snapshotSha: sha, headSha: sha, preUntracked: [] })
  assert.match(text, /回合前 Git 快照/)
  assert.match(text, /快照即 HEAD/)
  assert.match(text, new RegExp(`head +: ${sha.slice(0, 7)}`))
})

test('renderSnapshot: a dirty capture is labelled as a dangling object', () => {
  const text = renderSnapshot({
    isRepo: true, snapshotSha: SNAPSHOT_SHA, headSha: 'a'.repeat(40), preUntracked: ['x.js'],
  })
  assert.match(text, /dangling 对象/)
  assert.match(text, /1 个盘前未跟踪文件/)
  assert.match(text, /\?\? x\.js/)
})

test('renderSnapshot: an empty repository explains the degraded rollback', () => {
  const text = renderSnapshot({ isRepo: true, snapshotSha: null, headSha: null, preUntracked: [] })
  assert.match(text, /空仓库无 HEAD/)
  assert.match(text, /head +: \(无提交\)/)
})

test('renderSnapshot: a long untracked list is capped', () => {
  const files = Array.from({ length: 25 }, (_, i) => `f${i}.js`)
  const text = renderSnapshot({ isRepo: true, snapshotSha: SNAPSHOT_SHA, headSha: 'a'.repeat(40), preUntracked: files })
  assert.match(text, /25 个盘前未跟踪文件/)
  assert.match(text, /… \(5 more\)/)
})

test('renderRollback: always returns text, including the empty case', () => {
  assert.match(renderRollback(undefined), /回滚结果/)
  assert.match(renderRollback({ ok: true }), /没有需要回滚的改动/)
  assert.equal(typeof renderRollback(undefined), 'string')
})

test('renderRollback: lists restored, removed and skipped entries', () => {
  const text = renderRollback({
    ok: false,
    restoredFiles: ['a.txt'],
    removedUntracked: ['b.js'],
    skipped: ['越界跳过（不在工作区内）: ../../x'],
    error: '部分文件未能从快照完整恢复，详见 skipped',
  })
  assert.match(text, /未完成/)
  assert.match(text, /1 恢复 \/ 1 删除 \/ 1 跳过/)
  assert.match(text, /✅ a\.txt/)
  assert.match(text, /🗑 b\.js/)
  assert.match(text, /⏭ 越界跳过/)
  assert.match(text, /error +: 部分文件/)
})

// ---------------------------------------------------------------------------
// real git integration
// ---------------------------------------------------------------------------

/** Is a usable `git` binary on PATH? Absent → integration tests skip. */
async function probeGit() {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { windowsHide: true, encoding: 'utf8' })
    return /git version/i.test(stdout)
  } catch {
    return false
  }
}

const GIT_AVAILABLE = await probeGit()

/** Run git in `cwd` with a throwaway identity, never through a shell. */
async function git(cwd, args) {
  const { stdout, stderr } = await execFileAsync(
    'git',
    ['-c', 'user.email=snapshot@test.local', '-c', 'user.name=Snapshot Test', ...args],
    { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
  return { stdout, stderr }
}

/** A repo with one commit, plus a pre-existing uncommitted edit. */
async function repoWithHistory(t) {
  // The space in the prefix is deliberate: execFile without a shell must cope.
  const ws = await scratch(t, 'agy snapshot ')
  await git(ws, ['init', '-q', '-b', 'main'])
  await writeFile(join(ws, 'a.txt'), 'a-committed\n')
  await writeFile(join(ws, 'b.txt'), 'b-committed\n')
  await writeFile(join(ws, 'c.txt'), 'c-committed\n')
  await writeFile(join(ws, 'keep.txt'), 'keep-committed\n')
  await git(ws, ['add', '.'])
  await git(ws, ['commit', '-q', '-m', 'base'])
  return ws
}

test('integration: a real turn is undone while the pre-existing edit survives', { skip: !GIT_AVAILABLE && 'git 不可用' }, async (t) => {
  const ws = await repoWithHistory(t)

  // --- state before the turn ------------------------------------------------
  // A: an uncommitted edit that existed on disk before we snapshotted.
  await writeFile(join(ws, 'keep.txt'), 'A-pre-existing-edit\n')
  // A file the user created before the turn: rollback must not delete it.
  await writeFile(join(ws, 'user-untracked.txt'), 'user-made\n')

  const snapshot = await capturePreTurnSnapshot(ws)
  assert.equal(snapshot.isRepo, true)
  assert.equal(typeof snapshot.snapshotSha, 'string')
  assert.equal(snapshot.snapshotSha.length, 40)
  assert.deepEqual(snapshot.preUntracked, ['user-untracked.txt'])
  assert.equal(snapshot.error, undefined)

  // Constraint 1: capture must not touch the working tree, the index or the
  // stash list. Verify against real git, not against our own argv.
  assert.equal((await git(ws, ['stash', 'list'])).stdout.trim(), '')
  assert.match((await git(ws, ['status', '--porcelain'])).stdout, /keep\.txt/)
  assert.equal(await readFile(join(ws, 'keep.txt'), 'utf8'), 'A-pre-existing-edit\n')

  // --- the turn: 3 tracked files rewritten, 1 new untracked file ------------
  await writeFile(join(ws, 'a.txt'), 'a-rewritten by the turn\n')
  await writeFile(join(ws, 'b.txt'), 'b-rewritten by the turn\n')
  await writeFile(join(ws, 'c.txt'), 'c-rewritten by the turn\n')
  await writeFile(join(ws, 'turn-new.txt'), 'created by the turn\n')

  const result = await rollbackTurn(ws, snapshot, {
    touchedFiles: ['a.txt', 'b.txt', 'c.txt', 'turn-new.txt'],
  })

  assert.equal(result.ok, true, `rollback failed: ${JSON.stringify(result.skipped)}`)
  assert.deepEqual(result.restoredFiles.sort(), ['a.txt', 'b.txt', 'c.txt'])
  assert.deepEqual(result.removedUntracked, ['turn-new.txt'])

  // The four files are back to their pre-turn state.
  assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'a-committed\n')
  assert.equal(await readFile(join(ws, 'b.txt'), 'utf8'), 'b-committed\n')
  assert.equal(await readFile(join(ws, 'c.txt'), 'utf8'), 'c-committed\n')
  assert.equal(existsSync(join(ws, 'turn-new.txt')), false)

  // A survived: the pre-existing edit and the pre-existing untracked file.
  assert.equal(await readFile(join(ws, 'keep.txt'), 'utf8'), 'A-pre-existing-edit\n')
  assert.equal(existsSync(join(ws, 'user-untracked.txt')), true)
  // …and the stash list is still empty: a snapshot is not a stash entry.
  assert.equal((await git(ws, ['stash', 'list'])).stdout.trim(), '')
})

test('integration: without touchedFiles the whole tree is restored', { skip: !GIT_AVAILABLE && 'git 不可用' }, async (t) => {
  const ws = await repoWithHistory(t)
  await writeFile(join(ws, 'user-untracked.txt'), 'user-made\n')
  const snapshot = await capturePreTurnSnapshot(ws)

  await writeFile(join(ws, 'a.txt'), 'rewritten\n')
  await writeFile(join(ws, 'b.txt'), 'rewritten\n')
  await writeFile(join(ws, 'turn-new.txt'), 'created\n')

  const result = await rollbackTurn(ws, snapshot)

  assert.equal(result.ok, true)
  assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'a-committed\n')
  assert.equal(await readFile(join(ws, 'b.txt'), 'utf8'), 'b-committed\n')
  assert.equal(existsSync(join(ws, 'turn-new.txt')), false)
  assert.equal(existsSync(join(ws, 'user-untracked.txt')), true, '整树回滚不得删除盘前未跟踪文件')
})

test('integration: a pre-existing edit in a file the turn also rewrote comes back', { skip: !GIT_AVAILABLE && 'git 不可用' }, async (t) => {
  // The reason the snapshot is `stash create` and not `checkout HEAD`: with a
  // plain HEAD checkout, rolling back this file would also throw away the edit
  // the user had made *before* the turn. The snapshot commit contains the
  // working-tree state, so it restores exactly what was there.
  const ws = await repoWithHistory(t)
  await writeFile(join(ws, 'a.txt'), 'A-half-done-work\n')

  const snapshot = await capturePreTurnSnapshot(ws)
  assert.notEqual(snapshot.snapshotSha, snapshot.headSha, '脏工作区必须生成独立的快照对象')

  await writeFile(join(ws, 'a.txt'), 'the turn clobbered it\n')
  const result = await rollbackTurn(ws, snapshot, { touchedFiles: ['a.txt'] })

  assert.equal(result.ok, true)
  assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'A-half-done-work\n')
})

test('integration: a tracked file the turn deleted is restored', { skip: !GIT_AVAILABLE && 'git 不可用' }, async (t) => {
  const ws = await repoWithHistory(t)
  const snapshot = await capturePreTurnSnapshot(ws)

  await rm(join(ws, 'b.txt'))
  const result = await rollbackTurn(ws, snapshot, { touchedFiles: ['b.txt'] })

  assert.equal(result.ok, true)
  assert.equal(existsSync(join(ws, 'b.txt')), true)
  assert.equal(await readFile(join(ws, 'b.txt'), 'utf8'), 'b-committed\n')
})

test('integration: an empty repository falls back to untracked cleanup', { skip: !GIT_AVAILABLE && 'git 不可用' }, async (t) => {
  const ws = await scratch(t, 'agy snapshot empty ')
  await git(ws, ['init', '-q', '-b', 'main'])

  const snapshot = await capturePreTurnSnapshot(ws)
  assert.equal(snapshot.isRepo, true)
  assert.equal(snapshot.headSha, null)
  assert.equal(snapshot.snapshotSha, null)
  assert.deepEqual(snapshot.preUntracked, [])

  await writeFile(join(ws, 'first-file.txt'), 'created after capture\n')
  const result = await rollbackTurn(ws, snapshot, { touchedFiles: ['first-file.txt'] })

  assert.equal(result.ok, true)
  assert.equal(existsSync(join(ws, 'first-file.txt')), false)
  assert.equal(result.skipped.some((note) => note.includes('空仓库无 HEAD')), true)
  // Nothing to restore, and no checkout was needed.
  assert.deepEqual(result.restoredFiles, [])
})

test('integration: a plain folder is not an error, and rollback is a no-op', { skip: !GIT_AVAILABLE && 'git 不可用' }, async (t) => {
  const ws = await scratch(t, 'agy snapshot plain ')
  await writeFile(join(ws, 'notes.txt'), 'hello\n')

  const snapshot = await capturePreTurnSnapshot(ws)
  assert.equal(snapshot.isRepo, false)
  assert.equal(snapshot.error, undefined)
  assert.equal(renderSnapshot(snapshot), undefined)

  const result = await rollbackTurn(ws, snapshot)
  assert.equal(result.ok, true)
  assert.equal(result.skipped.some((note) => note.includes('不是 git 仓库')), true)
  assert.equal(existsSync(join(ws, 'notes.txt')), true, '非仓库目录里的文件不得被删除')
})

test('integration: a missing git binary degrades to {isRepo:false} plus a reason', { skip: !GIT_AVAILABLE && 'git 不可用' }, async (t) => {
  const ws = await repoWithHistory(t)
  // Simulate a broken PATH: the injected runner is exactly the seam the caller
  // uses when it needs a different git binary (WSL, portable install, …).
  const snapshot = await capturePreTurnSnapshot(ws, {
    run: async () => {
      throw new Error('spawn git ENOENT')
    },
  })
  assert.equal(snapshot.isRepo, false)
  assert.match(snapshot.error, /ENOENT/)
})
