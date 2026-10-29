/**
 * Tests for the transcript layer (REQ-02): step normalization for both sources
 * and the four priority paths of `readTranscript`.
 *
 * Fixtures are built in a temporary directory and pointed at through
 * `AGY_BRAIN_DIR`, so the tests never touch the real Antigravity profile.
 *
 * Run: node --test lib/transcript.test.js
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  brainDir,
  normalizeStep,
  readTranscript,
  readTranscriptViaRpc,
  transcriptPaths,
} from './transcript.js'

// ---------------------------------------------------------------------------
// fixture plumbing
// ---------------------------------------------------------------------------

let fixtureRoot

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'agy-transcript-'))
  process.env.AGY_BRAIN_DIR = fixtureRoot
})

after(async () => {
  delete process.env.AGY_BRAIN_DIR
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
})

const conversationDir = (id) => join(fixtureRoot, id, '.system_generated', 'logs')

/** Write one JSONL file for a conversation. Rows may be objects or raw strings. */
async function writeJsonl(conversationId, file, rows) {
  const dir = conversationDir(conversationId)
  await mkdir(dir, { recursive: true })
  const body = rows
    .map((row) => (typeof row === 'string' ? row : JSON.stringify(row)))
    .join('\n')
  await writeFile(join(dir, file), `${body}\n`, 'utf8')
}

const planner = (index, response, extra = {}) => ({
  step_index: index,
  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  status: 'CORTEX_STEP_STATUS_DONE',
  createdAt: '2026-01-01T00:00:00Z',
  plannerResponse: { response, ...extra },
})

const toolStep = (index, name, args) => ({
  step_index: index,
  type: 'CORTEX_STEP_TYPE_GENERIC',
  status: 'CORTEX_STEP_STATUS_DONE',
  metadata: { toolCall: { id: `t${index}`, name, argumentsJson: JSON.stringify(args) } },
})

// ---------------------------------------------------------------------------
// transcriptPaths / brainDir
// ---------------------------------------------------------------------------

test('transcriptPaths points at the brain logs directory', () => {
  const paths = transcriptPaths('conv-1')
  assert.equal(paths.dir, join(fixtureRoot, 'conv-1', '.system_generated', 'logs'))
  assert.equal(paths.compact, join(paths.dir, 'transcript.jsonl'))
  assert.equal(paths.full, join(paths.dir, 'transcript_full.jsonl'))
  assert.equal(brainDir(), fixtureRoot)
})

// ---------------------------------------------------------------------------
// normalizeStep: RPC source
// ---------------------------------------------------------------------------

test('normalizeStep maps an RPC planner response', () => {
  const step = normalizeStep(planner(7, 'done, all tests pass'), 0)
  assert.equal(step.step_index, 7)
  assert.equal(step.type, 'PLANNER_RESPONSE')
  assert.equal(step.status, 'DONE')
  assert.equal(step.content, 'done, all tests pass')
  assert.deepEqual(step.tool_calls, [])
  assert.equal(step.raw.plannerResponse.response, 'done, all tests pass')
})

test('normalizeStep prefers modifiedResponse over response', () => {
  const raw = planner(3, 'draft text', { modifiedResponse: 'final text' })
  assert.equal(normalizeStep(raw, 0).content, 'final text')
})

test('normalizeStep reads a tool call from metadata.toolCall and re-parses argumentsJson', () => {
  // The live RPC sends argumentsJson as a *string*; the args must survive.
  const step = normalizeStep(
    toolStep(5, 'run_command', { CommandLine: 'npm test', WaitMsBeforeAsync: 1000 }),
    0,
  )
  assert.equal(step.tool_calls.length, 1)
  assert.equal(step.tool_calls[0].name, 'run_command')
  assert.deepEqual(step.tool_calls[0].args, { CommandLine: 'npm test', WaitMsBeforeAsync: 1000 })
  // The step type was GENERIC while generating: the tool name is the judge.
  assert.equal(step.type, 'GENERIC')
})

test('normalizeStep tolerates malformed argumentsJson', () => {
  const raw = {
    step_index: 1,
    type: 'CORTEX_STEP_TYPE_GENERIC',
    metadata: { toolCall: { name: 'view_file', argumentsJson: '{not json' } },
  }
  const step = normalizeStep(raw, 0)
  assert.equal(step.tool_calls[0].name, 'view_file')
  assert.deepEqual(step.tool_calls[0].args, {})
})

