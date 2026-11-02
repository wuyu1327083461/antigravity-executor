/**
 * Tests for lib/commands.js (CONTRACT.md §7.3, REQ-02).
 *
 * The first test in each group is the one that matters most: a missing exit
 * code must stay `null`. Defaulting it to 0 would report a failed turn as a
 * success, which is the entire reason this module exists.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractRunCommands,
  isVerificationCommand,
  summarizeCommands,
  renderCommandSummary,
  verificationWarning,
} from './commands.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A normalized step (CONTRACT.md §4) wrapping a raw RPC step, exactly as
 * `normalizeStep` builds it: `step_index` is snake_case while every RPC field
 * lives under `raw`.
 */
function runStep({
  stepIndex = 0,
  argumentsJson,
  commandLine,
  exitCode,
  output,
  cwd,
  type = 'RUN_COMMAND',
  toolName = 'run_command',
} = {}) {
  const raw = {
    type: `CORTEX_STEP_TYPE_${type}`,
    metadata: { toolCall: { name: toolName } },
    runCommand: {
      commandLine,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(output === undefined ? {} : { combinedOutput: { full: output } }),
    },
  }
  if (argumentsJson !== undefined) raw.metadata.toolCall.argumentsJson = argumentsJson
  return {
    step_index: stepIndex,
    type,
    status: 'DONE',
    created_at: '2026-11-02T00:00:00Z',
    content: '',
    tool_calls: commandLine
      ? [{ name: 'run_command', args: { CommandLine: commandLine } }]
      : [],
    raw,
  }
}

function plannerStep(stepIndex = 1) {
  return {
    step_index: stepIndex,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-02T00:00:00Z',
    content: 'All tests pass!',
    tool_calls: [],
    raw: { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'done' } },
  }
}

