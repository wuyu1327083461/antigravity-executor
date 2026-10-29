/**
 * Unit tests for the workspace auditor and the config schema.
 *
 * The auditor is the only thing standing between "the executor said it stayed
 * in the workspace" and "we actually checked", so its path containment and
 * command classification get exercised directly, without touching Antigravity.
 *
 * Run: node --test lib/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  auditTurn,
  classifyFinding,
  createAuditor,
  expandAliases,
  extractPaths,
  findHangingCommands,
  isInside,
  normalizePath,
  parseHangingCommand,
  resolveVirtualPath,
} from './audit.js'
import { Config, THINKING_LEVELS } from './config-schema.js'

const WS = 'E:\\demo-workspace\\ungrouped'

/**
 * Build a transcript where every argument is its own step holding one call.
 * Each `call` is `{name, args}`; the real transcript stores `tool_calls` as an
 * array, which is what the auditor iterates.
 */
const steps = (...calls) =>
  calls.map((call, i) => ({ step_index: i, tool_calls: [call] }))

// ---------------------------------------------------------------------------
// path containment
// ---------------------------------------------------------------------------

test('isInside accepts the root itself and true descendants', () => {
  assert.equal(isInside(WS, WS), true)
  assert.equal(isInside(WS, `${WS}\\sub\\file.js`), true)
  assert.equal(isInside(WS, `${WS}/sub/file.js`.replace(/\//g, '\\')), true)
})

test('isInside rejects a sibling that shares a name prefix', () => {
  // The classic startsWith bug: "E:\\ungrouped2" must NOT count as inside "E:\\ungrouped".
  assert.equal(isInside(WS, 'E:\\demo-workspace\\ungrouped2\\x.js'), false)
  assert.equal(isInside(WS, 'E:\\demo-workspace'), false)
})

test('isInside is case- and separator-insensitive', () => {
  assert.equal(isInside(WS, WS.toLowerCase()), true)
  assert.equal(isInside('E:/demo-workspace/ungrouped', `${WS}\\a.js`), true)
})

test('normalizePath strips quotes and trailing separators', () => {
  assert.equal(normalizePath('  "E:\\a\\b\\"  '), 'e:\\a\\b')
})

test('normalizePath folds PowerShell-escaped doubled backslashes', () => {
  // The transcript stores run_command args PowerShell-escaped, so a real path
  // E:\work appears as E:\\work. Both spellings must compare equal, or the
  // workspace itself gets reported as an escape.
  assert.equal(normalizePath('E:\\\\a\\\\b'), normalizePath('E:\\a\\b'))
  assert.equal(normalizePath('E:\\\\a\\\\b'), 'e:\\a\\b')
})

test('a workspace written with doubled backslashes is not an escape', () => {
  // Regression: this exact shape produced a false "cd-outside" finding.
  const report = auditTurn(
    steps({
      name: 'run_command',
      args: { CommandLine: `Set-Location -LiteralPath '${WS.replace(/\\/g, '\\\\')}'; dir` },
    }),
    0,
    WS,
  )
  assert.deepEqual(report.violations, [])
})

// ---------------------------------------------------------------------------
// path extraction
// ---------------------------------------------------------------------------

test('extractPaths finds quoted and bare drive-absolute paths', () => {
  const found = extractPaths(`Copy-Item 'C:\\temp\\a.txt' D:\\work\\b.txt`)
  assert.ok(found.includes('C:\\temp\\a.txt'))
  assert.ok(found.includes('D:\\work\\b.txt'))
})

test('extractPaths ignores relative paths', () => {
  assert.deepEqual(extractPaths('npm test && node ./build.js'), [])
})

// ---------------------------------------------------------------------------
// command classification
// ---------------------------------------------------------------------------

test('a clean turn inside the workspace has no violations', () => {
  const report = auditTurn(
    steps(
      { name: 'read_file', args: { Path: `${WS}\\src\\index.js` } },
      {
        name: 'run_command',
        args: { CommandLine: `Set-Location -LiteralPath '${WS}'; npm test` },
      },
    ),
    0,
    WS,
  )
  assert.deepEqual(report.violations, [])
  assert.equal(report.commandCount, 1)
  assert.equal(report.readCount, 1)
})

test('Set-Location outside the workspace is an error', () => {
  const report = auditTurn(
    steps({
      name: 'run_command',
      args: { CommandLine: `Set-Location -LiteralPath 'C:\\Windows'; dir` },
    }),
    0,
    WS,
  )
  const hit = report.violations.find((v) => v.kind === 'cd-outside')
  assert.ok(hit, 'expected a cd-outside violation')
  assert.equal(hit.severity, 'error')
  assert.equal(hit.path, 'C:\\Windows')
})

test('writing outside the workspace is an error', () => {
  const report = auditTurn(
    steps({
      name: 'run_command',
      args: { CommandLine: `Set-Content -Path 'C:\\evil\\payload.bat' -Value 'x'` },
    }),
    0,
    WS,
  )
  const hit = report.violations.find((v) => v.kind === 'write-outside')
  assert.ok(hit, 'expected a write-outside violation')
  assert.equal(hit.severity, 'error')
})

test('dangerous commands are flagged even inside the workspace', () => {
  const report = auditTurn(
    steps({
      name: 'run_command',
      args: { CommandLine: `Set-Location -LiteralPath '${WS}'; format C:` },
    }),
    0,
    WS,
  )
  assert.ok(report.violations.some((v) => v.kind === 'dangerous:format'))
})

test('reading Antigravity builtins is benign, not a violation', () => {
  const report = auditTurn(
    steps({
      name: 'read_file',
      args: {
        Path: 'C:\\Users\\testuser\\.gemini\\antigravity\\builtin\\skills\\antigravity_guide\\SKILL.md',
      },
    }),
    0,
    WS,
  )
  assert.deepEqual(report.violations, [])
  assert.equal(report.externalReads.length, 1)
})

test('reading a random outside file is a warning, not an error', () => {
  const report = auditTurn(
    steps({ name: 'read_file', args: { Path: 'C:\\Users\\testuser\\Desktop\\notes.txt' } }),
    0,
    WS,
  )
  const hit = report.violations.find((v) => v.kind === 'read-outside')
  assert.ok(hit)
  assert.equal(hit.severity, 'warn')
})

test('steps before sinceIndex are ignored', () => {
  const report = auditTurn(
    steps(
      { name: 'run_command', args: { CommandLine: `Set-Location -LiteralPath 'C:\\Windows'; dir` } },
      { name: 'run_command', args: { CommandLine: `Set-Location -LiteralPath '${WS}'; npm test` } },
    ),
    1,
    WS,
  )
  assert.deepEqual(report.violations, [])
})

test('duplicate findings are collapsed', () => {
  const cmd = { name: 'run_command', args: { CommandLine: `Set-Content 'C:\\evil\\a.txt' 'x'` } }
  const report = auditTurn(steps(cmd, cmd, cmd), 0, WS)
  assert.equal(report.violations.length, 1)
})

// ---------------------------------------------------------------------------
// config schema
// ---------------------------------------------------------------------------

test('config defaults fill every field', () => {
  const result = Config['~standard'].validate({})
  assert.equal(result.issues, undefined)
  assert.equal(result.value.thinkingLevel, 'medium')
  assert.equal(result.value.followSessionWorkspace, true)
  assert.equal(result.value.allowOutsideWorkspace, false)
  assert.equal(result.value.audit, true)
  assert.equal(result.value.failOnEscape, false)
})

test('config defaults include the v0.5.0 keys and nested blocks', () => {
  const result = Config['~standard'].validate({})
  assert.equal(result.issues, undefined)
  const value = result.value
  assert.equal(value.maxArtifactInlineChars, 4000)
  assert.equal(value.maxArtifactHeadChars, 2000)
  assert.equal(value.longSessionTurns, 8)
  assert.equal(value.hangingCommandWarnSeconds, 45)
  // The weekly reserve is deliberately higher than the 5h threshold.
  assert.equal(value.quotaFallback.weeklyProMinFraction, 0.15)
  assert.equal(value.quotaFallback.weeklyGuard, true)
  assert.equal(value.quotaFallback.cacheTtlSeconds, 180)
  assert.equal(value.pacing.enabled, true)
  assert.equal(value.pacing.minGapSeconds, 15)
})

test('config accepts a partial nested block without dropping the other half', () => {
  const result = Config['~standard'].validate({ quotaFallback: { weeklyProMinFraction: 0.3 } })
  assert.equal(result.issues, undefined)
  // The supplied value wins; the unsupplied half keeps its default.
  assert.equal(result.value.quotaFallback.weeklyProMinFraction, 0.3)
  assert.equal(result.value.quotaFallback.proMinFraction, 0.05)
  assert.equal(result.value.quotaFallback.enabled, true)
})

test('config clamps a pacing jitter whose max is below its min', () => {
  // Rejecting the whole row over a cosmetic ordering mistake would take the
  // plugin down; clamping keeps pacing sane instead.
  const result = Config['~standard'].validate({
    pacing: { jitterMinSeconds: 20, jitterMaxSeconds: 5 },
  })
  assert.equal(result.issues, undefined)
  assert.equal(result.value.pacing.jitterMinSeconds, 20)
  assert.equal(result.value.pacing.jitterMaxSeconds, 20)
})

test('config reports a wrong type inside a nested block', () => {
  const result = Config['~standard'].validate({ pacing: { enabled: 'yes' } })
  assert.ok(result.issues)
  assert.match(result.issues[0].message, /pacing\.enabled must be a boolean/)
})

test('config rejects an unknown thinking level', () => {
  const result = Config['~standard'].validate({ thinkingLevel: 'turbo' })
  assert.ok(result.issues)
  assert.match(result.issues[0].message, /thinkingLevel must be one of/)
})

test('config accepts every declared level', () => {
  for (const level of THINKING_LEVELS) {
    const result = Config['~standard'].validate({ thinkingLevel: level })
    assert.equal(result.issues, undefined, `${level} should validate`)
    assert.equal(result.value.thinkingLevel, level)
  }
})

test('config reports a wrong type instead of silently coercing', () => {
  const result = Config['~standard'].validate({ audit: 'yes' })
  assert.ok(result.issues)
  assert.match(result.issues[0].message, /audit must be a boolean/)
})


// ---------------------------------------------------------------------------
// REQ-05: virtual working directory tracking
// ---------------------------------------------------------------------------
//
// A single command in isolation says nothing about where it lands. `cd ../..`
// in one step decides what `../../secret.txt` means in the next, which is
// exactly how a relative-path escape slips past a per-command regex.

const runStep = (index, commandLine) => ({
  step_index: index,
  type: 'RUN_COMMAND',
  status: 'DONE',
  content: '',
  tool_calls: [{ name: 'run_command', args: { CommandLine: commandLine } }],
})

test('virtual cwd: a relative write after `cd ../..` is an escape', () => {
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, `Set-Location -LiteralPath '${WS}'; cd ../..`))
  // Now two levels above the workspace; a relative write there leaves it.
  const verdict = auditor.push(runStep(1, 'Remove-Item ../../secret.txt'))
  assert.equal(verdict.blocked, true)
  assert.ok(verdict.violations.some((v) => v.kind === 'write-outside'))
})

test('virtual cwd: `cd sub` then `cd ../../../..` accumulates across steps', () => {
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, 'cd sub'))
  // `sub` is inside the workspace, so this must stay clean.
  assert.equal(auditor.report().violations.length, 0)
  auditor.push(runStep(1, 'cd ../../../../..'))
  assert.equal(
    auditor.report().violations.some((v) => v.kind === 'cd-outside'),
    true,
  )
})

