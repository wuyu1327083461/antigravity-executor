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
  extractWriteTargets,
  findHangingCommands,
  isGitMetadataPath,
  isInside,
  isWriteTool,
  normalizePath,
  parseHangingCommand,
  renderAudit,
  resolveVirtualPath,
  writeToolPath,
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

// ---------------------------------------------------------------------------
// v0.6.0 (REQ-05): git-metadata writes are destructive, wherever they land
// ---------------------------------------------------------------------------
//
// The hole this closes is subtle enough to state in the tests themselves: a
// write to `<workspace>/.git/hooks/pre-commit` does NOT leave the workspace, so
// `write-outside` never fired, and with the shipped `failOnEscape: false`
// nothing blocked. The damage happens later, when the caller runs `git status`
// in that workspace and executes the hook. So these findings must be blocked by
// `realtimeKillSwitch` alone — the assertions below never mention `failOnEscape`
// because the auditor has no such option: it reports, the caller decides.

/** Join workspace-relative segments with the platform separator under test. */
const gitMeta = (...segments) => [WS, '.git', ...segments].join('\\')

test('isGitMetadataPath accepts hooks at any depth and .git/config', () => {
  assert.equal(isGitMetadataPath(`${WS}\\.git\\hooks\\pre-commit`), true)
  assert.equal(isGitMetadataPath(`${WS}\\.git\\hooks\\post-checkout`), true)
  // Any depth below hooks, and any casing / separator.
  assert.equal(isGitMetadataPath(`${WS}\\.git\\hooks\\sub\\dir\\x.sh`), true)
  assert.equal(isGitMetadataPath('E:/ws/.git/hooks/pre-commit'), true)
  assert.equal(isGitMetadataPath(`${WS}\\.GIT\\Hooks\\Pre-Commit`), true)
  assert.equal(isGitMetadataPath(`${WS}\\.git\\config`), true)
  // Relative spellings matter: the transcript stores what was typed.
  assert.equal(isGitMetadataPath('.git\\config'), true)
  assert.equal(isGitMetadataPath('./.git/hooks/pre-commit'), true)
  // Doubled backslashes are how run_command args arrive PowerShell-escaped.
  assert.equal(isGitMetadataPath(`${WS}\\\\.git\\\\hooks\\\\pre-commit`), true)
})

test('isGitMetadataPath rejects look-alikes', () => {
  // The critical false positive: every repo has one, so matching it would train
  // the user to ignore the whole finding class.
  assert.equal(isGitMetadataPath(`${WS}\\.gitignore`), false)
  assert.equal(isGitMetadataPath(`${WS}\\.gitattributes`), false)
  assert.equal(isGitMetadataPath(`${WS}\\.github\\workflows\\ci.yml`), false)
  assert.equal(isGitMetadataPath(`${WS}\\some.git\\config`), false)
  assert.equal(isGitMetadataPath(`${WS}\\hooks\\x.js`), false)
  // Not a `.git` directory: `git` is the segment, not `.git`.
  assert.equal(isGitMetadataPath(`${WS}\\src\\git\\config`), false)
  // `.git` itself, and other files below it, are not code-execution carriers.
  assert.equal(isGitMetadataPath(`${WS}\\.git`), false)
  assert.equal(isGitMetadataPath(`${WS}\\.git\\HEAD`), false)
  assert.equal(isGitMetadataPath(''), false)
})

test('classifyFinding maps the git-metadata kind to destructive', () => {
  assert.equal(classifyFinding('destructive_git_metadata_write'), 'destructive')
  // The pre-existing mappings must not have moved.
  assert.equal(classifyFinding('dangerous:format'), 'destructive')
  assert.equal(classifyFinding('cd-outside'), 'escape')
  assert.equal(classifyFinding('write-outside'), 'escape')
  assert.equal(classifyFinding('read-outside'), undefined)
  assert.equal(classifyFinding('not-a-kind'), undefined)
})