/** A command object as returned by `extractRunCommands`, for render tests. */
function command(overrides = {}) {
  return {
    stepIndex: 0,
    command: 'npm test',
    cwd: null,
    exitCode: 0,
    outputTail: '',
    failed: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// extractRunCommands — the null-not-0 rule
// ---------------------------------------------------------------------------

test('extractRunCommands: missing exitCode is null, never 0', () => {
  const [result] = extractRunCommands([runStep({ commandLine: 'npm test' })])

  assert.equal(result.exitCode, null)
  assert.notEqual(result.exitCode, 0, '0 is the strong assertion "succeeded" and must never be guessed')
  assert.equal(result.failed, false, 'null is "unknown" — it must not be reported as a failure either')
})

test('extractRunCommands: explicit exitCode 0 survives as 0', () => {
  const [result] = extractRunCommands([runStep({ commandLine: 'npm run build', exitCode: 0 })])

  assert.equal(result.exitCode, 0)
  assert.equal(result.failed, false)
})

test('extractRunCommands: non-zero exitCode is failed', () => {
  const [result] = extractRunCommands([runStep({ commandLine: 'npx vitest run', exitCode: 1 })])

  assert.equal(result.exitCode, 1)
  assert.equal(result.failed, true)
})

test('extractRunCommands: no run_command steps → empty array', () => {
  assert.deepEqual(extractRunCommands([]), [])
  assert.deepEqual(extractRunCommands([plannerStep()]), [])
  assert.deepEqual(
    extractRunCommands([
      {
        step_index: 2,
        type: 'VIEW_FILE',
        content: '',
        tool_calls: [{ name: 'view_file', args: { Path: 'F:\\work\\app\\a.js' } }],
        raw: { type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { path: 'a.js' } },
      },
    ]),
    [],
  )
})

test('extractRunCommands: tolerates a missing/non-array argument', () => {
  assert.deepEqual(extractRunCommands(undefined), [])
  assert.deepEqual(extractRunCommands(null), [])
  assert.deepEqual(extractRunCommands('nope'), [])
})

// ---------------------------------------------------------------------------
// exitCode source priority (CONTRACT.md §7.3)
// ---------------------------------------------------------------------------

test('extractRunCommands: runCommand.exitCode wins over metadata.commandResult', () => {
  const step = runStep({ commandLine: 'npm test', exitCode: 2 })
  step.raw.metadata.commandResult = { exitCode: 0 }
  step.raw.taskDetails = { exitCode: 0 }

  assert.equal(extractRunCommands([step])[0].exitCode, 2)
})

test('extractRunCommands: metadata.commandResult.exitCode wins over taskDetails', () => {
  const step = runStep({ commandLine: 'npm test' })
  step.raw.metadata.commandResult = { exitCode: 1 }
  step.raw.taskDetails = { exitCode: 0 }

  assert.equal(extractRunCommands([step])[0].exitCode, 1)
})

test('extractRunCommands: falls back to taskDetails.exitCode', () => {
  const step = runStep({ commandLine: 'jest' })
  step.raw.taskDetails = { exitCode: 3 }

  assert.equal(extractRunCommands([step])[0].exitCode, 3)
})

test('extractRunCommands: falls back to an "exit code N" line in the output', () => {
  const step = runStep({
    commandLine: 'npm test',
    output: '> app@1.0.0 test\nfailed 3 tests\n\nCommand finished with exit code 1\n',
  })

  const [result] = extractRunCommands([step])
  assert.equal(result.exitCode, 1)
  assert.equal(result.failed, true)
})

test('extractRunCommands: output regex handles a negative code and spacing', () => {
  const [a] = extractRunCommands([runStep({ commandLine: 'x', output: 'exit code: -1' })])
  const [b] = extractRunCommands([runStep({ commandLine: 'x', output: 'Exit Code 7' })])

  assert.equal(a.exitCode, -1)
  assert.equal(b.exitCode, 7)
})

test('extractRunCommands: unparseable exitCode carriers fall through to null', () => {
  const step = runStep({ commandLine: 'npm test' })
  step.raw.runCommand.exitCode = 'not-a-number'
  step.raw.metadata.commandResult = { exitCode: null }

  assert.equal(extractRunCommands([step])[0].exitCode, null)
})

// ---------------------------------------------------------------------------
// command source priority + argumentsJson double parse
// ---------------------------------------------------------------------------

test('extractRunCommands: command comes from argumentsJson (a STRING)', () => {
  const step = runStep({
    argumentsJson: JSON.stringify({ CommandLine: 'npm run build -- --mode=prod' }),
  })

  assert.equal(extractRunCommands([step])[0].command, 'npm run build -- --mode=prod')
})

test('extractRunCommands: malformed argumentsJson does not throw and is skipped', () => {
  const step = runStep({ commandLine: 'pytest -q' })
  step.raw.metadata.toolCall.argumentsJson = '{"CommandLine": "npm test"' // truncated JSON

  assert.doesNotThrow(() => extractRunCommands([step]))
  assert.equal(extractRunCommands([step])[0].command, 'pytest -q', 'falls back to tool_calls[].args')
})

test('extractRunCommands: falls back to tool_calls[].args.CommandLine without argumentsJson', () => {
  const step = runStep({ commandLine: 'tsc --noEmit' })

  assert.equal(extractRunCommands([step])[0].command, 'tsc --noEmit')
})

test('extractRunCommands: falls back to runCommand.commandLine for a bare RPC step', () => {
  // No normalization wrapper at all: the raw RPC step is passed directly.
  const rawStep = {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    metadata: { toolCall: { name: 'run_command' } },
    runCommand: { commandLine: 'go test ./...', exitCode: 0, combinedOutput: { full: 'ok' } },
  }

  const [result] = extractRunCommands([rawStep])
  assert.equal(result.command, 'go test ./...')
  assert.equal(result.exitCode, 0)
  assert.equal(result.cwd, null)
})

test('extractRunCommands: detects a GENERIC step by toolCall.name, not by type', () => {
  // CONTRACT §1: while generating, a tool step may still look like GENERIC.
  const step = runStep({ commandLine: 'npm test', exitCode: 1, type: 'GENERIC' })

  const results = extractRunCommands([step])
  assert.equal(results.length, 1)
  assert.equal(results[0].command, 'npm test')
  assert.equal(results[0].exitCode, 1)
})

test('extractRunCommands: cwd comes from argumentsJson, else null', () => {
  const withCwd = runStep({
    argumentsJson: JSON.stringify({ CommandLine: 'npm test', cwd: 'F:\\work\\app' }),
  })
  const withoutCwd = runStep({ commandLine: 'ls' })

  assert.equal(extractRunCommands([withCwd])[0].cwd, 'F:\\work\\app')
  assert.equal(extractRunCommands([withoutCwd])[0].cwd, null)
})

test('extractRunCommands: stepIndex reads snake_case step_index, else position', () => {
  const indexed = runStep({ stepIndex: 7, commandLine: 'npm test' })
  const bare = { type: 'RUN_COMMAND', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }

  const [first] = extractRunCommands([plannerStep(0), indexed])
  assert.equal(first.stepIndex, 7)

  const results = extractRunCommands([plannerStep(), bare])
  assert.equal(results[0].stepIndex, 1, 'positional fallback when the step has no index')
})

// ---------------------------------------------------------------------------
// outputTail — 20 lines, 1500 chars, cut from the head
// ---------------------------------------------------------------------------

test('extractRunCommands: outputTail keeps only the last 20 lines', () => {
  const output = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n')
  const [result] = extractRunCommands([runStep({ commandLine: 'npm test', exitCode: 1, output })])

  const lines = result.outputTail.split('\n')
  assert.equal(lines.length, 20)
  assert.equal(lines[0], 'line 6')
  assert.equal(lines[19], 'line 25')
})

test('extractRunCommands: outputTail is capped at 1500 chars, keeping the tail', () => {
  const marker = 'AssertionError: expected 200 to equal 500'
  const filler = Array.from({ length: 19 }, (_, i) => `${i}-`.padEnd(300, 'x'))
  const output = [...filler, marker].join('\n')
  assert.ok(output.length > 4000)

  const [result] = extractRunCommands([runStep({ commandLine: 'npx vitest run', exitCode: 1, output })])

  assert.ok(result.outputTail.length <= 1500, `got ${result.outputTail.length} chars`)
  assert.ok(result.outputTail.endsWith(marker), 'the stack tail must survive truncation')
  assert.ok(!result.outputTail.includes('0-'), 'truncation happens from the HEAD, not the tail')
})

test('extractRunCommands: outputTail falls back to step.content then empty string', () => {
  const fromContent = {
    step_index: 0,
    type: 'RUN_COMMAND',
    content: 'boom',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
    raw: { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { commandLine: 'npm test', exitCode: 1 } },
  }
  const [a] = extractRunCommands([fromContent])
  const [b] = extractRunCommands([runStep({ commandLine: 'npm test' })])

  assert.equal(a.outputTail, 'boom')
  assert.equal(b.outputTail, '')
})

test('extractRunCommands: combinedOutput as a plain string is accepted', () => {
  const step = runStep({ commandLine: 'npm test', exitCode: 1 })
  step.raw.runCommand.combinedOutput = 'plain failure output'

  assert.equal(extractRunCommands([step])[0].outputTail, 'plain failure output')
})

// ---------------------------------------------------------------------------
// isVerificationCommand
// ---------------------------------------------------------------------------

test('isVerificationCommand: recognises tests, builds, linters, type checks', () => {
  const positive = [
    'npm test',
    'npm run build',
    'npm run lint',
    'npm run test:unit',
    'pnpm run typecheck',
    'npx vitest run',
    'vitest run',
    'vitest run --coverage',
    'jest',
    'npx jest --ci',
    'tsc --noEmit',
    'npx tsc -p tsconfig.json',
    'eslint .',
    'npx eslint src',
    'biome check .',
    'pytest -q',
    'python -m pytest tests/',
    'go build ./...',
    'go test ./...',
    'cargo build --release',
    'cargo test',
    'mvn -q test',
    './gradlew build',
    'gradle test',
    'dotnet build',
    'node --test lib/commands.test.js',
    'node --check .\\js\\main.js',
    'cd app && npm test',
    'CI=1 npm test',
    // PowerShell land (the delegated executor's real shell, CONTRACT.md §1):
    "Set-Location -LiteralPath 'F:\\work\\app'; npm test",
    "Set-Location -LiteralPath 'F:\\work\\app'; node --check .\\js\\core.js",
    "Set-Location -LiteralPath 'F:\\work\\app'; python -m pytest -q",
    '& npm test',
    'Start-Process -FilePath npm test',
  ]

  for (const commandLine of positive) {
    assert.equal(isVerificationCommand(commandLine), true, `expected verification: ${commandLine}`)
  }
})

test('isVerificationCommand: pure navigation is NOT verification', () => {
  // The most frequent real command observed on disk is directory setup only.
  const navigation = [
    "Set-Location -LiteralPath 'C:\\Users\\kiuhg\\Desktop\\1'",
    "Set-Location -LiteralPath 'F:\\work\\app'; Get-ChildItem",
    'cd src',
    'cd src; pwd',
    'pushd .',
  ]

  for (const commandLine of navigation) {
    assert.equal(isVerificationCommand(commandLine), false, `expected NON-verification: ${commandLine}`)
  }
})

test('isVerificationCommand: navigation/snapshot/read commands are NOT verification', () => {
  const negative = [
    'ls',
    'ls -la',
    'cat package.json',
    'cd src',
    'git status',
    'git diff --stat',
    'git log --oneline -5',
    'echo done',
    'rm -rf dist',
    'npm install',
    'pnpm add vitest',
    'go get ./...',
    'cargo fmt',
    'node -e "console.log(1)"',
    'curl https://api.test/build/status',
    'cat build.log',
    'git commit -m "test build"',
    '',
  ]

  for (const commandLine of negative) {
    assert.equal(isVerificationCommand(commandLine), false, `expected NON-verification: ${commandLine}`)
  }
})

test('isVerificationCommand: tolerates non-string input', () => {
  assert.equal(isVerificationCommand(undefined), false)
  assert.equal(isVerificationCommand(null), false)
  assert.equal(isVerificationCommand(42), false)
})

// ---------------------------------------------------------------------------
// summarizeCommands
// ---------------------------------------------------------------------------

test('summarizeCommands: counts and picks the LAST verification command', () => {
  const commands = [
    command({ command: 'ls', exitCode: 0 }),
    command({ command: 'npx vitest run', exitCode: 1, failed: true }),
    command({ command: 'git status', exitCode: 0 }),
    command({ command: 'npm run build', exitCode: 0 }),
  ]

  const summary = summarizeCommands(commands)
  assert.equal(summary.total, 4)
  assert.equal(summary.failed, 1)
  assert.equal(summary.lastVerification.command, 'npm run build')
  assert.equal(summary.verificationFailed, false)
})

test('summarizeCommands: a trailing non-verification command does not hide a failure', () => {
  const commands = [
    command({ command: 'npx vitest run', exitCode: 1, failed: true }),
    command({ command: 'echo inspected', exitCode: 0 }),
  ]

  const summary = summarizeCommands(commands)
  assert.equal(summary.lastVerification.command, 'npx vitest run')
  assert.equal(summary.verificationFailed, true)
})

test('summarizeCommands: unknown exitCode is not a failure', () => {
  const summary = summarizeCommands([command({ command: 'npm test', exitCode: null, failed: false })])

  assert.equal(summary.verificationFailed, false)
  assert.equal(summary.failed, 0)
})

test('summarizeCommands: empty input', () => {
  assert.deepEqual(summarizeCommands([]), {
    total: 0,
    failed: 0,
    lastVerification: null,
    verificationFailed: false,
  })
  assert.equal(summarizeCommands(undefined).total, 0)
})

// ---------------------------------------------------------------------------
// renderCommandSummary — byte-for-byte CONTRACT.md §7.3
// ---------------------------------------------------------------------------

test('renderCommandSummary: matches the §7.3 sample exactly', () => {
  const commands = [
    command({ stepIndex: 3, command: 'npm run build', exitCode: 0 }),
    command({
      stepIndex: 5,
      command: 'npx vitest run',
      cwd: 'F:\\work\\app',
      exitCode: 1,
      outputTail: 'AssertionError [ERR_ASSERTION]: expected 200 to equal 500',
      failed: true,
    }),
  ]

  const expected = [
    '[Command Execution Summary]',
    '  ✅ Exit 0: npm run build',
    '  ❌ Exit 1: npx vitest run',
    '     cwd  : F:\\work\\app',
    '     tail :',
    '       AssertionError [ERR_ASSERTION]: expected 200 to equal 500',
  ].join('\n')

  assert.equal(renderCommandSummary(commands), expected)
})

test('renderCommandSummary: no commands → undefined', () => {
  assert.equal(renderCommandSummary([]), undefined)
  assert.equal(renderCommandSummary(undefined), undefined)
})

test('renderCommandSummary: unknown exit code renders ❔ and never "Exit 0"', () => {
  const rendered = renderCommandSummary([command({ command: 'npm test', exitCode: null })])

  assert.match(rendered, /❔ Exit unknown: npm test/)
  assert.doesNotMatch(rendered, /Exit 0/)
})

test('renderCommandSummary: multi-line tail keeps the 7-space indent', () => {
  const rendered = renderCommandSummary([
    command({
      command: 'pytest -q',
      cwd: 'F:\\work\\app',
      exitCode: 2,
      outputTail: 'FAILED tests/test_api.py::test_create\nE   assert 200 == 500',
      failed: true,
    }),
  ])

  assert.match(rendered, /^ {7}FAILED tests\/test_api\.py::test_create$/m)
  assert.match(rendered, /^ {7}E {3}assert 200 == 500$/m)
})

test('renderCommandSummary: maxCommands keeps the newest commands', () => {
  const commands = Array.from({ length: 5 }, (_, i) =>
    command({ command: `echo ${i}`, exitCode: 0 }),
  )

  const rendered = renderCommandSummary(commands, { maxCommands: 2 })
  const lines = rendered.split('\n')

  assert.equal(lines[0], '[Command Execution Summary]')
  assert.match(lines[1], /3 earlier command\(s\) omitted/)
  assert.match(rendered, /echo 3/)
  assert.match(rendered, /echo 4/)
  assert.doesNotMatch(rendered, /echo 0/)
})

// ---------------------------------------------------------------------------
// verificationWarning — the fake-success interceptor
// ---------------------------------------------------------------------------

test('verificationWarning: matches the §7.3 line exactly', () => {
  const commands = [command({ command: 'npx vitest run', exitCode: 1, failed: true })]

  assert.equal(
    verificationWarning(commands),
    '[⚠️ Verification Warning: The last executed command exited with code 1. Inspect the error output below before accepting.]',
  )
})

test('verificationWarning: uses the real exit code', () => {
  const commands = [command({ command: 'npm test', exitCode: 2, failed: true })]

  assert.equal(
    verificationWarning(commands),
    '[⚠️ Verification Warning: The last executed command exited with code 2. Inspect the error output below before accepting.]',
  )
})

test('verificationWarning: silent when the LAST verification passed, even after an earlier failure', () => {
  const commands = [
    command({ command: 'npx vitest run', exitCode: 1, failed: true }),
    command({ command: 'git status', exitCode: 0 }),
    command({ command: 'npm test', exitCode: 0 }),
  ]

  assert.equal(verificationWarning(commands), undefined)
})

test('verificationWarning: silent when no verification command ran (e.g. only ls/cat)', () => {
  assert.equal(verificationWarning([]), undefined)
  assert.equal(verificationWarning([command({ command: 'ls', exitCode: 1, failed: true })]), undefined)
  assert.equal(verificationWarning([command({ command: 'git status', exitCode: 1, failed: true })]), undefined)
})

test('verificationWarning: silent when the verification exit code is unknown', () => {
  assert.equal(verificationWarning([command({ command: 'npm test', exitCode: null })]), undefined)
})

// ---------------------------------------------------------------------------
// Real transcript pairing (verified against ~/.gemini/antigravity/brain)
// ---------------------------------------------------------------------------

/**
 * A real transcript pair, copied from an on-disk `transcript_full.jsonl`:
 * the tool call lives on a PLANNER_RESPONSE row and its result is the *next*
 * GENERIC row. Neither row carries `runCommand`, `metadata` or `exitCode`.
 */
function transcriptPair(commandLine, exitCode, output) {
  return [
    {
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-10-29T07:10:15Z',
      content: '我来检查一下工作区。',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: commandLine, WaitMsBeforeAsync: 5000, toolSummary: 'check' },
        },
      ],
    },
    {
      step_index: 1,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-10-29T15:10:15+08:00',
      content:
        `Created At: 2026-10-29T15:10:15+08:00\n` +
        `Completed At: 2026-10-29T15:10:17+08:00\n` +
        `Command exited with code ${exitCode}.\n\n` +
        `Command output:\n${output}`,
    },
  ]
}

