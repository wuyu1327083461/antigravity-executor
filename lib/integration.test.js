/**
 * Integration smoke test for the plugin entry point (v0.5.0 wiring).
 *
 * WHY A SMOKE TEST AND NOT UNIT TESTS
 * -----------------------------------
 * `lib/index.js` is the only module that cannot be unit-tested directly: it
 * imports `@deepseek-ai/dsh-tools` and registers tools on a live Cordis context.
 * Everything interesting in it is *wiring* — which finding granularity arms the
 * kill switch, whether the quota cache is consulted, whether a dead session is
 * evicted. Those are exactly the properties a refactor silently breaks, so this
 * file mounts the plugin against a minimal fake context and asserts the wiring
 * end to end, with the RPC layer faked at the module boundary.
 *
 * Run: node --test lib/integration.test.js
 *
 * SELF-CONTAINED DEPENDENCY STUB
 * ------------------------------
 * `@deepseek-ai/dsh-tools` is provided by the host, not by this package. A
 * tiny on-disk stub is installed under a temp directory and linked into a
 * resolution path so this file runs anywhere, including CI without dsh.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

// ---------------------------------------------------------------------------
// dependency stub + fixture install
// ---------------------------------------------------------------------------

/**
 * Materialise a throwaway package tree that contains a `dsh-tools` stub, copy
 * the plugin's lib into it, and import the copy.
 *
 * Copying (instead of importing in place) keeps the real checkout free of a
 * `node_modules` directory that could confuse later runs.
 */
async function mountPlugin(t) {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMPDIR ?? homedir(), 'agy-int-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const toolsDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
  await mkdir(toolsDir, { recursive: true })
  await writeFile(
    join(toolsDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js' }),
  )
  await writeFile(join(toolsDir, 'index.js'), 'export function defineTool(spec) { return spec }\n')

  // Copy the package as the profile would install it.
  const pkgDir = join(root, 'node_modules', 'antigravity-executor')
  await mkdir(pkgDir, { recursive: true })
  await mkdir(join(pkgDir, 'lib'), { recursive: true })
  await mkdir(join(pkgDir, 'skills', 'supervisor-workflow'), { recursive: true })
  await copyDir(join(process.cwd(), 'lib'), join(pkgDir, 'lib'))
  await copyText(
    join(process.cwd(), 'skills', 'supervisor-workflow', 'SKILL.md'),
    join(pkgDir, 'skills', 'supervisor-workflow', 'SKILL.md'),
  )
  await copyText(join(process.cwd(), 'package.json'), join(pkgDir, 'package.json'))

  return { root, pkgDir, entry: join(pkgDir, 'lib', 'index.js') }
}

async function copyText(from, to) {
  const text = await readFile(from, 'utf8')
  await mkdir(dirname(to), { recursive: true })
  await writeFile(to, text)
}

/** Copy only the non-test `.js` files plus any fixtures they need. */
async function copyDir(from, to) {
  const { readdir } = await import('node:fs/promises')
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    // Skip the test files: their own imports would resolve against the stub
    // tree and add noise for no benefit.
    if (entry.name.includes('.test.')) continue
    await copyText(join(from, entry.name), join(to, entry.name))
  }
}

// ---------------------------------------------------------------------------
// fake cordis context
// ---------------------------------------------------------------------------

/** Collect what the plugin registers and let a test drive one tool. */
function makeContext({ sessions = new Map(), loggerLines = [] } = {}) {
  const tools = new Map()
  const skills = []

  const ctx = {
    logger: () => ({
      info: (line) => loggerLines.push(line),
    }),
    skills: {
      registerProvider(provider) {
        skills.push(provider)
      },
    },
    sessions: {
      get(sessionId) {
        return sessions.get(sessionId)
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
      },
    },
  }

  return { ctx, tools, skills, loggerLines }
}

/** A dsh session whose header carries a workspace. */
function fakeSession(id, cwd) {
  return { header: { id, cwd } }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

test('the plugin registers its three tools and its bundled skill', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)
  const { ctx, tools, skills } = makeContext()

  plugin.apply(ctx, {})

  assert.deepEqual([...tools.keys()].sort(), [
    'check_environment',
    'delegate_coding_task',
    'list_conversations',
  ])
  // The supervisor skill ships with the package: losing it would silently drop
  // the workflow rules the executor depends on.
  assert.equal(skills.length, 1)
  const skill = await skills[0]().get()
  assert.match(skill.content, /主从协同开发铁律/)
})