test('normalizeStep maps RUN_COMMAND without metadata from runCommand.commandLine', () => {
  const raw = {
    step_index: 9,
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status: 'CORTEX_STEP_STATUS_DONE',
    runCommand: { commandLine: 'Set-Location -LiteralPath E:\\ws; npm test', exitCode: 0 },
  }
  const step = normalizeStep(raw, 0)
  assert.equal(step.type, 'RUN_COMMAND')
  assert.deepEqual(step.tool_calls, [
    { name: 'run_command', args: { CommandLine: 'Set-Location -LiteralPath E:\\ws; npm test' } },
  ])
})

test('normalizeStep maps RUN_COMMAND using runCommand.command when commandLine is absent', () => {
  const raw = { step_index: 2, type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { command: 'ls' } }
  assert.deepEqual(normalizeStep(raw, 0).tool_calls[0].args, { CommandLine: 'ls' })
})

test('normalizeStep maps VIEW_FILE and READ_FILE to view_file', () => {
  const view = normalizeStep(
    { step_index: 4, type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { path: 'E:\\ws\\a.js' } },
    0,
  )
  assert.equal(view.type, 'VIEW_FILE')
  assert.deepEqual(view.tool_calls, [{ name: 'view_file', args: { Path: 'E:\\ws\\a.js' } }])

  const read = normalizeStep(
    {
      step_index: 5,
      type: 'CORTEX_STEP_TYPE_READ_FILE',
      readFile: { path: 'E:\\ws\\b.js' },
    },
    0,
  )
  assert.equal(read.type, 'VIEW_FILE')
  assert.deepEqual(read.tool_calls, [{ name: 'view_file', args: { Path: 'E:\\ws\\b.js' } }])

  const filePath = normalizeStep(
    { step_index: 6, type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { filePath: 'E:\\ws\\c.js' } },
    0,
  )
  assert.deepEqual(filePath.tool_calls, [{ name: 'view_file', args: { Path: 'E:\\ws\\c.js' } }])
})

test('normalizeStep joins USER_INPUT items', () => {
  const raw = {
    step_index: 0,
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    userInput: { items: [{ text: 'first line' }, { text: 'second line' }] },
  }
  const step = normalizeStep(raw, 0)
  assert.equal(step.type, 'USER_INPUT')
  assert.equal(step.content, 'first line\nsecond line')
})

test('normalizeStep maps ERROR_MESSAGE shortError', () => {
  const raw = {
    step_index: 11,
    type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
    errorMessage: { error: { shortError: 'boom', message: 'longer detail' } },
  }
  assert.equal(normalizeStep(raw, 0).content, 'boom')
})

test('normalizeStep strips the prefix for unknown types', () => {
  const raw = { step_index: 12, type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' }
  const step = normalizeStep(raw, 0)
  assert.equal(step.type, 'SYSTEM_MESSAGE')
  assert.equal(step.content, '')
  assert.deepEqual(step.tool_calls, [])
})

test('normalizeStep falls back to the positional index and empty status', () => {
  const step = normalizeStep({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' }, 6)
  assert.equal(step.step_index, 6)
  assert.equal(step.status, '')
  assert.equal(step.created_at, '')
})

test('normalizeStep keeps planner toolCalls as tool_calls', () => {
  const raw = planner(8, '', {
    toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm run build' } }],
  })
  const step = normalizeStep(raw, 0)
  assert.equal(step.content, '')
  assert.deepEqual(step.tool_calls, [
    { name: 'run_command', args: { CommandLine: 'npm run build' } },
  ])
})

// ---------------------------------------------------------------------------
// normalizeStep: transcript source
// ---------------------------------------------------------------------------

test('normalizeStep passes an already-normalized transcript row through', () => {
  const raw = {
    step_index: 3,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-01-01T00:00:00Z',
    content: 'hello',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }],
  }
  const step = normalizeStep(raw, 0)
  assert.equal(step.step_index, 3)
  assert.equal(step.type, 'PLANNER_RESPONSE')
  assert.equal(step.content, 'hello')
  assert.deepEqual(step.tool_calls, [{ name: 'run_command', args: { CommandLine: 'ls' } }])
  assert.equal(step.truncated, undefined)
})

test('normalizeStep dedupes the same call reported twice', () => {
  const raw = {
    step_index: 2,
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: { toolCall: { name: 'run_command', argumentsJson: '{"CommandLine":"ls"}' } },
    plannerResponse: { toolCalls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] },
  }
  assert.equal(normalizeStep(raw, 0).tool_calls.length, 1)
})