test('transcript: pairs a tool-call row with its following result row', () => {
  const steps = transcriptPair(
    "Set-Location -LiteralPath 'F:\\work\\app'; npm test",
    1,
    'FAIL tests/api.test.js\n  AssertionError: expected 200 to equal 500\n',
  )

  const commands = extractRunCommands(steps)
  assert.equal(commands.length, 1, 'the result row must not be emitted as its own command')
  assert.equal(commands[0].command, "Set-Location -LiteralPath 'F:\\work\\app'; npm test")
  assert.equal(commands[0].exitCode, 1)
  assert.equal(commands[0].failed, true)
  assert.match(commands[0].outputTail, /AssertionError: expected 200 to equal 500/)
})

test('transcript: "Command exited with code N." is read even without the `exit code` spelling', () => {
  // The dominant on-disk spelling (313 occurrences) is "Command exited with
  // code N." — the plain /exit code/ regex misses it entirely.
  const [a] = extractRunCommands(transcriptPair('npm test', 1, 'boom'))
  const [b] = extractRunCommands(transcriptPair('npm test', 0, 'ok'))

  assert.equal(a.exitCode, 1)
  assert.equal(b.exitCode, 0)
  assert.equal(b.failed, false)
})

test('transcript: the result-row envelope is stripped from outputTail', () => {
  const steps = transcriptPair('npm run build', 1, 'error TS2304: Cannot find name "foo"\n')
  const [result] = extractRunCommands(steps)

  assert.doesNotMatch(result.outputTail, /Created At/, 'timestamps are noise in a report')
  assert.doesNotMatch(result.outputTail, /Completed At/)
  assert.doesNotMatch(result.outputTail, /Command exited with code/, 'the exit code is a field, not output')
  assert.match(result.outputTail, /error TS2304/)
})