test('the bundled skill forbids dev servers and watch-mode tests', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)
  const { ctx, skills } = makeContext()

  plugin.apply(ctx, {})
  const skill = await skills[0]().get()
  // The 0.4.0 failure mode: an executor starts `npm run dev`, the cascade never
  // goes IDLE, and the turn burns the whole maxSeconds budget.
  assert.match(skill.content, /npm run dev/)
  assert.match(skill.content, /vitest run|--run/)
  assert.match(skill.content, /常驻|dev server/i)
})

test('the bundled skill teaches the adaptive task mode', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)
  const { ctx, skills } = makeContext()

  plugin.apply(ctx, {})
  const skill = await skills[0]().get()
  // v0.6.0 / REQ-01: the whole point is that a user never edits a file to switch
  // between "fix a bug" and "build a 3D scene", so the skill itself has to say so.
  assert.match(skill.content, /task_mode/)
  assert.match(skill.content, /surgical/)
  assert.match(skill.content, /creative/)
  // The multi-pass discipline and the gate it reacts to.
  assert.match(skill.content, /Pass 2/)
  assert.match(skill.content, /Supervisor Creative Gate/)
  // The v0.6.0 result shape the skill tells the planner to read instead of
  // spending a tool round on git.
  assert.match(skill.content, /git diff --stat|Git 快照/)
})

test('check_environment reports the v0.6.0 policy lines', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)
  const { ctx, tools } = makeContext()

  plugin.apply(ctx, {})
  // No live Language Server in a test process: the body reports BLOCKED, which
  // is still enough to assert the config-driven lines above it.
  const text = await tools.get('check_environment').execute({}, {})

  assert.match(text, /kill-switch armed \(destructive commands always cut\)/)
  assert.match(text, /weekly reserve 15%/)
  assert.match(text, /cache 180s/)
  assert.match(text, /inline <= 4000 chars/)
  assert.match(text, /suggest a new session_id after 8 turns/)
  assert.match(text, /pacing\s+: min gap 15s \+ jitter 6-15s/)
  assert.match(text, /warn at 45s/)
  // v0.6.0 additions.
  assert.match(text, /task mode\s+: auto-detected per call/)
  assert.match(text, /cut at 60s when no new step appears/)
  assert.match(text, /git snapshot : git status\/diff --stat inlined at settlement/)
  assert.match(text, /queue\s+: idle/)
  // REQ-06: the < 24h fallback to the 5% floor must be visible in the diagnosis.
  assert.match(text, /falls back to the 5% floor in the last 24h/)
})

test('check_environment reflects a config that turns the new guards off', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)
  const { ctx, tools } = makeContext()

  plugin.apply(ctx, {
    realtimeKillSwitch: false,
    quotaFallback: { weeklyGuard: false, cacheTtlSeconds: 0 },
    pacing: { enabled: false },
    hangingCommandTimeoutSeconds: 0,
    includeGitSummary: false,
    taskMode: 'surgical',
  })
  const text = await tools.get('check_environment').execute({}, {})

  assert.match(text, /kill-switch off/)
  assert.match(text, /weekly guard off/)
  assert.match(text, /cache 0s/)
  assert.match(text, /pacing\s+: off/)
  // v0.6.0: a disabled circuit breaker must say so rather than still claiming a
  // 60s cut, and a pinned mode must not claim to be auto-detected.
  assert.match(text, /no active cut/)
  assert.match(text, /git snapshot : off/)
  assert.match(text, /task mode\s+: pinned to surgical by config/)
})

// ---------------------------------------------------------------------------
// v0.6.0 wiring: the adaptive task mode
// ---------------------------------------------------------------------------

/**
 * The REQ-01 acceptance case, asserted on the tool schema and the module the
 * wiring depends on rather than on a live delegation: no Language Server exists
 * in a test process, and the decision happens before any RPC.
 */
