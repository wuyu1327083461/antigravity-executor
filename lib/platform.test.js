/**
 * Unit tests for the cross-platform shell preamble.
 *
 * The preamble is injected into the executor prompt, so both dialects are
 * tested even though only one of them can be live on any given host. That is
 * exactly why `platform.js` exposes `buildPreamble(kind, workspace)` and
 * friends as pure functions and only binds them to `process.platform` in the
 * exported wrappers.
 *
 * Run: node --test lib/platform.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PLATFORMS,
  buildNotes,
  buildPreamble,
  buildSwitchHint,
  detectPlatform,
  platform,
  shellNotes,
  shellPreamble,
  workspaceSwitchHint,
} from './platform.js'

// ---------------------------------------------------------------------------
// platform detection
// ---------------------------------------------------------------------------

test('detectPlatform maps win32 to windows and everything else to posix', () => {
  assert.equal(detectPlatform('win32'), 'windows')
  assert.equal(detectPlatform('darwin'), 'posix')
  assert.equal(detectPlatform('linux'), 'posix')
  assert.equal(detectPlatform('freebsd'), 'posix')
})

test('the exported platform constant agrees with process.platform', () => {
  assert.ok(PLATFORMS.includes(platform))
  assert.equal(platform, detectPlatform(process.platform))
})

// ---------------------------------------------------------------------------
// preamble
// ---------------------------------------------------------------------------

test('buildPreamble uses Set-Location -LiteralPath and ";" on Windows', () => {
  assert.equal(
    buildPreamble('windows', 'E:\\work\\proj'),
    "Set-Location -LiteralPath 'E:\\work\\proj'; ",
  )
})

test('buildPreamble uses cd and "&&" on POSIX', () => {
  assert.equal(buildPreamble('posix', '/home/dev/proj'), "cd '/home/dev/proj' && ")
})

test('buildPreamble returns an empty string when no workspace is given', () => {
  assert.equal(buildPreamble('windows', ''), '')
  assert.equal(buildPreamble('posix', '   '), '')
  assert.equal(buildPreamble('posix', undefined), '')
})

test('buildPreamble doubles single quotes for PowerShell literal paths', () => {
  // PowerShell escapes a quote inside a single-quoted string by doubling it.
  assert.equal(
    buildPreamble('windows', "E:\\it's here"),
    "Set-Location -LiteralPath 'E:\\it''s here'; ",
  )
})

test('buildPreamble escapes single quotes for POSIX', () => {
  assert.equal(buildPreamble('posix', "/home/it's here"), "cd '/home/it'\\''s here' && ")
})

test('buildPreamble preserves spaces verbatim', () => {
  assert.equal(
    buildPreamble('windows', 'E:\\demo-workspace\\ungrouped'),
    "Set-Location -LiteralPath 'E:\\demo-workspace\\ungrouped'; ",
  )
  assert.equal(
    buildPreamble('posix', '/home/dev/my project'),
    "cd '/home/dev/my project' && ",
  )
})

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

test('buildNotes gives PowerShell syntax advice on Windows', () => {
  const notes = buildNotes('windows')
  assert.ok(Array.isArray(notes))
  assert.ok(notes.length > 0)
  const joined = notes.join('\n')
  // The two mistakes the old prompt already had to correct.
  assert.match(joined, /`;`/)
  assert.match(joined, /不要用 `&&`/)
  assert.match(joined, /Get-Content/)
  assert.match(joined, /不要用 `cat`/)
  assert.match(joined, /\$env:/)
})

test('buildNotes gives POSIX syntax advice on POSIX', () => {
  const joined = buildNotes('posix').join('\n')
  assert.match(joined, /`&&`/)
  assert.match(joined, /`cat` \/ `ls` \/ `export` 均可直接使用/)
  assert.doesNotMatch(joined, /Set-Location/)
})

test('buildNotes returns a fresh array each call', () => {
  // A caller mutating the returned notes must not corrupt later prompts.
  const first = buildNotes('windows')
  first.push('mutated')
  assert.equal(buildNotes('windows').includes('mutated'), false)
})

// ---------------------------------------------------------------------------
// switch hint
// ---------------------------------------------------------------------------

test('buildSwitchHint names the exact switch command per platform', () => {
  assert.match(buildSwitchHint('windows', 'E:\\work\\proj'), /Set-Location -LiteralPath 'E:\\work\\proj'/)
  assert.match(buildSwitchHint('posix', '/home/dev/proj'), /cd '\/home\/dev\/proj' && /)
})

test('buildSwitchHint falls back to a placeholder when no workspace is given', () => {
  assert.match(buildSwitchHint('windows', ''), /<工作区>/)
  assert.match(buildSwitchHint('posix', ''), /<工作区>/)
})

// ---------------------------------------------------------------------------
// live wrappers
// ---------------------------------------------------------------------------

test('the wrappers bind the pure builders to the live platform', () => {
  assert.equal(shellPreamble('/tmp/ws'), buildPreamble(platform, '/tmp/ws'))
  assert.deepEqual(shellNotes(), buildNotes(platform))
  assert.equal(workspaceSwitchHint('/tmp/ws'), buildSwitchHint(platform, '/tmp/ws'))
})

test('the live preamble ends with the separator the live platform needs', () => {
  const preamble = shellPreamble(process.cwd())
  assert.ok(preamble.endsWith(platform === 'windows' ? '; ' : '&& '))
})
