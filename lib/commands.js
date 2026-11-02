/**
 * Structured extraction of `run_command` results (CONTRACT.md §7.3).
 *
 * Why this module exists (REQ-02): the settlement report used to list command
 * *names* only, so a turn whose tests failed could still be reported as
 * finished. Here we recover the real exit code plus the tail of the output, so
 * the report can say "❌ Exit 1" and the caller can refuse a fake success.
 *
 * The single most important rule: **a missing exit code is `null`, never 0.**
 * `0` is the strong assertion "this command succeeded"; inventing it turns a
 * failed turn into a green one, which is the exact failure REQ-02 prevents.
 * Every reader below therefore ends at `null` and never at a default.
 *
 * Zero dependencies: this module imports nothing at all.
 */

/** Keep the last 20 lines and never more than 1500 chars of output. */
const MAX_OUTPUT_LINES = 20
const MAX_OUTPUT_CHARS = 1500

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Read `a.b.c` without caring whether any hop exists. */
function path(object, dotted) {
  let current = object
  for (const key of dotted.split('.')) {
    if (!isObject(current)) return undefined
    current = current[key]
  }
  return current
}

/**
 * First present value, in priority order.
 *
 * `null` counts as *absent* on purpose: a serialized `null` means "the server
 * did not tell us", which is the same thing as missing and must fall through to
 * the next carrier instead of short-circuiting the chain.
 */