test('delegate_coding_task exposes task_mode and defaults to auto-detection', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)
  const { ctx, tools } = makeContext()

  plugin.apply(ctx, {})
  const tool = tools.get('delegate_coding_task')

  // The parameter exists, is optional, and is a two-value enum.
  const spec = tool.parameters.task_mode
  assert.equal(spec.type, 'string')
  assert.deepEqual(spec.enum, ['surgical', 'creative'])
  assert.notEqual(spec.required, true)
  // Its description must tell the planner to omit it — a planner that starts
  // pinning the mode per call would re-introduce the manual switching this REQ
  // removes.
  assert.match(spec.description, /OMIT/)
  assert.match(spec.description, /auto-detected/)

  // The config key that backs it defaults to `auto`.
  const config = plugin.Config['~standard'].validate({})
  assert.equal(config.value.taskMode, 'auto')
  assert.equal(config.value.hangingCommandTimeoutSeconds, 60)
  assert.equal(config.value.includeGitSummary, true)
})

test('the config schema accepts the v0.6.0 keys and rejects a bad enum', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)

  const ok = plugin.Config['~standard'].validate({
    taskMode: 'creative',
    hangingCommandTimeoutSeconds: 0,
    includeGitSummary: false,
    includeTaskModeHint: false,
  })
  assert.equal(ok.issues, undefined)
  assert.equal(ok.value.taskMode, 'creative')
  assert.equal(ok.value.hangingCommandTimeoutSeconds, 0)
  assert.equal(ok.value.includeGitSummary, false)

  // An unknown mode is a config error, not a silent fallback: the value decides
  // the persona for every delegation, so guessing would be worse than refusing.
  const bad = plugin.Config['~standard'].validate({ taskMode: 'fast' })
  assert.ok(Array.isArray(bad.issues))
  assert.match(JSON.stringify(bad.issues), /taskMode/)
})

test('delegate_coding_task refuses an empty task spec before doing any I/O', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)
  const sessions = new Map([['s1', fakeSession('s1', process.cwd())]])
  const { ctx, tools } = makeContext({ sessions })

  plugin.apply(ctx, {})
  const result = await tools.get('delegate_coding_task').execute({ task_spec: '   ' }, { agent: { id: 's1' } })
  assert.match(result, /task_spec must be a non-empty specification/)
})

test('delegate_coding_task refuses a workspace outside the session directory', async (t) => {
  const { entry } = await mountPlugin(t)
  const plugin = await import(pathToFileURL(entry).href)
  const sessions = new Map([['s1', fakeSession('s1', process.cwd())]])
  const { ctx, tools } = makeContext({ sessions })

  plugin.apply(ctx, {})
  const result = await tools.get('delegate_coding_task').execute(
    { task_spec: 'do something', workspace_dir: join(homedir(), 'elsewhere') },
    { agent: { id: 's1' } },
  )
  assert.match(result, /位于当前会话工作区之外/)
  assert.match(result, /allowOutsideWorkspace/)
})


// ---------------------------------------------------------------------------
// regression: the kill-switch line must be readable
// ---------------------------------------------------------------------------

test('renderKilledStep turns the step object into its index', async (t) => {
  const { entry } = await mountPlugin(t)
  // Measured in a live delegation: `turn.js` reports `killed.step` as the whole
  // normalized step object, and the report interpolated it directly, so the one
  // line a user reads when the breaker fires said "step [object Object]".
  const plugin = await import(pathToFileURL(entry).href)

  assert.equal(plugin.renderKilledStep({ step: { step_index: 7, type: 'RUN_COMMAND' } }), 'step 7')
  assert.doesNotMatch(plugin.renderKilledStep({ step: { step_index: 7 } }), /object Object/)
  // A bare index still renders, for callers that pass a number.
  assert.equal(plugin.renderKilledStep({ step: 3 }), 'step 3')
  // Degenerate inputs must not throw.
  assert.equal(plugin.renderKilledStep({}), 'step ?')
  assert.equal(plugin.renderKilledStep(undefined), 'step ?')
  assert.equal(plugin.renderKilledStep({ step: null }), 'step ?')
  assert.equal(plugin.renderKilledStep({ step: { step_index: 0 } }), 'step 0')
})