test('transcript: a command still awaiting its result row keeps exitCode null', () => {
  // Mid-flight: the tool call has landed, the result row has not.
  const steps = [
    ...transcriptPair('npm test', 0, 'ok'),
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '下一轮跑构建',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run build' } }],
    },
  ]

  const commands = extractRunCommands(steps)
  assert.equal(commands.length, 2)
  assert.equal(commands[1].command, 'npm run build')
  assert.equal(commands[1].exitCode, null, 'a running command is unknown, not successful')
  assert.equal(commands[1].failed, false)
})

test('transcript: a planner step after the result does not leak its prose into outputTail', () => {
  const steps = [
    ...transcriptPair('npm test', 1, 'real failure output'),
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '所有测试通过！',
      tool_calls: [],
    },
  ]

  const [result] = extractRunCommands(steps)
  assert.equal(result.outputTail, 'real failure output')
  assert.doesNotMatch(result.outputTail, /所有测试通过/)
})

test('transcript: cwd is derived from a Set-Location / cd prefix when no carrier names one', () => {
  const [powershell] = extractRunCommands(
    transcriptPair("Set-Location -LiteralPath 'F:\\work\\app'; npm test", 0, 'ok'),
  )
  const [posix] = extractRunCommands(transcriptPair('cd /f/work/app && npm test', 0, 'ok'))
  const [none] = extractRunCommands(transcriptPair('npm test', 0, 'ok'))

  assert.equal(powershell.cwd, 'F:\\work\\app')
  assert.equal(posix.cwd, '/f/work/app')
  assert.equal(none.cwd, null)
})