test('extractWriteTargets catches redirections and write verbs', () => {
  // The exact shape 0.5.1 missed: bare relative target after a redirect.
  assert.ok(extractWriteTargets('echo x > .git\\config').includes('.git\\config'))
  assert.ok(extractWriteTargets('echo x >> .git\\hooks\\pre-commit').includes('.git\\hooks\\pre-commit'))
  assert.ok(extractWriteTargets('Set-Content .git\\config -Value x').includes('.git\\config'))
  assert.ok(
    extractWriteTargets('Set-Content -Path .git\\hooks\\pre-commit -Value x').includes(
      '.git\\hooks\\pre-commit',
    ),
  )
  assert.ok(extractWriteTargets('Add-Content .git\\config -Value x').includes('.git\\config'))
  assert.ok(extractWriteTargets('"hi" | Out-File .git\\config').includes('.git\\config'))
  assert.ok(extractWriteTargets('New-Item -Path .git\\hooks\\x.ps1').includes('.git\\hooks\\x.ps1'))
  assert.ok(extractWriteTargets('Copy-Item a.txt b.txt').includes('b.txt'))
  // Absolute targets still come through.
  assert.ok(extractWriteTargets('Set-Content C:\\evil\\x.bat -Value y').includes('C:\\evil\\x.bat'))
})

test('extractWriteTargets is empty for reads and harmless input', () => {
  assert.deepEqual(extractWriteTargets(''), [])
  assert.deepEqual(extractWriteTargets(undefined), [])
  assert.deepEqual(extractWriteTargets('git status'), [])
  assert.deepEqual(extractWriteTargets('npm test'), [])
  // A read verb must not be mistaken for a write.
  assert.deepEqual(extractWriteTargets('Get-Content .git\\config'), [])
})

test('isWriteTool recognises native write tools, case-insensitively', () => {
  for (const name of [
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'edit_file',
    'create_file',
    'apply_patch',
    'delete_file',
    'insert_content',
    'notebook_edit',
    'WRITE_TO_FILE',
  ]) {
    assert.equal(isWriteTool(name), true, `${name} must be a write tool`)
  }
  for (const name of ['read_file', 'view_file', 'run_command', '', undefined]) {
    assert.equal(isWriteTool(name), false, `${name} must not be a write tool`)
  }
})

test('writeToolPath probes the known arg keys and decodes file:// URIs', () => {
  assert.equal(writeToolPath({ TargetFile: 'E:\\ws\\a.js' }), 'E:\\ws\\a.js')
  assert.equal(writeToolPath({ AbsolutePath: 'E:\\ws\\a.js' }), 'E:\\ws\\a.js')
  assert.equal(writeToolPath({ target_file: 'E:\\ws\\a.js' }), 'E:\\ws\\a.js')
  assert.equal(writeToolPath({ file_path: 'E:\\ws\\a.js' }), 'E:\\ws\\a.js')
  // RPC carriers send a URL; the auditor compares plain paths.
  assert.equal(writeToolPath({ absolutePathUri: 'file:///E:/ws/a.js' }), 'E:/ws/a.js')
  assert.equal(writeToolPath({ uri: 'file:///E:/my%20ws/a.js' }), 'E:/my ws/a.js')
  assert.equal(writeToolPath({}), undefined)
  assert.equal(writeToolPath(undefined), undefined)
})

test('a run_command write to .git/hooks is blockedDestructive (Set-Content)', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, 'Set-Content .git\\hooks\\pre-commit -Value pwn'))
  assert.equal(verdict.blockedDestructive, true, 'the kill switch must fire with no failOnEscape')
  const hit = verdict.violations.find((v) => v.kind === 'destructive_git_metadata_write')
  assert.ok(hit, 'expected a destructive_git_metadata_write finding')
  assert.equal(hit.severity, 'error')
  // The path is resolved against the workspace, not left relative.
  assert.equal(normalizePath(hit.path), normalizePath(gitMeta('hooks', 'pre-commit')))
  assert.match(hit.why, /Git 元数据/)
})

test('a run_command write to .git/config is blockedDestructive (redirect)', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, 'echo hooksPath=. > .git\\config'))
  assert.equal(verdict.blockedDestructive, true)
  assert.ok(verdict.violations.some((v) => v.kind === 'destructive_git_metadata_write'))
  // Never an escape: the path stayed inside the workspace.
  assert.equal(verdict.blockedEscape, false)
})

test('a native write tool to git metadata is blockedDestructive', () => {
  for (const tool of ['write_to_file', 'replace_file_content']) {
    const auditor = createAuditor(WS)
    const verdict = auditor.push({
      step_index: 0,
      tool_calls: [{ name: tool, args: { TargetFile: gitMeta('hooks', 'pre-commit') } }],
    })
    assert.equal(verdict.blockedDestructive, true, `${tool} must be destructive`)
    const hit = verdict.violations.find((v) => v.kind === 'destructive_git_metadata_write')
    assert.ok(hit, `${tool} must record the git-metadata finding`)
    assert.equal(normalizePath(hit.path), normalizePath(gitMeta('hooks', 'pre-commit')))
  }
})