test('virtual cwd: a relative read after an escape is classified against the new cwd', () => {
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, 'cd ../..'))
  const verdict = auditor.push({
    step_index: 1,
    tool_calls: [{ name: 'view_file', args: { Path: '../../boot.ini' } }],
  })
  assert.ok(verdict.violations.some((v) => v.kind === 'read-outside'))
})

test('resolveVirtualPath joins a relative target onto the virtual cwd', () => {
  assert.equal(
    normalizePath(resolveVirtualPath('E:/ws/sub', '../x.txt')),
    normalizePath('E:/ws/x.txt'),
  )
  // An absolute target is returned untouched: it does not depend on the cwd.
  assert.equal(resolveVirtualPath('E:/ws', 'D:/other'), 'D:/other')
})

// ---------------------------------------------------------------------------
// REQ-05: alias and environment-variable expansion
// ---------------------------------------------------------------------------

test('expandAliases rewrites PowerShell directory and delete aliases', () => {
  assert.match(expandAliases('sl C:\\Windows'), /Set-Location/)
  assert.match(expandAliases('ri -Recurse C:\\x'), /Remove-Item/)
  assert.match(expandAliases('pushd D:\\tmp'), /Set-Location/)
})

test('expandAliases resolves user-profile shorthands to a real path', () => {
  const expanded = expandAliases('sl $env:USERPROFILE')
  assert.ok(!expanded.includes('$env:USERPROFILE'), 'the variable must be resolved')
  assert.match(expanded, /Set-Location/)
  // The home directory is absolute, so the containment check has something real.
  assert.ok(expanded.length > 'Set-Location '.length)
})