test('transcript: end-to-end failing turn raises the verification warning', () => {
  const steps = [
    ...transcriptPair("Set-Location -LiteralPath 'F:\\work\\app'; node --check .\\js\\main.js", 0, ''),
    ...transcriptPair("Set-Location -LiteralPath 'F:\\work\\app'; npm test", 1, 'Tests: 1 failed'),
  ]

  const commands = extractRunCommands(steps)
  assert.equal(commands.length, 2)
  assert.equal(commands[0].exitCode, 0)
  assert.equal(commands[1].exitCode, 1)

  const summary = summarizeCommands(commands)
  assert.equal(summary.verificationFailed, true)
  assert.ok(verificationWarning(commands).includes('exited with code 1'))
})

// ---------------------------------------------------------------------------
// End-to-end: raw RPC steps → extraction → render
// ---------------------------------------------------------------------------

test('end-to-end: a failing turn produces the warning and a debuggable tail', () => {
  const steps = [
    plannerStep(0),
    runStep({ stepIndex: 1, commandLine: 'git status', exitCode: 0, output: 'clean' }),
    runStep({
      stepIndex: 2,
      argumentsJson: JSON.stringify({ CommandLine: 'npx vitest run', cwd: 'F:\\work\\app' }),
      exitCode: 1,
      output: [
        ' ❯ tests/api.test.js (3 tests | 1 failed)',
        '   × creates a user 12ms',
        '     → expected 200 to equal 500',
        '     AssertionError [ERR_ASSERTION]: expected 200 to equal 500',
        '',
      ].join('\n'),
    }),
    plannerStep(3),
  ]

  const commands = extractRunCommands(steps)
  assert.equal(commands.length, 2)
  assert.equal(commands[0].command, 'git status')
  assert.equal(commands[0].exitCode, 0)
  assert.equal(commands[1].command, 'npx vitest run')
  assert.equal(commands[1].cwd, 'F:\\work\\app')
  assert.equal(commands[1].exitCode, 1)
  assert.equal(commands[1].failed, true)

  const summary = summarizeCommands(commands)
  assert.equal(summary.total, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.verificationFailed, true)
  assert.equal(summary.lastVerification.command, 'npx vitest run')

  const warning = verificationWarning(commands)
  assert.ok(warning.startsWith('[⚠️ Verification Warning:'))

  const rendered = renderCommandSummary(commands)
  assert.ok(rendered.startsWith('[Command Execution Summary]'))
  assert.match(rendered, /  ✅ Exit 0: git status/)
  assert.match(rendered, /  ❌ Exit 1: npx vitest run/)
  assert.match(rendered, /AssertionError \[ERR_ASSERTION\]: expected 200 to equal 500/)
})