test('an outside-workspace git-metadata write trips BOTH kinds', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, 'Set-Content C:\\shared\\.git\\config -Value x'))
  const kinds = verdict.violations.map((v) => v.kind)
  assert.ok(kinds.includes('destructive_git_metadata_write'), 'git metadata must be flagged')
  assert.ok(kinds.includes('write-outside'), 'leaving the workspace must still be flagged')
  assert.equal(verdict.blockedDestructive, true)
  assert.equal(verdict.blockedEscape, true)
})

test('a write to .gitignore, .github or src/git/config is not blocked', () => {
  for (const target of ['.gitignore', '.github\\workflows\\ci.yml', 'src\\git\\config']) {
    const auditor = createAuditor(WS)
    const verdict = auditor.push(runStep(0, `Set-Content ${target} -Value x`))
    assert.equal(verdict.blockedDestructive, false, `${target} must not be destructive`)
    assert.deepEqual(
      verdict.violations.map((v) => v.kind),
      [],
      `${target} must produce no finding`,
    )
  }
})

test('a native write tool outside the workspace is a write-outside finding', () => {
  // 0.5.1 had no handler for native write tools at all, so this was invisible.
  const auditor = createAuditor(WS)
  const verdict = auditor.push({
    step_index: 0,
    tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'C:\\evil\\payload.bat' } }],
  })
  const hit = verdict.violations.find((v) => v.kind === 'write-outside')
  assert.ok(hit, 'a native write outside the workspace must escape')
  assert.equal(hit.severity, 'error')
  assert.equal(verdict.blockedEscape, true)
  assert.equal(verdict.blockedDestructive, false)
})

test('a native write inside the workspace stays clean', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push({
    step_index: 0,
    tool_calls: [{ name: 'replace_file_content', args: { TargetFile: `${WS}\\src\\a.js` } }],
  })
  assert.equal(verdict.blocked, false)
  assert.deepEqual(verdict.violations, [])
})

// ---------------------------------------------------------------------------
// v0.6.0 (REQ-03 / REQ-07): touchedFiles and fileWrites
// ---------------------------------------------------------------------------
//
// `touchedFiles` is persisted into the session record so a rebuilt session can
// be told which files the thread was about; `fileWrites` is what distinguishes
// "really wrote files" from "only said it did" when the git worktree is clean.
// Both are only useful if they are *reported*, so these tests assert on
// `report()` — the field that actually reaches the caller.

test('report() keeps the five v0.5.x fields and adds the two v0.6.0 ones', () => {
  const report = createAuditor(WS).report()
  // Old shape, unchanged.
  assert.deepEqual(report.violations, [])
  assert.deepEqual(report.externalReads, [])
  assert.equal(report.commandCount, 0)
  assert.equal(report.writeCount, 0)
  assert.equal(report.readCount, 0)
  // New shape, defined from the start rather than appearing after the first write.
  assert.deepEqual(report.touchedFiles, [])
  assert.equal(report.fileWrites, 0)
})

test('touchedFiles collects inside-workspace reads and writes, in first-touch order', () => {
  const auditor = createAuditor(WS)
  auditor.push({
    step_index: 0,
    tool_calls: [{ name: 'view_file', args: { Path: `${WS}\\src\\a.js` } }],
  })
  auditor.push({
    step_index: 1,
    tool_calls: [{ name: 'write_to_file', args: { TargetFile: `${WS}\\src\\b.js` } }],
  })
  auditor.push(runStep(2, 'Set-Content src\\c.js -Value x'))
  const report = auditor.report()
  assert.equal(report.touchedFiles.length, 3)
  assert.equal(normalizePath(report.touchedFiles[0]), normalizePath(`${WS}\\src\\a.js`))
  assert.equal(normalizePath(report.touchedFiles[1]), normalizePath(`${WS}\\src\\b.js`))
  assert.equal(normalizePath(report.touchedFiles[2]), normalizePath(`${WS}\\src\\c.js`))
})