test('`sl $env:USERPROFILE` is an escape', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, 'sl $env:USERPROFILE'))
  assert.equal(verdict.blocked, true)
  assert.ok(verdict.violations.some((v) => v.kind === 'cd-outside'))
})

test('`ri -Recurse` is flagged as a dangerous command', () => {
  const report = auditTurn([runStep(0, 'ri -Recurse C:\\Users\\x\\Documents')], 0, WS)
  assert.ok(
    report.violations.some((v) => v.kind.startsWith('dangerous:')),
    'the PowerShell alias must be recognised as destructive',
  )
})

test('`pushd C:\\Windows; del *.*` is both a cd escape and destructive', () => {
  const report = auditTurn([runStep(0, 'pushd C:\\Windows; del *.*')], 0, WS)
  const kinds = report.violations.map((v) => v.kind)
  assert.ok(kinds.includes('cd-outside'), 'pushd out of the workspace must be flagged')
  assert.ok(
    kinds.some((k) => k.startsWith('dangerous:')),
    'del must be flagged',
  )
})

test('a write into $env:TEMP is an escape', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, 'Set-Content $env:TEMP\\payload.ps1 -Value x'))
  assert.equal(verdict.blocked, true)
  assert.ok(verdict.violations.some((v) => v.kind === 'write-outside'))
})

