/**
 * Unit tests for the git worktree pre-check and brain artifact collection.
 *
 * Both functions are filesystem-facing, so every case builds a throwaway
 * directory tree under `os.tmpdir()` instead of touching a real repository.
 *
 * Run: node --test lib/artifacts.test.js
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  brainDir,
  brainRoot,
  checkWorktreeConfig,
  collectBrainArtifacts,
  parseWorktreeConfig,
} from './artifacts.js'

/** Create a unique scratch directory and remember it for cleanup. */
async function scratch(t) {
  const dir = await mkdtemp(join(join(process.env.TEMP ?? process.env.TMPDIR ?? homedir()), 'agy-artifacts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// git config parsing
// ---------------------------------------------------------------------------

test('parseWorktreeConfig reads the normal [extensions] section form', () => {
  const text = ['[core]', '\trepositoryformatversion = 0', '[extensions]', '\tworktreeConfig = true', ''].join('\n')
  assert.equal(parseWorktreeConfig(text), 'true')
})

test('parseWorktreeConfig is case-insensitive on key and section', () => {
  assert.equal(parseWorktreeConfig('[EXTENSIONS]\nWorktreeConfig = TRUE'), 'true')
})

test('parseWorktreeConfig returns undefined when the key is absent', () => {
  assert.equal(parseWorktreeConfig('[core]\n\trepositoryformatversion = 0'), undefined)
  assert.equal(parseWorktreeConfig(''), undefined)
})

test('parseWorktreeConfig ignores the key under another section', () => {
  // `worktreeConfig` under [core] is meaningless and must not trip the check.
  assert.equal(parseWorktreeConfig('[core]\n\tworktreeConfig = true'), undefined)
})

test('parseWorktreeConfig reports false for an explicit false value', () => {
  assert.equal(parseWorktreeConfig('[extensions]\n\tworktreeConfig = false'), 'false')
})

test('parseWorktreeConfig does not leak across section headers', () => {
  const text = ['[extensions]', '\tworktreeConfig = true', '[remote "origin"]', '\turl = x'].join('\n')
  assert.equal(parseWorktreeConfig(text), 'true')
})

// ---------------------------------------------------------------------------
// checkWorktreeConfig
// ---------------------------------------------------------------------------

test('checkWorktreeConfig flags a plain checkout with the extension enabled', async (t) => {
  const ws = await scratch(t)
  await mkdir(join(ws, '.git'), { recursive: true })
  await writeFile(join(ws, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tworktreeConfig = true\n')

  const result = await checkWorktreeConfig(ws)
  assert.equal(result.worktreeConfig, true)
  assert.equal(result.configPath, join(ws, '.git', 'config'))
  assert.match(result.warning, /extensions\.worktreeConfig/)
  // The warning must contain the fix, not just the diagnosis.
  assert.match(result.warning, /git config --unset extensions\.worktreeConfig/)
})

test('checkWorktreeConfig passes a plain checkout without the extension', async (t) => {
  const ws = await scratch(t)
  await mkdir(join(ws, '.git'), { recursive: true })
  await writeFile(join(ws, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')

  const result = await checkWorktreeConfig(ws)
  assert.equal(result.worktreeConfig, false)
  assert.equal(result.configPath, join(ws, '.git', 'config'))
  assert.equal(result.warning, undefined)
})

test('checkWorktreeConfig follows a .git file into a linked worktree gitdir', async (t) => {
  const ws = await scratch(t)
  const common = await scratch(t)

  // A linked worktree: .git is a pointer file, the real config lives in the
  // common repository dir and the worktree dir only has a `commondir` pointer.
  const gitdir = join(common, '.git', 'worktrees', 'wt')
  await mkdir(gitdir, { recursive: true })
  await mkdir(join(common, '.git'), { recursive: true })
  await writeFile(join(ws, '.git'), `gitdir: ${gitdir}\n`)
  await writeFile(join(gitdir, 'commondir'), '../..\n')
  await writeFile(join(common, '.git', 'config'), '[extensions]\n\tworktreeConfig = true\n')

  const result = await checkWorktreeConfig(ws)
  assert.equal(result.worktreeConfig, true)
  assert.equal(result.configPath, join(common, '.git', 'config'))
  assert.match(result.warning, /--unset/)
})

test('checkWorktreeConfig resolves a relative gitdir pointer', async (t) => {
  const ws = await scratch(t)
  const gitdir = join(ws, '.git-real')
  await mkdir(gitdir, { recursive: true })
  await writeFile(join(ws, '.git'), 'gitdir: .git-real\n')
  await writeFile(join(gitdir, 'config'), '[extensions]\n\tworktreeConfig = true\n')

  const result = await checkWorktreeConfig(ws)
  assert.equal(result.worktreeConfig, true)
  assert.equal(result.configPath, join(gitdir, 'config'))
})

test('checkWorktreeConfig reports a non-git directory without throwing', async (t) => {
  const ws = await scratch(t)
  const result = await checkWorktreeConfig(ws)
  assert.equal(result.worktreeConfig, false)
  assert.equal(result.configPath, undefined)
  assert.match(result.warning, /不是 git 仓库/)
})

test('checkWorktreeConfig reports a missing workspace without throwing', async () => {
  const result = await checkWorktreeConfig('')
  assert.equal(result.worktreeConfig, false)
  assert.match(result.warning, /未指定工作区/)
})

test('checkWorktreeConfig handles an unreadable config file', async (t) => {
  const ws = await scratch(t)
  await mkdir(join(ws, '.git'), { recursive: true })
  // Directory instead of file: reading it fails, which must not be fatal.
  await mkdir(join(ws, '.git', 'config'))
  const result = await checkWorktreeConfig(ws)
  assert.equal(result.worktreeConfig, false)
})

// ---------------------------------------------------------------------------
// collectBrainArtifacts
// ---------------------------------------------------------------------------

test('brainRoot and brainDir point at the measured brain layout', () => {
  assert.equal(brainRoot(), join(homedir(), '.gemini', 'antigravity', 'brain'))
  assert.equal(brainDir('abc-123'), join(brainRoot(), 'abc-123'))
})

/**
 * Build a fake brain directory in a scratch HOME and run the collector against
 * it. `collectBrainArtifacts` resolves the brain path from `homedir()`, so the
 * test cannot redirect it without changing the environment; instead it seeds a
 * unique conversation id and removes the directory afterwards.
 */
async function withBrain(t, files) {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const dir = brainDir(id)
  await mkdir(dir, { recursive: true })
  t.after(() => rm(dir, { recursive: true, force: true }))

  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return { id, dir }
}

test('collectBrainArtifacts returns root-level .md files only', async (t) => {
  const { dir } = await withBrain(t, {
    'walkthrough.md': '# Walkthrough\n\nDone.',
    'implementation_plan.md': '# Plan\n\n1. Step one.',
    'notes.txt': 'ignore me',
    'data.json': '{}',
  })

  // `.system_generated` is a directory: excluded by construction.
  await mkdir(join(dir, '.system_generated', 'logs'), { recursive: true })
  await writeFile(join(dir, '.system_generated', 'logs', 'run.log'), 'noise')
  await writeFile(join(dir, '.system_generated', 'hidden.md'), '# should not appear')
  // A nested .md is also out of scope.
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'sub', 'nested.md'), '# nested')

  const rows = await collectBrainArtifacts(dir.split(/[\\/]/).pop())
  assert.deepEqual(rows.map((r) => r.name).sort(), ['implementation_plan.md', 'walkthrough.md'])
  for (const row of rows) {
    assert.equal(row.path.startsWith(dir), true)
    assert.equal(typeof row.bytes, 'number')
    assert.equal(typeof row.summary, 'string')
    assert.equal(typeof row.updatedAt, 'string')
  }
})

test('collectBrainArtifacts summarises the head of each file', async (t) => {
  const body = `# Report\n\n${'x'.repeat(2000)}`
  const { id } = await withBrain(t, { 'walkthrough.md': body })

  const [row] = await collectBrainArtifacts(id, { summaryChars: 50 })
  assert.equal(row.summary.length, 50)
  assert.match(row.summary, /^# Report/)
})

test('collectBrainArtifacts filters by sinceMs and sorts newest first', async (t) => {
  const { id, dir } = await withBrain(t, {
    'old.md': '# old',
    'new.md': '# new',
  })

  const oldTime = new Date('2026-01-01T00:00:00Z')
  const newTime = new Date('2026-10-01T00:00:00Z')
  await utimes(join(dir, 'old.md'), oldTime, oldTime)
  await utimes(join(dir, 'new.md'), newTime, newTime)

  // Nothing older than 2026-06-01 survives.
  const rows = await collectBrainArtifacts(id, { sinceMs: Date.parse('2026-06-01T00:00:00Z') })
  assert.deepEqual(rows.map((r) => r.name), ['new.md'])

  const all = await collectBrainArtifacts(id)
  assert.deepEqual(all.map((r) => r.name), ['new.md', 'old.md'])
  assert.equal(all[0].updatedAt, newTime.toISOString())
})

test('collectBrainArtifacts honours maxFiles', async (t) => {
  const files = {}
  for (let i = 0; i < 6; i += 1) files[`f${i}.md`] = `# ${i}`
  const { id } = await withBrain(t, files)

  const rows = await collectBrainArtifacts(id, { maxFiles: 2 })
  assert.equal(rows.length, 2)
})

test('collectBrainArtifacts returns [] for a missing brain directory', async () => {
  const rows = await collectBrainArtifacts('no-such-conversation-id')
  assert.deepEqual(rows, [])
})

test('collectBrainArtifacts returns [] for an empty conversation id', async () => {
  assert.deepEqual(await collectBrainArtifacts(''), [])
  assert.deepEqual(await collectBrainArtifacts(undefined), [])
})

test('collectBrainArtifacts never exposes the internal sort key', async (t) => {
  const { id } = await withBrain(t, { 'task.md': '# task' })
  const rows = await collectBrainArtifacts(id)
  // The sort key stays internal; the public shape (0.5.0 adds `chars` and
  // `inline`) is exactly these keys.
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'bytes',
    'chars',
    'inline',
    'name',
    'path',
    'summary',
    'updatedAt',
  ])
  assert.equal('_mtime' in rows[0], false)
})

// ---------------------------------------------------------------------------
// v0.5.0: inline policy ("audit in full, report compactly")
// ---------------------------------------------------------------------------

test('a short artifact is inlined in full and marked inline', async (t) => {
  const body = '# Task\n\nSmall and complete.'
  const { id } = await withBrain(t, { 'task.md': body })

  const [row] = await collectBrainArtifacts(id, { maxInlineChars: 4000 })
  assert.equal(row.inline, true)
  assert.equal(row.summary, body)
  assert.equal(row.chars, body.length)
  // The absolute path is always present so the planner can read the file itself.
  assert.equal(row.path.endsWith('task.md'), true)
})

test('an oversized artifact is headed, not dumped, and keeps its absolute path', async (t) => {
  const body = `# Walkthrough\n\n${'x'.repeat(40_000)}`
  const { id } = await withBrain(t, { 'walkthrough.md': body })

  const [row] = await collectBrainArtifacts(id, { maxInlineChars: 4000, oversizeHeadChars: 2000 })
  assert.equal(row.inline, false)
  assert.equal(row.chars, 40_000 + '# Walkthrough\n\n'.length)
  // Only the head is inlined: this is what keeps the planner's context small.
  assert.equal(row.summary.length, 2000)
  assert.match(row.summary, /^# Walkthrough/)
  // The caller is told where the rest lives instead of being handed all of it.
  assert.equal(row.path.startsWith(row.path), true)
  assert.match(row.path, /walkthrough\.md$/)
  assert.ok(row.bytes > 20_000)
})

test('the inline threshold is configurable', async (t) => {
  const body = 'y'.repeat(500)
  const { id } = await withBrain(t, { 'plan.md': body })

  // A tight budget forces the oversize path even for a 500-char file.
  const [tight] = await collectBrainArtifacts(id, { maxInlineChars: 100, oversizeHeadChars: 50 })
  assert.equal(tight.inline, false)
  assert.equal(tight.summary.length, 50)

  // A generous budget inlines it.
  const [loose] = await collectBrainArtifacts(id, { maxInlineChars: 10_000 })
  assert.equal(loose.inline, true)
  assert.equal(loose.summary, body)
})

test('summaryChars still caps the inline text independently', async (t) => {
  const body = `# Report\n\n${'z'.repeat(1500)}`
  const { id } = await withBrain(t, { 'walkthrough.md': body })

  // Under the inline cap but with an explicit small summary budget: truncate as
  // the caller asked, without pretending the file is oversized.
  const [row] = await collectBrainArtifacts(id, { summaryChars: 50, maxInlineChars: 4000 })
  assert.equal(row.summary.length, 50)
  assert.equal(row.inline, false)
})

test('a zero summaryChars request inlines nothing but still reports metadata', async (t) => {
  const { id } = await withBrain(t, { 'notes.md': '# n' })
  const [row] = await collectBrainArtifacts(id, { summaryChars: 0 })
  assert.equal(row.summary, '')
  assert.equal(row.chars, 3)
  assert.equal(row.updatedAt.length > 0, true)
})