test('touchedFiles excludes outside paths, the workspace root and duplicates', () => {
  const auditor = createAuditor(WS)
  auditor.push({
    step_index: 0,
    tool_calls: [{ name: 'view_file', args: { Path: 'C:\\Users\\me\\Desktop\\notes.txt' } }],
  })
  auditor.push({ step_index: 1, tool_calls: [{ name: 'view_file', args: { Path: WS } }] })
  // The same file twice, spelled differently: one entry, first casing kept.
  auditor.push({
    step_index: 2,
    tool_calls: [{ name: 'view_file', args: { Path: `${WS}\\src\\a.js` } }],
  })
  auditor.push({
    step_index: 3,
    tool_calls: [{ name: 'view_file', args: { Path: `${WS.toLowerCase()}/SRC/a.js` } }],
  })
  const report = auditor.report()
  assert.equal(report.touchedFiles.length, 1, 'outside paths and the root must not be touched')
  assert.equal(report.touchedFiles[0], `${WS}\\src\\a.js`)
})

test('touchedFiles is a copy: a caller cannot mutate the auditor through it', () => {
  const auditor = createAuditor(WS)
  auditor.push({ step_index: 0, tool_calls: [{ name: 'view_file', args: { Path: `${WS}\\a.js` } }] })
  const first = auditor.report()
  assert.equal(first.touchedFiles.length, 1)
  first.touchedFiles.push('INJECTED')
  assert.equal(first.touchedFiles.length, 2)
  // The auditor's own list must be untouched by the caller's push.
  assert.equal(auditor.report().touchedFiles.length, 1)
  assert.ok(!auditor.report().touchedFiles.includes('INJECTED'))
  // push() hands out a copy too: a streaming verdict already read must not change.
  const verdict = auditor.push({ step_index: 1, tool_calls: [] })
  verdict.touchedFiles.push('ALSO-INJECTED')
  assert.equal(auditor.report().touchedFiles.length, 1)
})

test('touchedFiles is capped at 20 entries', () => {
  const auditor = createAuditor(WS)
  for (let i = 0; i < 30; i += 1) {
    auditor.push({
      step_index: i,
      tool_calls: [{ name: 'view_file', args: { Path: `${WS}\\src\\f${i}.js` } }],
    })
  }
  assert.equal(auditor.report().touchedFiles.length, 20)
})

test('fileWrites counts a write-shaped command once, however many files it names', () => {
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, 'Copy-Item a.txt b.txt, c.txt'))
  assert.equal(verdict.fileWrites, 1, 'one command is one write operation')
  assert.equal(auditor.report().fileWrites, 1)
})

test('fileWrites counts native write tools and ignores reads', () => {
  const auditor = createAuditor(WS)
  auditor.push({ step_index: 0, tool_calls: [{ name: 'view_file', args: { Path: `${WS}\\a.js` } }] })
  assert.equal(auditor.report().fileWrites, 0, 'a read is not a write')
  auditor.push({ step_index: 1, tool_calls: [{ name: 'write_to_file', args: { TargetFile: `${WS}\\a.js` } }] })
  auditor.push({ step_index: 2, tool_calls: [{ name: 'replace_file_content', args: { TargetFile: `${WS}\\b.js` } }] })
  assert.equal(auditor.report().fileWrites, 2)
})

test('fileWrites counts a redirect even when the verb is not a write verb', () => {
  // `echo` is not in the write table, but `> note.txt` creates a file.
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, 'echo hi > note.txt'))
  assert.equal(auditor.report().fileWrites, 1)
})

test('auditTurn inherits touchedFiles and fileWrites', () => {
  const report = auditTurn(
    steps(
      { name: 'view_file', args: { Path: `${WS}\\src\\a.js` } },
      { name: 'write_to_file', args: { TargetFile: `${WS}\\src\\b.js` } },
    ),
    0,
    WS,
  )
  assert.equal(report.fileWrites, 1)
  assert.equal(report.touchedFiles.length, 2)
})

// ---------------------------------------------------------------------------
// v0.6.0 (REQ-05): report rendering
// ---------------------------------------------------------------------------

test('renderAudit renders the git-metadata kind with its path', () => {
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, 'Set-Content .git\\hooks\\pre-commit -Value pwn'))
  const block = renderAudit(auditor.report(), WS)
  assert.match(block, /destructive_git_metadata_write/)
  assert.match(block, /pre-commit/)
  assert.match(block, /\[error\] step 0/)
})