test('normalizeStep flags truncated rows', () => {
  const raw = { step_index: 29, type: 'PLANNER_RESPONSE', content: 'x', truncated_fields: ['content'] }
  const step = normalizeStep(raw, 0)
  assert.equal(step.truncated, true)
  assert.deepEqual(step.raw.truncated_fields, ['content'])
})

// ---------------------------------------------------------------------------
// readTranscript: priority paths
// ---------------------------------------------------------------------------

test('readTranscript prefers transcript_full.jsonl when it is present', async () => {
  await writeJsonl('c-full', 'transcript.jsonl', [planner(0, 'short')])
  await writeJsonl('c-full', 'transcript_full.jsonl', [
    planner(0, 'the complete answer'),
    planner(1, 'and more'),
  ])
  const read = await readTranscript('c-full')
  assert.equal(read.source, 'full')
  assert.equal(read.steps.length, 2)
  assert.equal(read.steps[0].content, 'the complete answer')
  assert.deepEqual(read.truncatedSteps, [])
})

test('readTranscript ignores a stale full copy that lags the compact one', async () => {
  await writeJsonl('c-lag', 'transcript.jsonl', [planner(0, 'a'), planner(1, 'b')])
  await writeJsonl('c-lag', 'transcript_full.jsonl', [planner(0, 'a')])
  const read = await readTranscript('c-lag')
  assert.equal(read.source, 'compact')
  assert.equal(read.steps.length, 2)
})

test('readTranscript uses the compact copy when preferFull is false', async () => {
  await writeJsonl('c-compact', 'transcript.jsonl', [planner(0, 'compact answer')])
  await writeJsonl('c-compact', 'transcript_full.jsonl', [planner(0, 'full answer')])
  const read = await readTranscript('c-compact', { preferFull: false })
  assert.equal(read.source, 'compact')
  assert.equal(read.steps[0].content, 'compact answer')
})

test('readTranscript reports truncated steps when RPC is unavailable', async () => {
  await writeJsonl('c-trunc', 'transcript.jsonl', [
    { step_index: 29, type: 'PLANNER_RESPONSE', content: 'partial…', truncated_fields: ['content'] },
  ])
  const read = await readTranscript('c-trunc')
  assert.equal(read.source, 'compact')
  assert.deepEqual(read.truncatedSteps, [29])
  assert.equal(read.steps[0].content, 'partial…')
})

test('readTranscript repairs truncated steps from RPC (compact+rpc)', async () => {
  await writeJsonl('c-repair', 'transcript.jsonl', [
    { step_index: 0, type: 'PLANNER_RESPONSE', content: 'intro' },
    { step_index: 29, type: 'PLANNER_RESPONSE', content: 'partial…', truncated_fields: ['content'] },
  ])
  const fullText = 'x'.repeat(5720)
  const rpc = {
    async getCascadeTrajectorySteps() {
      return [
        { step_index: 0, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'intro' } },
        { step_index: 29, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: fullText } },
      ]
    },
  }
  const read = await readTranscript('c-repair', { server: { port: 1, csrf: 'x' }, rpc })
  assert.equal(read.source, 'compact+rpc')
  assert.deepEqual(read.truncatedSteps, [])
  assert.equal(read.steps[1].content.length, 5720)
})

test('readTranscript keeps the compact text when RPC repair fails', async () => {
  await writeJsonl('c-repair-fail', 'transcript.jsonl', [
    { step_index: 29, type: 'PLANNER_RESPONSE', content: 'partial…', truncated_fields: ['content'] },
  ])
  const rpc = {
    async getCascadeTrajectorySteps() {
      throw Object.assign(new Error('network down'), { retryable: true })
    },
  }
  const read = await readTranscript('c-repair-fail', { server: { port: 1, csrf: 'x' }, rpc })
  assert.equal(read.source, 'compact')
  assert.deepEqual(read.truncatedSteps, [29])
})