function firstDefined(object, candidates) {
  for (const candidate of candidates) {
    const value = path(object, candidate)
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** Coerce a carrier value into a finite number, or `undefined`. */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

/**
 * Tool arguments arrive as a *string* in `metadata.toolCall.argumentsJson`
 * (CONTRACT.md §1), so they need a second `JSON.parse`. Objects are accepted
 * as-is because transcript rows are already normalized.
 */
function parseArgumentsJson(value) {
  if (isObject(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = JSON.parse(value)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Order-insensitive key lookup, so `cwd` / `Cwd` / `CWD` all answer. */
function pickKey(object, keys) {
  if (!isObject(object)) return undefined
  const byLower = new Map(Object.keys(object).map((key) => [key.toLowerCase(), key]))
  for (const key of keys) {
    const actual = byLower.get(key.toLowerCase())
    if (actual === undefined) continue
    const value = object[actual]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

// ---------------------------------------------------------------------------
// exitCode / command / cwd / output
// ---------------------------------------------------------------------------

/**
 * Regex fallback: some carriers only report the code inside the output.
 *
 * `exit(?:ed)?\s*(?:with\s*)?code` covers all three spellings seen in practice:
 * `exit code 1`, `exit code: 1`, and the Antigravity result-row envelope
 * `Command exited with code 1.` (the dominant form on disk — see the module
 * header note about transcript pairing).
 */
const EXIT_CODE_RE = /exit(?:ed)?\s*(?:with\s*)?code[:\s]+(-?\d+)/i

/**
 * The transcript result row written right after a `run_command` step:
 *
 *   Created At: 2026-10-29T15:21:46+08:00
 *   Completed At: 2026-10-29T15:21:47+08:00
 *   Command exited with code 1.
 *
 *   Command output:
 *   <real output...>
 */
const RESULT_ENVELOPE_RE = /Command exited with code\s*(-?\d+)/i
const OUTPUT_LABEL_RE = /\n\s*Command output:\s*\n/i

/**
 * Exit code from the most authoritative carrier available.
 *
 * Priority (CONTRACT.md §7.3): `runCommand.exitCode` →
 * `metadata.commandResult.exitCode` → `taskDetails.exitCode` → an
 * `exit code N` line in the output. Anything else is `null`.
 */
function readExitCode(raw, output) {
  const direct = toFiniteNumber(
    firstDefined(raw, [
      'runCommand.exitCode',
      'runCommand.exit_code',
      'metadata.commandResult.exitCode',
      'metadata.commandResult.exit_code',
      'commandResult.exitCode',
      'commandResult.exit_code',
      'taskDetails.exitCode',
      'taskDetails.exit_code',
      'metadata.taskDetails.exitCode',
      'metadata.taskDetails.exit_code',
      'exitCode',
      'exit_code',
    ]),
  )
  if (direct !== undefined) return direct

  const match = EXIT_CODE_RE.exec(output)
  if (match !== null) {
    const fromOutput = Number(match[1])
    if (Number.isFinite(fromOutput)) return fromOutput
  }
  return null
}

/** Command line: `argumentsJson` first (the lossless carrier), then the rest. */
function readCommand(raw, step) {
  const fromArgumentsJson = pickKey(
    parseArgumentsJson(raw?.metadata?.toolCall?.argumentsJson ?? raw?.metadata?.toolCall?.arguments),
    ['CommandLine', 'commandLine', 'command'],
  )
  if (nonEmptyString(fromArgumentsJson)) return fromArgumentsJson

  const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : []
  for (const call of calls) {
    const name = String(call?.name ?? '')
    if (name !== 'run_command' && name !== 'run_terminal_command') continue
    const value = pickKey(call?.args, ['CommandLine', 'commandLine', 'command'])
    if (nonEmptyString(value)) return value
  }

  const fromRunCommand = firstDefined(raw, [
    'runCommand.commandLine',
    'runCommand.command',
    'runCommand.CommandLine',
  ])
  if (nonEmptyString(fromRunCommand)) return fromRunCommand
  return ''
}

/** Split a `cd`/`Set-Location` prefix off a command line, if it has one. */
function cwdFromCommandLine(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return null
  const match =
    /^\s*(?:cd|chdir|pushd|Set-Location)\s+(?:-LiteralPath\s+|-Path\s+|-lp\s+)?["']?([^"';&|]+?)["']?\s*(?:;|&&|\r|\n|$)/i.exec(
      text,
    )
  if (match === null) return null
  const directory = match[1].trim()
  return directory === '' ? null : directory
}

/** Working directory, or `null` when the trajectory does not record one. */
function readCwd(raw, step) {
  const fromRaw = firstDefined(raw, [
    'runCommand.cwd',
    'runCommand.workingDirectory',
    'runCommand.workingDir',
    'taskDetails.cwd',
    'metadata.cwd',
  ])
  if (nonEmptyString(fromRaw)) return fromRaw

  const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : []
  for (const call of calls) {
    const value = pickKey(call?.args, ['cwd', 'workingDirectory', 'workingDir'])
    if (nonEmptyString(value)) return value
  }

  const fromArgumentsJson = pickKey(
    parseArgumentsJson(raw?.metadata?.toolCall?.argumentsJson ?? raw?.metadata?.toolCall?.arguments),
    ['cwd', 'workingDirectory', 'workingDir'],
  )
  if (nonEmptyString(fromArgumentsJson)) return fromArgumentsJson

  // No carrier names a cwd, but the command switches directory itself. Every
  // delegated prompt on this machine starts with
  // `Set-Location -LiteralPath '<ws>'; ...` (PowerShell) or `cd <ws> && ...`,
  // because run_command's default cwd is not the project. Surfacing that is far
  // more useful in a report than a bare "-", and it is what the executor
  // actually ran in.
  return cwdFromCommandLine(readCommand(raw, step))
}

/** True when `text` is the result row's own header, not real command output. */
function isResultEnvelope(text) {
  return /^\s*Created At:/.test(text) || /^\s*Completed At:/.test(text) || RESULT_ENVELOPE_RE.test(text)
}

/**
 * Strip the transcript result-row envelope, returning the real command output.
 *
 * The envelope is noise in a report — it repeats the exit code and two
 * timestamps we already have — while the payload below `Command output:` is the
 * stack trace the reader needs. When there is no label, the header lines are
 * dropped line by line and whatever remains is the output.
 */
function stripResultEnvelope(text) {
  if (typeof text !== 'string' || text === '') return ''
  const label = OUTPUT_LABEL_RE.exec(text)
  if (label !== null) return text.slice(label.index + label[0].length)
  if (!isResultEnvelope(text)) return text
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => !/^\s*(?:Created At|Completed At)\s*:/.test(line) && !RESULT_ENVELOPE_RE.test(line))
    .join('\n')
}

/**
 * Full output, widest carrier first: `combinedOutput.full` (RPC is lossless,
 * CONTRACT.md §1) → `combinedOutput` (string or object) → `content`.
 */
function readOutput(raw, step) {
  const full = path(raw, 'runCommand.combinedOutput.full')
  if (typeof full === 'string') return stripResultEnvelope(full)

  const combined = path(raw, 'runCommand.combinedOutput')
  if (typeof combined === 'string') return stripResultEnvelope(combined)
  if (isObject(combined)) {
    for (const key of ['full', 'text', 'content', 'output', 'stdout', 'stderr']) {
      if (typeof combined[key] === 'string') return stripResultEnvelope(combined[key])
    }
  }

  const direct = firstDefined(raw, [
    'runCommand.output',
    'runCommand.stdout',
    'commandResult.output',
    'taskDetails.output',
  ])
  if (typeof direct === 'string') return stripResultEnvelope(direct)

  if (typeof step?.content === 'string') return stripResultEnvelope(step.content)
  if (typeof step === 'string') return stripResultEnvelope(step)
  return ''
}

function splitLines(output) {
  if (typeof output !== 'string' || output === '') return []
  return output.split(/\r\n|\r|\n/)
}

/**
 * Last `maxLines` lines of `output`, dropping only the trailing empty line a
 * final newline produces.
 */
function tailLines(output, maxLines = MAX_OUTPUT_LINES) {
  let lines = splitLines(output)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1)
  if (lines.length <= maxLines) return lines
  return lines.slice(lines.length - maxLines)
}

/**
 * Line-sliced output capped at `MAX_OUTPUT_CHARS`, truncated **from the head**
 * so the final lines (stack trace, assertion) survive. Never splits a surrogate
 * pair, and prefers to resume on a line boundary so the tail does not start
 * mid-word.
 */
function clampOutput(output, { maxLines = MAX_OUTPUT_LINES, maxChars = MAX_OUTPUT_CHARS } = {}) {
  const text = tailLines(output, maxLines).join('\n')
  if (text.length <= maxChars) return text

  const keep = Math.max(0, maxChars - 3) // room for the "..." marker
  let cut = text.length - keep
  const low = text.charCodeAt(cut)
  if (low >= 0xdc00 && low <= 0xdfff) cut += 1 // do not orphan a low surrogate
  let sliced = text.slice(cut)
  const newline = sliced.indexOf('\n')
  if (newline !== -1 && newline < sliced.length - 1) sliced = sliced.slice(newline + 1)
  return `...${sliced}`
}

// ---------------------------------------------------------------------------
// extractRunCommands
// ---------------------------------------------------------------------------

const RUN_COMMAND_NAMES = new Set(['run_command', 'run_terminal_command'])

/**
 * Does this step carry a `run_command` execution?
 *
 * Judged by `metadata.toolCall.name` rather than the step `type`: a tool step
 * is routinely reported as `CORTEX_STEP_TYPE_GENERIC` while it generates and
 * only becomes `RUN_COMMAND` once it lands (CONTRACT.md §1). Both are accepted.
 */
function isRunCommandStep(raw, step) {
  const toolName = firstDefined(raw, ['metadata.toolCall.name', 'toolCall.name'])
  if (typeof toolName === 'string') {
    const name = toolName.replace(/^CORTEX_TOOL_NAME_/i, '')
    if (RUN_COMMAND_NAMES.has(name)) return true
  }

  const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : []
  if (calls.some((call) => RUN_COMMAND_NAMES.has(String(call?.name ?? '')))) return true

  const type = String(step?.type ?? firstDefined(raw, ['type', 'metadata.type']) ?? '')
    .replace(/^CORTEX_STEP_TYPE_/i, '')
    .toUpperCase()
  if (type === 'RUN_COMMAND') return true

  return isObject(raw?.runCommand) || isObject(raw?.metadata?.commandResult)
}

function stepIndexOf(raw, step, fallback) {
  for (const candidate of [
    step?.step_index,
    step?.stepIndex,
    raw?.step_index,
    raw?.stepIndex,
    path(raw, 'metadata.stepIndex'),
    path(raw, 'metadata.step_index'),
  ]) {
    const number = toFiniteNumber(candidate)
    if (number !== undefined) return number
  }
  return fallback
}

/**
 * Every `run_command` with its exit code, command line and output tail.
 *
 * Two input shapes are expected and both are handled:
 *
 * 1. **RPC steps** — `runCommand.{commandLine,exitCode,combinedOutput.full}`
 *    lives on the same step as the tool call (CONTRACT.md §1 / §4).
 * 2. **Transcript rows** — the tool call sits on a `PLANNER_RESPONSE` row and
 *    its *result* is the immediately following `GENERIC` / `RUN_COMMAND` row
 *    (`Command exited with code N.` + `Command output:`). Verified on disk:
 *    304/304 run_command rows were followed by such a row, so the result row is
 *    paired with the command that precedes it.
 *
 * A result row is never emitted as its own command, and a command that has no
 * result row yet (still running) keeps `exitCode: null`.
 *
 * @param {Array<object>} steps - normalized steps (CONTRACT.md §4), ideally
 *   carrying `raw`; bare RPC steps and raw transcript rows are accepted too.
 * @returns {Array<{stepIndex: number, command: string, cwd: string|null,
 *   exitCode: number|null, outputTail: string, failed: boolean}>}
 */
export function extractRunCommands(steps) {
  const list = Array.isArray(steps) ? steps : []
  const out = []
  let pending = null // the command still waiting for its result row

  const flush = () => {
    if (pending !== null) out.push(pending.command)
    pending = null
  }

  list.forEach((entry, index) => {
    const step = isObject(entry) ? entry : {}
    const raw = isObject(step.raw) ? step.raw : step

    if (isRunCommandStep(raw, step)) {
      flush()
      // Only an RPC step carries its own result. A transcript tool-call row
      // (the call lives on a PLANNER_RESPONSE row) owes us the *next* row, and
      // its own `content` is planner prose — never command output.
      const inline = hasInlineResult(raw)
      const output = inline ? readOutput(raw, step) : ''
      const exitCode = readExitCode(raw, output)
      const command = {
        stepIndex: stepIndexOf(raw, step, index),
        command: readCommand(raw, step),
        cwd: readCwd(raw, step),
        exitCode,
        outputTail: clampOutput(output),
        failed: Number.isFinite(exitCode) && exitCode !== 0,
      }
      if (inline) out.push(command)
      else pending = { command }
      return
    }

    if (pending !== null) {
      const content = resultRowContent(raw, step)
      if (content !== '') {
        const paired = pending.command
        paired.exitCode = readExitCode(raw, content)
        paired.outputTail = clampOutput(stripResultEnvelope(content))
        paired.failed = Number.isFinite(paired.exitCode) && paired.exitCode !== 0
      }
    }
    flush()
  })

  flush()
  return out
}

/** Does this step carry its own result rather than waiting for the next row? */
function hasInlineResult(raw) {
  return isObject(raw?.runCommand) || isObject(raw?.metadata?.commandResult)
}

/**
 * Text payload of a *result* row. Such a row is typeless (`GENERIC`) and only
 * holds `content`, so that is the only carrier consulted.
 */
function resultRowContent(raw, step) {
  for (const candidate of [step?.content, raw?.content]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return ''
}

// ---------------------------------------------------------------------------
// isVerificationCommand
// ---------------------------------------------------------------------------

/**
 * Programs that are asked "how did it end?" — test runners, build tools,
 * linters and type checkers.
 *
 * Matching is token-anchored at the start of each pipeline segment. A loose
 * substring match would classify `curl https://api.test/build/status` or
 * `cat build.log` as a verification run, and a zero exit code would then
 * green-light a turn whose tests never ran.
 */
const VERIFICATION_PROGRAMS = new Set([
  // JS/TS
  'vitest', 'jest', 'mocha', 'jasmine', 'ava', 'tap', 'karma',
  'tsc', 'ts-node', 'tsx',
  'eslint', 'biome', 'prettier', 'stylelint', 'oxlint',
  'webpack', 'rollup', 'esbuild', 'turbo', 'nx', 'lerna',
  // Python
  'pytest', 'py.test', 'tox', 'nox', 'mypy', 'pyright', 'ruff', 'flake8', 'pylint', 'black',
  // Go / Rust
  'go', 'cargo', 'clippy',
  // JVM / .NET
  'mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet', 'msbuild',
  // Other build/test drivers
  'make', 'cmake', 'ninja', 'ctest', 'bazel', 'meson', 'sbt', 'swift', 'xcodebuild',
])

/** Package managers: only their quality *scripts* count, not `install`/`add`. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

const QUALITY_SCRIPTS = new Set([
  'test', 'build', 'lint', 'typecheck', 'type-check', 'types', 'check', 'verify', 'ci', 'tsc',
])

/**
 * PowerShell cmdlet → the program it wraps. The delegated executor runs on
 * Windows PowerShell (CONTRACT.md §1 prompt contract), so the common way to run
 * a tool is `& npm test` or `Start-Process -FilePath npm ...`; both must be seen
 * through. `Invoke-Expression "npm test"` is the RPC-facing spelling.
 */
const POWERSHELL_WRAPPERS = new Map([
  ['call', 1], // `&` operator: `& npm test`
  ['start-process', 0], // -FilePath carries the program
  ['invoke-expression', 0],
  ['iex', 0],
  ['invoke-command', 0],
])

/** Leading wrappers that do not change what is actually being run. */
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'npx', 'pnpx', 'bunx', 'exec', 'time', 'command', 'nice', 'nohup',
])

/** Wrapper flags that consume the following token as their value (`sudo -u root`). */
const VALUE_FLAGS = new Set(['-u', '-g', '-p', '-c', '-h', '-r', '-t', '--user', '--group'])

/**
 * A command line that only switches directory (`Set-Location -LiteralPath 'x'`)
 * is never a verification command — it is navigation.
 */
const NAVIGATION_PROGRAMS = new Set([
  'set-location', 'sl', 'cd', 'chdir', 'pushd', 'popd', 'pwd', 'get-location', 'echo', 'write-host',
])

/** Split a command line into pipeline segments, each analysed on its own. */
function commandSegments(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return []
  return text.split(/\s+&&\s*|\s*\|\|\s*|\s*\|\s*|\s*;\s*|\n/).filter((part) => part.trim() !== '')
}

/** Tokenize one segment, dropping shell noise the way a shell would. */
function segmentTokens(segment) {
  return String(segment)
    .replace(/\[[^\]]*\]/g, ' ') // drop "npx vitest [args]" placeholders
    .replace(/\s*&\s*$/, '') // PowerShell call operator
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '' && token !== '&')
}

/** Strip wrappers and `FOO=bar` prefixes so tokens[0] is the real program. */
function stripWrapper(tokens) {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index].replace(/^["']|["']$/g, '')

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1 // leading environment assignment
      continue
    }

    const base = token
      .replace(/^.*[\\/]/, '')
      .replace(/\.(cmd|exe|bat|sh|ps1)$/i, '')
      .toLowerCase()
    if (!WRAPPERS.has(base)) break

    index += 1
    let expectsValue = false
    while (index < tokens.length && tokens[index].startsWith('-')) {
      expectsValue = VALUE_FLAGS.has(tokens[index].toLowerCase())
      index += 1
    }
    if (expectsValue && index < tokens.length) index += 1 // the flag's value
  }
  return tokens.slice(index)
}

/** Is one pipeline segment a verification command? */
function isVerificationSegment(segment) {
  if (segment === undefined) return false
  const tokens = stripWrapper(segmentTokens(segment))
  if (tokens.length === 0) return false

  const program = tokens[0].replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').toLowerCase()
  const base = program.replace(/\.(cmd|exe|bat|sh|ps1|js|mjs|cjs)$/i, '')
  const rest = tokens.slice(1)

  // A segment that only navigates is never an acceptance gate.
  if (NAVIGATION_PROGRAMS.has(base)) return false

  // PowerShell wrapper cmdlets: look through to the program they carry.
  // Flags are dropped but their values are kept, so
  // `Start-Process -FilePath npm -ArgumentList test` reads as `npm test`.
  if (POWERSHELL_WRAPPERS.has(base)) {
    const positional = rest.filter((token) => !token.startsWith('-'))
    if (positional.length === 0) return false
    const inner = positional.join(' ')
    return inner === base ? false : isVerificationSegment(inner)
  }

  // Package managers: `npm test`, `npm run build`, `pnpm -s run lint`, ...
  if (PACKAGE_MANAGERS.has(base)) {
    let index = 0
    while (index < rest.length && rest[index].startsWith('-')) index += 1
    let script = rest[index]
    if (script === undefined) return false
    if (script.toLowerCase() === 'run') {
      index += 1
      while (index < rest.length && rest[index].startsWith('-')) index += 1
      script = rest[index]
      if (script === undefined) return false
    }
    const name = script.replace(/^["']|["']$/g, '').toLowerCase()
    // `npm run test:unit` / `npm run test:e2e` count as their base script.
    return QUALITY_SCRIPTS.has(name) || QUALITY_SCRIPTS.has(name.replace(/:.+$/, ''))
  }

  // `node --test` (the built-in runner used by this package) and `node --check`
  // (a syntax gate, which is exactly what the measured transcript used to verify
  // its work) are acceptance commands; a bare `node script.js` is not.
  if (base === 'node') {
    return rest.some((token) => token === '--test' || token === '--run' || token === '--check')
  }

  // `python -m pytest`, `python -m unittest`: the module form of a runner.
  if (base === 'python' || base === 'python3' || base === 'py') {
    const dashM = rest.indexOf('-m')
    if (dashM === -1) return false
    const module = String(rest[dashM + 1] ?? '').toLowerCase()
    return module.startsWith('pytest') || module.startsWith('unittest') || module === 'tox'
  }

  if (!VERIFICATION_PROGRAMS.has(base)) return false

  // A few multi-purpose drivers only count for their build/test subcommands:
  // `go get` / `cargo fmt` / `dotnet tool` are not acceptance gates.
  if (base === 'go') return rest.some((token) => /^(build|test|vet)$/i.test(token))
  if (base === 'cargo') {
    return (
      rest.length === 0 ||
      rest.some((token) => /^(build|test|check|clippy|bench|nextest|doc)$/i.test(token))
    )
  }
  if (base === 'dotnet') {
    return rest.some((token) => /^(build|test|publish|pack|format)$/i.test(token))
  }
  return true
}

/**
 * Is this an acceptance command — one whose exit code says pass or fail?
 *
 * `git status` is deliberately excluded: it is a snapshot, not an acceptance
 * gate. Neither are `ls` / `cat` / `cd` / `echo`.
 *
 * @param {string} command - one `run_command` command line.
 * @returns {boolean}
 */
export function isVerificationCommand(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return false
  return commandSegments(text).some((segment) => isVerificationSegment(segment))
}

// ---------------------------------------------------------------------------
// summarizeCommands / renderCommandSummary / verificationWarning
// ---------------------------------------------------------------------------

/**
 * @param {Array<object>} commands - output of `extractRunCommands`.
 * @returns {{total: number, failed: number, lastVerification: object|null,
 *   verificationFailed: boolean}} `lastVerification` is the whole command
 *   object, so the caller can read its `command` / `exitCode` / `outputTail`.
 */
export function summarizeCommands(commands) {
  const list = Array.isArray(commands) ? commands.filter(isObject) : []

  let failed = 0
  let lastVerification = null
  for (const command of list) {
    if (command.failed === true) failed += 1
    if (isVerificationCommand(command.command)) lastVerification = command
  }

  return {
    total: list.length,
    failed,
    lastVerification,
    // A known non-zero code is the only safe failure signal: `null` means
    // "unknown", and reporting unknown as failed would be the mirror image of
    // the very bug REQ-02 fixes.
    verificationFailed:
      lastVerification !== null &&
      Number.isFinite(lastVerification.exitCode) &&
      lastVerification.exitCode !== 0,
  }
}

/** `Exit 0` / `Exit 1`, or an explicit "unknown" — never a guessed 0. */
function describeExit(exitCode) {
  return Number.isFinite(exitCode) ? `Exit ${exitCode}` : 'Exit unknown'
}

/**
 * `[Command Execution Summary]` block, or `undefined` when nothing ran.
 *
 * Format is byte-for-byte CONTRACT.md §7.3 — the exit line per command, and for
 * a failed command its `cwd` / `tail` on the following lines:
 *
 *   [Command Execution Summary]
 *     ✅ Exit 0: npm run build
 *     ❌ Exit 1: npx vitest run
 *        cwd  : F:\work\app
 *        tail :
 *          AssertionError [ERR_ASSERTION]: expected 200 to equal 500
 *
 * @param {Array<object>} commands
 * @param {{maxCommands?: number}} [options] - cap on rendered commands; the
 *   newest are kept because the last command is what decides acceptance.
 * @returns {string|undefined}
 */
export function renderCommandSummary(commands, { maxCommands = 12 } = {}) {
  const list = Array.isArray(commands) ? commands.filter(isObject) : []
  if (list.length === 0) return undefined

  const cap = Number.isFinite(maxCommands) && maxCommands > 0 ? Math.floor(maxCommands) : 12
  const shown = list.slice(-cap)
  const omitted = list.length - shown.length

  const lines = ['[Command Execution Summary]']
  if (omitted > 0) lines.push(`  ... ${omitted} earlier command(s) omitted`)

  for (const command of shown) {
    const exitCode = command.exitCode
    const mark = Number.isFinite(exitCode) ? (exitCode === 0 ? '✅' : '❌') : '❔'
    lines.push(`  ${mark} ${describeExit(exitCode)}: ${String(command.command ?? '')}`)
    if (command.failed !== true) continue

    lines.push(`     cwd  : ${command.cwd === null || command.cwd === undefined ? '-' : String(command.cwd)}`)
    lines.push('     tail :')
    const tail = splitLines(command.outputTail ?? '').filter((line) => line !== '')
    if (tail.length === 0) lines.push('       (no output)')
    else for (const line of tail) lines.push(`       ${line}`)
  }

  return lines.join('\n')
}

/**
 * Fake-success interceptor: when the *last* verification command exited
 * non-zero, the turn is not verified no matter what the executor claims.
 *
 * @param {Array<object>} commands
 * @returns {string|undefined} the warning line, or `undefined` when clean.
 */
export function verificationWarning(commands) {
  const { lastVerification } = summarizeCommands(commands)
  if (lastVerification === null) return undefined
  const code = lastVerification.exitCode
  if (!Number.isFinite(code) || code === 0) return undefined
  return (
    '[⚠️ Verification Warning: The last executed command exited with code ' +
    `${code}. Inspect the error output below before accepting.]`
  )
}