test('a relative path `../../secret.txt` handed to a write verb is an escape', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, 'Set-Content ../../secret.txt -Value pwned'))
  assert.equal(verdict.blocked, true)
})

test('`del /f/s/q`, `erase /f` and `rd /s /q` are recognised as destructive', () => {
  for (const command of ['del /f/s/q C:\\data\\*', 'erase /f C:\\data\\x.txt', 'rd /s /q C:\\data']) {
    const report = auditTurn([runStep(0, command)], 0, WS)
    assert.ok(
      report.violations.some((v) => v.kind.startsWith('dangerous:')),
      `${command} must be flagged`,
    )
  }
})

test('a clean turn that stays inside the workspace is never blocked', () => {
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, `Set-Location -LiteralPath '${WS}'; npm test`))
  auditor.push({
    step_index: 1,
    tool_calls: [{ name: 'view_file', args: { Path: `${WS}\\src\\index.ts` } }],
  })
  auditor.push(runStep(2, 'cd src'))
  const verdict = auditor.push(runStep(3, 'Set-Content ./note.md -Value hi'))
  assert.equal(verdict.blocked, false)
  assert.equal(auditor.report().violations.length, 0)
})

test('a re-read of the same step does not double-count findings', () => {
  const auditor = createAuditor(WS)
  const step = runStep(0, 'cd C:\\Windows')
  auditor.push(step)
  const first = auditor.report().violations.length
  auditor.push(step)
  assert.equal(auditor.report().violations.length, first)
})

test('createAuditor and auditTurn agree on the same turn', () => {
  const steps = [
    runStep(0, `Set-Location -LiteralPath '${WS}'; cd ../..`),
    runStep(1, 'Remove-Item ../../x.txt'),
  ]
  const auditor = createAuditor(WS)
  for (const step of steps) auditor.push(step)
  const streaming = auditor.report()
  const postHoc = auditTurn(steps, 0, WS)
  assert.deepEqual(
    streaming.violations.map((v) => v.kind).sort(),
    postHoc.violations.map((v) => v.kind).sort(),
    'the streaming verdict and the final report must not disagree',
  )
})

// ---------------------------------------------------------------------------
// v0.5.0: kill-switch granularity (destructive vs escape)
// ---------------------------------------------------------------------------

test('classifyFinding splits findings into destructive / escape / neither', () => {
  assert.equal(classifyFinding('dangerous:reg-delete'), 'destructive')
  assert.equal(classifyFinding('dangerous:format'), 'destructive')
  assert.equal(classifyFinding('cd-outside'), 'escape')
  assert.equal(classifyFinding('write-outside'), 'escape')
  assert.equal(classifyFinding('read-outside'), undefined)
  assert.equal(classifyFinding('external-read'), undefined)
  assert.equal(classifyFinding(undefined), undefined)
  assert.equal(classifyFinding(''), undefined)
})