test('readTranscript falls back to RPC only when no transcript file exists', async () => {
  const rpc = {
    async getCascadeTrajectorySteps() {
      return [planner(0, 'answer from rpc'), toolStep(1, 'run_command', { CommandLine: 'ls' })]
    }
  }
  const read = await readTranscript('c-rpc-only', { server: { port: 1, csrf: 'x' }, rpc })
  assert.equal(read.source, 'rpc')
  assert.equal(read.steps.length, 2)
  assert.equal(read.steps[0].content, 'answer from rpc')
  assert.deepEqual(read.steps[1].tool_calls[0].args, { CommandLine: 'ls' })
})

test('readTranscript returns source none when nothing is available', async () => {
  const read = await readTranscript('c-missing')
  assert.deepEqual(read, { steps: [], source: 'none', truncatedSteps: [] })

  const noServer = await readTranscript('c-missing', { server: { port: 1, csrf: 'x' } })
  assert.equal(noServer.source, 'none')
})

test('readTranscript skips a partially flushed trailing line', async () => {
  await writeJsonl('c-partial', 'transcript.jsonl', [
    planner(0, 'first'),
    '{"step_index":1,"type":"PLANNER_RESPO',
  ])
  const read = await readTranscript('c-partial')
  assert.equal(read.source, 'compact')
  assert.equal(read.steps.length, 1)
})

test('readTranscriptViaRpc reports none on a bare failure', async () => {
  const rpc = {
    async getCascadeTrajectorySteps() {
      throw Object.assign(new Error('ECONNREFUSED'), { retryable: true })
    },
  }
  const read = await readTranscriptViaRpc({ port: 1, csrf: 'x' }, 'c-x', { rpc })
  assert.deepEqual(read, { steps: [], source: 'none', truncatedSteps: [] })

  const noServer = await readTranscriptViaRpc(undefined, 'c-x')
  assert.equal(noServer.source, 'none')
})

// ---------------------------------------------------------------------------
// RPC field shapes that the real Language Server actually sends
// ---------------------------------------------------------------------------
//
// These cases were found against a live 2.28.0 instance, not invented:
// `viewFile` names the path in `absolutePathUri` and holds the text in
// `content`. Without mapping both, the truncation repair compares the compact
// copy against an empty string and "succeeds" while the text stays short.

const rpcViewFileStep = (index, uri, content) => ({
  type: 'CORTEX_STEP_TYPE_VIEW_FILE',
  status: 'CORTEX_STEP_STATUS_DONE',
  metadata: { createdAt: '2026-01-01T00:00:00Z' },
  viewFile: {
    absolutePathUri: uri,
    content,
    startLine: 1,
    endLine: 2,
    numLines: 10,
    numBytes: content.length,
  },
})

test('normalizeStep maps viewFile.absolutePathUri to a plain path', () => {
  const step = normalizeStep(rpcViewFileStep(0, 'file:///C:/projects/proj/src/index.ts', 'x'), 0)
  assert.equal(step.type, 'VIEW_FILE')
  assert.equal(step.tool_calls.length, 1)
  assert.equal(step.tool_calls[0].name, 'view_file')
  // The auditor compares plain paths, so the file:/// prefix must be gone.
  assert.equal(step.tool_calls[0].args.Path, 'C:/projects/proj/src/index.ts')
})

test('normalizeStep surfaces viewFile.content so truncation repair can compare', () => {
  const step = normalizeStep(rpcViewFileStep(0, 'file:///F:/a.txt', 'a long body'), 0)
  assert.equal(step.content, 'a long body')
})

test('normalizeStep decodes percent-encoded URIs', () => {
  const step = normalizeStep(rpcViewFileStep(0, 'file:///C:/projects/my%20dir/a.txt', 'x'), 0)
  assert.equal(step.tool_calls[0].args.Path, 'C:/projects/my dir/a.txt')
})

test('normalizeStep leaves a plain path untouched when no URI is present', () => {
  const plain = "F:\\\\work\\\\a.txt"
  const step = normalizeStep({ type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { path: plain } }, 0)
  assert.equal(step.tool_calls[0].args.Path, plain)
})