test('renderAudit names the git-metadata hazard instead of a plain escape', () => {
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, 'Set-Content .git\\config -Value x'))
  const block = renderAudit(auditor.report(), WS)
  // Telling the user "wrote outside the workspace" here would send them looking
  // outside a workspace whose *inside* is the problem.
  assert.match(block, /DANGEROUS GIT METADATA/)
  assert.match(block, /git status/)
  assert.ok(
    !block.includes('the executor wrote outside the workspace or ran a'),
    'an inside-workspace hook write must not be described as an escape',
  )
})

test('renderAudit keeps the escape advice for a genuine outside write', () => {
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, "Set-Content 'C:\\evil\\payload.bat' -Value x"))
  const block = renderAudit(auditor.report(), WS)
  assert.match(block, /wrote outside the workspace/)
  assert.ok(!block.includes('DANGEROUS GIT METADATA'))
})

test('renderAudit keeps the activity line and stays quiet on a clean turn', () => {
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, 'npm test'))
  const block = renderAudit(auditor.report(), WS)
  assert.match(block, /^activity {5}: 1 command\(s\), 0 read\(s\), 0 write-shaped command\(s\)$/m)
  assert.match(block, /verdict {6}: CLEAN/)
  // No findings, no touched files: no extra advice to read.
  assert.ok(!block.includes('DO NOT ACCEPT'))
})

// ---------------------------------------------------------------------------
// v0.6.0: false-positive guards found while self-reviewing the first cut
// ---------------------------------------------------------------------------
//
// Each of these was a real defect in the first implementation, not a
// hypothetical: a redirect into `/dev/null` produced a write-outside finding,
// `echo "a > b"` produced a target called `b`, and every directory verb put a
// directory into touchedFiles. They are pinned here because a noisy audit is an
// ignored audit, and an ignored audit is worse than none.

test('a redirect into a null device is not a write finding', () => {
  // The single most common shell idiom there is.
  for (const command of ['npm test > /dev/null', 'npm test 2>/dev/null', 'node build.js > NUL']) {
    const auditor = createAuditor(WS)
    const verdict = auditor.push(runStep(0, command))
    assert.deepEqual(verdict.violations, [], `${command} must not produce a finding`)
    assert.equal(auditor.report().fileWrites, 0, `${command} writes no file`)
  }
})

test('a redirection operator inside quotes is not a write', () => {
  // `echo "a > b"` prints the text; it creates no file called `b`.
  const auditor = createAuditor(WS)
  const verdict = auditor.push(runStep(0, 'echo "a > b"'))
  assert.deepEqual(verdict.violations, [])
  assert.deepEqual(auditor.report().touchedFiles, [])
})

test('a quoted path with spaces survives as one target', () => {
  // The other side of the blanking rule: a quoted *path* must not be dropped.
  const auditor = createAuditor(WS)
  auditor.push(runStep(0, 'Set-Content "my file.txt" -Value x'))
  const touched = auditor.report().touchedFiles
  assert.equal(touched.length, 1)
  assert.match(touched[0], /my file\.txt$/)
})

test('directory verbs do not populate touchedFiles', () => {
  for (const command of [
    'mkdir -p src/new',
    'md out',
    'New-Item -ItemType Directory -Path build',
    'rd /s /q build',
    'rmdir build',
  ]) {
    const auditor = createAuditor(WS)
    auditor.push(runStep(0, command))
    assert.deepEqual(auditor.report().touchedFiles, [], `${command} names a directory`)
  }
})

test('a file delete still populates touchedFiles', () => {
  // The counterpart to the directory rule: `Remove-Item notes.txt` deletes a
  // FILE, and that file is exactly what a follow-up request would name.
  for (const command of ['Remove-Item notes.txt', 'del notes.txt', 'rm notes.txt']) {
    const auditor = createAuditor(WS)
    auditor.push(runStep(0, command))
    const touched = auditor.report().touchedFiles
    assert.equal(touched.length, 1, `${command} must touch one file`)
    assert.match(touched[0], /notes\.txt$/)
  }
})

test('a quoted git-metadata target is still caught', () => {
  // Quoting is the obvious evasion: `Set-Content ".git\config"` must not hide.
  for (const command of ['Set-Content ".git\\config" -Value x', 'echo x > ".git\\hooks\\pre-commit"']) {
    const auditor = createAuditor(WS)
    const verdict = auditor.push(runStep(0, command))
    assert.equal(verdict.blockedDestructive, true, `${command} must be destructive`)
    assert.ok(verdict.violations.some((v) => v.kind === 'destructive_git_metadata_write'))
  }
})