test('push reports a destructive command as blockedDestructive regardless of path', () => {
  const auditor = createAuditor(WS)
  // Inside the workspace: destructive is about the command, not the path.
  const verdict = auditor.push(
    runStep(0, `Set-Location -LiteralPath '${WS}'; reg delete HKCU\\Software\\X`),
  )
  assert.equal(verdict.blockedDestructive, true)
  assert.equal(verdict.blockedEscape, false)
  assert.equal(verdict.blocked, true)
})

test('push reports an outside write as blockedEscape only', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, `Set-Content 'C:\\evil\\payload.bat' -Value x`))
  assert.equal(verdict.blockedEscape, true)
  assert.equal(verdict.blockedDestructive, false)
  assert.equal(verdict.blocked, true)
})

test('push reports both granularities when one step trips both', () => {
  const auditor = createAuditor(WS)
  // cd outside (escape) + a dangerous command on the same line.
  const verdict = auditor.push(runStep(0, 'pushd C:\\Windows; del *.*'))
  assert.equal(verdict.blockedEscape, true)
  assert.ok(verdict.blockedDestructive, 'del *.* must be destructive')
  assert.equal(verdict.blocked, true)
})

test('a warn-level read-outside never blocks in either granularity', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push({
    step_index: 0,
    tool_calls: [{ name: 'view_file', args: { Path: 'C:\\Users\\testuser\\Desktop\\notes.txt' } }],
  })
  assert.equal(verdict.blocked, false)
  assert.equal(verdict.blockedDestructive, false)
  assert.equal(verdict.blockedEscape, false)
})

test('a clean command reports neither granularity', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, `Set-Location -LiteralPath '${WS}'; npm test`))
  assert.equal(verdict.blocked, false)
  assert.equal(verdict.blockedDestructive, false)
  assert.equal(verdict.blockedEscape, false)
})

// ---------------------------------------------------------------------------
// v0.5.0: hanging-command recognition
// ---------------------------------------------------------------------------

test('parseHangingCommand recognises dev servers and watch modes', () => {
  const hits = [
    'npm run dev',
    'pnpm run dev',
    'yarn dev',
    'bun run dev',
    'npm run preview',
    'npm run serve',
    'npm run start:dev',
    'vite',
    'npx vite',
    'vite preview',
    'next dev',
    'nuxt dev',
    'ng serve',
    'vitest',
    'npx vitest',
    'vitest watch',
    'jest --watch',
    'jest --watchAll',
    'npm test -- --watch',
    'tsc --watch',
    'sass --watch src:dist',
    'webpack --watch',
    'nodemon app.js',
    'uvicorn main:app --reload',
    'python -m http.server 8000',
    'php artisan serve',
    'rails server',
  ]
  for (const command of hits) {
    assert.ok(parseHangingCommand(command), `${command} must be recognised as hanging`)
  }
})

test('parseHangingCommand leaves one-shot commands alone', () => {
  const misses = [
    'npm test',
    'npm run build',
    'vite build',
    'vitest run',
    'vitest --run',
    'npx vitest run -q',
    'vitest --ci',
    'vitest --watch=false',
    'jest',
    'jest --coverage',
    'node --test lib/*.test.js',
    'python -m pytest -q',
    'npm run device-tests',
    `Set-Location -LiteralPath '${WS}'; npm test`,
  ]
  for (const command of misses) {
    assert.equal(parseHangingCommand(command), undefined, `${command} must not be flagged`)
  }
})

test('parseHangingCommand tolerates weird input', () => {
  assert.equal(parseHangingCommand(''), undefined)
  assert.equal(parseHangingCommand(undefined), undefined)
  assert.equal(parseHangingCommand(null), undefined)
  // Case-insensitive.
  assert.ok(parseHangingCommand('NPM RUN DEV'))
})

test('findHangingCommands maps hits onto the call index of a step', () => {
  const step = {
    step_index: 3,
    tool_calls: [
      { name: 'run_command', args: { CommandLine: 'npm test' } },
      { name: 'run_command', args: { CommandLine: 'npm run dev' } },
      { name: 'view_file', args: { Path: `${WS}\\a.js` } },
    ],
  }
  const hits = findHangingCommands(step)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].index, 1)
  assert.equal(hits[0].id, 'dev-server')
  assert.deepEqual(findHangingCommands({ step_index: 4, tool_calls: [] }), [])
  assert.deepEqual(findHangingCommands(undefined), [])
})
