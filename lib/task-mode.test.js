/**
 * Tests for the adaptive task mode (REQ-01, extended by REQ-05).
 *
 * The whole point of the module is that the user never edits a config file, so
 * the tests are written from the user's side: a prose task in either language
 * has to land on the right persona, an explicit tool-call argument has to win,
 * and a typo has to degrade instead of failing a delegation. The persona texts
 * are product requirements, so they are asserted verbatim — a refactor that
 * rewords them is a product regression, not a style choice.
 *
 * v0.8.0 added two things that are easy to get subtly wrong, so they get their
 * own sections below:
 *   - `document` must beat `creative` on an office-file task that also mentions
 *     a visual word ("图表动画" inside an .xlsx ask), because the creative
 *     keyword list is deliberately generous;
 *   - stickiness is a *fallback*, never an override: a regex hit wins over the
 *     session's recorded mode, otherwise a user who switches from surgical to
 *     document inside one session gets dragged back forever.
 *
 * Run: node --test lib/task-mode.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CREATIVE_TASK_RE,
  DEFAULT_TASK_MODE,
  DOCUMENT_TASK_RE,
  TASK_MODES,
  creativePreamble,
  creativeReviewGate,
  documentPreamble,
  documentReviewGate,
  documentStructurePrompt,
  documentSummaryPrompt,
  renderTaskMode,
  resolveTaskMode,
} from './task-mode.js'

/** Varied whitespace/case spellings of the creative markers. */
const CREATIVE_SPECS = [
  'build it with three.js and a few lights',
  'threejs scene please',
  'render it with WebGL',
  'draw everything onto a <canvas>',
  'use a custom shader for the glass',
  'add PBR materials to the shelves',
  'add UI design polish to the dashboard',
  'a landing page for the coffee shop',
  'a small browser game',
  'smooth animation on the doors',
  '帮我做一个三维场景',
  '帮我做个 HTML 3D 便利店场景',
  '这个着色器要更真实',
  '加点粒子效果',
  '做一个动画过渡',
  '做个经营类小游戏',
  '界面设计再精致一些',
  '视觉效果要拉满',
]

/** Engineering asks that must never be mistaken for a visual or document task. */
const SURGICAL_SPECS = [
  '帮我修个 Bug',
  '修复 lib/index.js 里的并发 bug',
  'refactor the quota guard',
  'add a unit test for the pacer',
  'fix the off-by-one in turn.js',
  'bump the changelog entry',
  // Near-misses for DOCUMENT_TASK_RE: "文档" bare and "password" must not fire.
  '更新 README 文档',
  'add password validation',
  '处理密码 password 字段',
]

/** Office-automation asks that must land on the document persona. */
const DOCUMENT_SPECS = [
  '生成 monthly-report.xlsx 报表',
  '把数据导出成 CSV',
  '做个季度汇报.pptx',
  '生成 PDF 合同',
  '写一份 Word 方案',
  '写一份 word 文档',
  '用 openpyxl 读一下 workbook',
  '做一个数据报表',
  '办公文档自动化',
  '生成幻灯片',
  '做 12 页演示文稿',
  '处理表格数据',
  'fill the worksheet with rows',
  'add slide 3 to the deck',
  '发票.xlsx',
  'report.CSV',
  '合同扫描.PDF',
]

/** Every mode a persisted (possibly corrupt) session record could carry. */
const DEGRADED_INPUTS = [
  undefined,
  {},
  null,
  'string',
  42,
  { task_spec: '' },
  { task_spec: null },
  { task_spec: undefined },
  { task_spec: 123 },
  { task_spec: ['three.js'] },
  { task_spec: {} },
  // A corrupt sticky record must degrade to today's behaviour, not throw.
  { task_spec: 'continue', sessionTaskMode: 'auto' },
  { task_spec: 'continue', sessionTaskMode: true },
  { task_spec: 'continue', sticky: 'matchbox' },
  { task_spec: 'continue', session: { sticky: 42 } },
  { task_spec: 'continue', session: null },
]

// ---------------------------------------------------------------------------
// exported vocabulary
// ---------------------------------------------------------------------------

test('TASK_MODES and DEFAULT_TASK_MODE expose the documented triple', () => {
  // v0.8.0 / REQ-05: was ['surgical', 'creative']. The original intent (a small,
  // explicit, closed set of personas, with surgical as the safe default) is
  // unchanged; the set simply gained its third member.
  assert.deepEqual(TASK_MODES, ['surgical', 'creative', 'document'])
  assert.equal(DEFAULT_TASK_MODE, 'surgical')
  assert.ok(CREATIVE_TASK_RE instanceof RegExp)
  assert.equal(CREATIVE_TASK_RE.flags.includes('i'), true, 'the regex must be case-insensitive')
})

test('DOCUMENT_TASK_RE is an exported case-insensitive RegExp', () => {
  assert.ok(DOCUMENT_TASK_RE instanceof RegExp)
  assert.equal(DOCUMENT_TASK_RE.flags.includes('i'), true, 'the regex must be case-insensitive')
})

test('DOCUMENT_TASK_RE covers every extension REQ-05 names', () => {
  for (const ext of ['.xlsx', '.pptx', '.docx', '.pdf', '.csv']) {
    assert.match(`out${ext}`, DOCUMENT_TASK_RE, `${ext} must be a document marker`)
  }
})

// ---------------------------------------------------------------------------
// resolveTaskMode: explicit argument wins
// ---------------------------------------------------------------------------

test('an explicit creative mode wins over an engineering task_spec', () => {
  const decision = resolveTaskMode({ task_mode: 'creative', task_spec: 'refactor the quota guard' })
  assert.deepEqual(decision, { mode: 'creative', source: 'call' })
})

test('an explicit surgical mode wins over a visual task_spec', () => {
  const decision = resolveTaskMode({ task_mode: 'surgical', task_spec: '帮我做个 3D 便利店' })
  assert.deepEqual(decision, { mode: 'surgical', source: 'call' })
})

test('an explicit document mode wins over an engineering task_spec', () => {
  const decision = resolveTaskMode({ task_mode: 'document', task_spec: 'refactor the quota guard' })
  assert.deepEqual(decision, { mode: 'document', source: 'call' })
})

test('an explicit mode beats the session sticky mode', () => {
  const decision = resolveTaskMode({
    task_mode: 'surgical',
    task_spec: '现在把第 3 页改成红色',
    sessionTaskMode: 'document',
  })
  assert.deepEqual(decision, { mode: 'surgical', source: 'call' })
})

test('an explicit mode is trimmed and lower-cased before matching', () => {
  assert.deepEqual(resolveTaskMode({ task_mode: 'CREATIVE ' }), {
    mode: 'creative',
    source: 'call',
  })
  assert.deepEqual(resolveTaskMode({ task_mode: '  Surgical' }), {
    mode: 'surgical',
    source: 'call',
  })
  assert.deepEqual(resolveTaskMode({ task_mode: ' Document ' }), {
    mode: 'document',
    source: 'call',
  })
})

// ---------------------------------------------------------------------------
// resolveTaskMode: auto-detection
// ---------------------------------------------------------------------------

test('a Chinese bug-fix request resolves to surgical/auto', () => {
  assert.deepEqual(resolveTaskMode({ task_spec: '帮我修个 Bug' }), {
    mode: 'surgical',
    source: 'auto',
  })
})

test('a Chinese 3D scene request resolves to creative/auto', () => {
  assert.deepEqual(resolveTaskMode({ task_spec: '帮我做个 HTML 3D 便利店场景' }), {
    mode: 'creative',
    source: 'auto',
  })
})

for (const spec of CREATIVE_SPECS) {
  test(`creative marker detected: ${spec}`, () => {
    assert.deepEqual(resolveTaskMode({ task_spec: spec }), { mode: 'creative', source: 'auto' })
  })
}

for (const spec of SURGICAL_SPECS) {
  test(`engineering request stays surgical: ${spec}`, () => {
    assert.deepEqual(resolveTaskMode({ task_spec: spec }), {
      mode: 'surgical',
      source: 'auto',
    })
  })
}

for (const spec of DOCUMENT_SPECS) {
  test(`document marker detected: ${spec}`, () => {
    assert.deepEqual(resolveTaskMode({ task_spec: spec }), { mode: 'document', source: 'auto' })
  })
}

test('"InstancedMesh" prose that mentions pbr counts as creative', () => {
  const spec = 'Build the shelves with InstancedMesh and add pbr materials to every box.'
  assert.match(spec, /InstancedMesh/)
  assert.equal(resolveTaskMode({ task_spec: spec }).mode, 'creative')
})

test('word-bounded markers do not fire inside unrelated identifiers', () => {
  // `3ds` and `canvasless` look like markers but are not the words themselves;
  // a false negative ships the skeletal scene, but these shapes were never
  // visual asks, so they must stay surgical.
  assert.equal(resolveTaskMode({ task_spec: 'read 3ds-max-notes.md' }).mode, 'surgical')
})

// ---------------------------------------------------------------------------
// v0.8.0: document outranks creative
// ---------------------------------------------------------------------------

test('an .xlsx task that mentions 图表动画 stays document, not creative', () => {
  // This is the regression REQ-05 spells out: the creative list is generous, so
  // ordering the document check second hands workbook jobs to the 3D persona.
  const decision = resolveTaskMode({ task_spec: '给 monthly-report.xlsx 加图表动画' })
  assert.deepEqual(decision, { mode: 'document', source: 'auto' })
})

test('document wins even when the creative markers are overwhelming', () => {
  const spec = '做一个 3D 界面设计的 landing page，并把数据导出成 report.xlsx 报表'
  assert.match(spec, CREATIVE_TASK_RE, 'the fixture must really hit the creative regex')
  assert.equal(resolveTaskMode({ task_spec: spec }).mode, 'document')
})

test('a pure visual task is still creative, so the ordering is not over-eager', () => {
  for (const spec of ['帮我做个 3D 便利店场景', 'a landing page for the coffee shop']) {
    assert.equal(resolveTaskMode({ task_spec: spec }).mode, 'creative')
  }
})

// ---------------------------------------------------------------------------
// v0.8.0: session stickiness
// ---------------------------------------------------------------------------

test('an increment with no marker inherits the session mode as sticky', () => {
  const decision = resolveTaskMode({
    task_spec: '现在把第 3 页改成红色',
    sessionTaskMode: 'document',
  })
  assert.deepEqual(decision, { mode: 'document', source: 'sticky' })
})

test('sticky accepts every documented spelling of the session field', () => {
  const spec = '继续，把剩下的补完'
  for (const options of [
    { sessionTaskMode: 'document' },
    { sticky: 'document' },
    { session: { sticky: 'document' } },
    { session: { taskMode: 'document' } },
  ]) {
    assert.deepEqual(
      resolveTaskMode({ task_spec: spec, ...options }),
      { mode: 'document', source: 'sticky' },
      JSON.stringify(options),
    )
  }
})

test('sticky values are normalised like task_mode is', () => {
  assert.deepEqual(resolveTaskMode({ task_spec: '继续', sessionTaskMode: '  CREATIVE ' }), {
    mode: 'creative',
    source: 'sticky',
  })
})

test('a regex hit beats the sticky mode (the user changed task class)', () => {
  // Long surgical session, then the user asks for a deck: the stale sticky mode
  // must not drag that turn back into the engineering persona.
  const swap = resolveTaskMode({
    task_spec: '再帮我做个季度汇报.pptx',
    sessionTaskMode: 'surgical',
  })
  assert.deepEqual(swap, { mode: 'document', source: 'auto' })

  // Same in the other direction, creative -> document.
  const toCreative = resolveTaskMode({
    task_spec: '现在来搭个 3D 便利店场景',
    sessionTaskMode: 'document',
  })
  assert.deepEqual(toCreative, { mode: 'creative', source: 'auto' })
})

test('an increment with no marker inherits sticky even if it looks like a code fix', () => {
  // There is deliberately no positive "surgical" regex — surgical is the
  // *absence* of markers — so "修一下 index.js" is indistinguishable from
  // "继续" at the detection layer, and REQ-05 says such a turn inherits the
  // session mode. Dropping into surgical is opt-in: pass `task_mode`
  // explicitly (tested above), which outranks stickiness.
  const decision = resolveTaskMode({
    task_spec: '修一下 index.js 里的并发 bug',
    sessionTaskMode: 'document',
  })
  assert.deepEqual(decision, { mode: 'document', source: 'sticky' })
  // ...and the explicit escape hatch still works.
  assert.deepEqual(
    resolveTaskMode({
      task_mode: 'surgical',
      task_spec: '修一下 index.js 里的并发 bug',
      sessionTaskMode: 'document',
    }),
    { mode: 'surgical', source: 'call' },
  )
})

test('stickiness is not used when there is no session mode at all', () => {
  assert.deepEqual(resolveTaskMode({ task_spec: '继续' }), { mode: 'surgical', source: 'auto' })
})

test('an unusable sticky value is ignored rather than inherited', () => {
  for (const sessionTaskMode of ['auto', '', 'matchbox', true, 42, null, {}]) {
    assert.deepEqual(
      resolveTaskMode({ task_spec: '继续', sessionTaskMode }),
      { mode: 'surgical', source: 'auto' },
      `sessionTaskMode ${String(sessionTaskMode)}`,
    )
  }
})

test('an empty-string task_mode still allows stickiness to apply', () => {
  const decision = resolveTaskMode({ task_mode: '', task_spec: '继续', sessionTaskMode: 'creative' })
  assert.deepEqual(decision, { mode: 'creative', source: 'sticky' })
})

// ---------------------------------------------------------------------------
// resolveTaskMode: degraded inputs
// ---------------------------------------------------------------------------

test('an empty, missing or non-string task_spec falls back to the default without throwing', () => {
  for (const input of DEGRADED_INPUTS) {
    const decision = resolveTaskMode(input)
    assert.equal(decision.mode, DEFAULT_TASK_MODE, `input ${JSON.stringify(input)}`)
    assert.equal(decision.source, 'auto', `input ${JSON.stringify(input)}`)
    assert.equal(decision.note, undefined, `input ${JSON.stringify(input)}`)
  }
})

test('an empty-string task_mode counts as absent, not as an invalid value', () => {
  const decision = resolveTaskMode({ task_mode: '', task_spec: 'a 3D scene' })
  assert.deepEqual(decision, { mode: 'creative', source: 'auto' })
})

test('an unknown explicit value falls back to auto-detection and explains itself', () => {
  const decision = resolveTaskMode({ task_mode: 'fast', task_spec: 'refactor the quota guard' })
  assert.equal(decision.mode, 'surgical')
  assert.equal(decision.source, 'invalid')
  assert.equal(decision.note, '未知的 task_mode "fast"，已按 task_spec 自动判定为 surgical。')
})

test('an unknown explicit value still lets a visual task_spec win', () => {
  const decision = resolveTaskMode({ task_mode: 'fast', task_spec: '帮我做个 3D 便利店场景' })
  assert.equal(decision.mode, 'creative')
  assert.equal(decision.source, 'invalid')
  assert.match(decision.note, /未知的 task_mode "fast".*creative/)
})

test('an unknown explicit value still lets a document task_spec win', () => {
  const decision = resolveTaskMode({ task_mode: 'fast', task_spec: '生成 report.xlsx' })
  assert.equal(decision.mode, 'document')
  assert.equal(decision.source, 'invalid')
  assert.match(decision.note, /未知的 task_mode "fast".*document/)
})

test('an unknown explicit value with no marker notes the inherited sticky mode', () => {
  const decision = resolveTaskMode({
    task_mode: 'fast',
    task_spec: '继续',
    sessionTaskMode: 'document',
  })
  assert.equal(decision.mode, 'document')
  assert.equal(decision.source, 'invalid')
  assert.match(decision.note, /未知的 task_mode "fast"/)
  assert.match(decision.note, /继承/)
})

test('a non-string explicit value is reported, not thrown', () => {
  const numeric = resolveTaskMode({ task_mode: 123 })
  assert.equal(numeric.mode, 'surgical')
  assert.equal(numeric.source, 'invalid')
  assert.equal(numeric.note, '未知的 task_mode "123"，已按 task_spec 自动判定为 surgical。')

  const symbol = resolveTaskMode({ task_mode: Symbol('creative') })
  assert.equal(symbol.source, 'invalid')
  assert.match(symbol.note, /未知的 task_mode "Symbol\(creative\)"/)
})

// ---------------------------------------------------------------------------
// creativePreamble()
// ---------------------------------------------------------------------------

test('creativePreamble returns the verbatim product text', () => {
  const expected = `[CREATIVE & VISUAL DENSITY MODE]
- Do NOT build a minimal MVP or use bare single-primitive placeholders (e.g. plain colored boxes as furniture, shelves, or buildings).
- Maximize visual richness and code completeness: build composite multi-part geometries, use InstancedMesh for repeating props/products, generate procedural CanvasTextures for signage/labels/tiles, and configure layered lighting (ambient + directional/spot lights with shadows, emissive materials, and post-processing where applicable).
- Prioritize visual polish, material realism, and interactive details over code brevity.`
  assert.equal(creativePreamble(), expected)
})

test('creativePreamble keeps the markers the supervisor prompt relies on', () => {
  const text = creativePreamble()
  assert.match(text, /^\[CREATIVE & VISUAL DENSITY MODE\]/)
  assert.match(text, /InstancedMesh/)
  assert.match(text, /CanvasTexture/)
  assert.match(text, /post-processing/)
  assert.equal(text.split('\n').length, 4)
})

// ---------------------------------------------------------------------------
// documentPreamble() / documentStructurePrompt()
// ---------------------------------------------------------------------------

test('documentPreamble opens with the document mode header', () => {
  assert.match(documentPreamble(), /^\[DOCUMENT & OFFICE AUTOMATION MODE\]\n/)
})

test('documentPreamble forbids hand-writing the binary formats', () => {
  const text = documentPreamble()
  assert.match(text, /NEVER hand-write a binary document/)
  // The exact tools an executor reaches for when it tries to "just append bytes".
  for (const tool of ['sed', 'awk', 'patch', 'base64']) {
    assert.ok(text.includes(tool), `the ban list must name ${tool}`)
  }
})

test('documentPreamble mandates one concrete library per format', () => {
  const text = documentPreamble()
  for (const lib of [
    'openpyxl',
    'python-pptx',
    'python-docx',
    'pypdf',
    'reportlab',
    'csv',
  ]) {
    assert.ok(text.includes(lib), `the persona must name ${lib}`)
  }
})

test('documentPreamble states a style book, not just "make it pretty"', () => {
  const text = documentPreamble()
  // Font size, palette, table style and number formats: the four things a
  // library-default document gets wrong.
  assert.match(text, /18-20pt/)
  assert.match(text, /10-11pt/)
  assert.match(text, /accent colour/)
  assert.match(text, /table style/)
  assert.match(text, /Number formats/)
})

test('documentPreamble requires verification by re-opening the saved file', () => {
  assert.match(documentPreamble(), /RE-OPENING the saved file/)
})

test('documentPreamble embeds the end-of-turn structure summary demand', () => {
  // One injected block == one complete contract; the caller must not have to
  // remember a second export to get the summary requirement.
  assert.ok(documentPreamble().includes(documentSummaryPrompt()))
})

test('documentStructurePrompt names the structure fields per format', () => {
  const text = documentStructurePrompt()
  assert.match(text, /^\[DOCUMENT STRUCTURE SUMMARY/)
  assert.match(text, /\[DOCUMENT STRUCTURE SUMMARY\]/, 'the reply block marker')
  for (const field of ['sheet name', 'rows x columns', 'slide count', 'heading outline', 'page count']) {
    assert.ok(text.includes(field), `the summary must ask for ${field}`)
  }
})

test('documentStructurePrompt explains why git diff is not enough', () => {
  assert.match(documentStructurePrompt(), /git diff/)
})

test('the two summary prompt names return the identical block', () => {
  // `index.js` imports the Structure spelling; the Summary alias exists so the
  // name written up in the task description keeps working.
  assert.equal(documentSummaryPrompt(), documentStructurePrompt())
  assert.ok(documentPreamble().includes(documentStructurePrompt()))
})

test('documentStructurePrompt respects the configured summary cap', () => {
  // `documentMaxSummaryChars` defaults to 6000 (CONTRACT §7.2).
  assert.match(documentStructurePrompt(), /documentMaxSummaryChars/)
  assert.match(documentStructurePrompt(), /6000/)
})

// ---------------------------------------------------------------------------
// creativeReviewGate()
// ---------------------------------------------------------------------------

test('creativeReviewGate returns the verbatim gate for creative + turn 1', () => {
  const expected = `[Supervisor Creative Gate — Pass 1 Completed]
This is Pass 1 of a creative/visual task. Before accepting, inspect the code for visual density:
1. Are objects built from composite geometries and procedural textures (CanvasTexture / PBR materials), or just bare placeholder primitives?
2. Are interior props, lighting atmosphere, and interactive controls fully fleshed out?
If the scene is skeletal or under-detailed, DO NOT finish — immediately call \`delegate_coding_task\` again with the SAME \`session_id\` and \`task_mode: "creative"\` to execute Pass 2 (detail & prop expansion).`
  assert.equal(creativeReviewGate({ mode: 'creative', turnCount: 1 }), expected)
})

test('creativeReviewGate also accepts a stringified turn count', () => {
  assert.equal(
    creativeReviewGate({ mode: 'creative', turnCount: '1' }),
    creativeReviewGate({ mode: 'creative', turnCount: 1 }),
  )
})

test('creativeReviewGate fires only on turn 1', () => {
  for (const turnCount of [0, 2, 3, undefined, null, '2', Number.NaN]) {
    assert.equal(
      creativeReviewGate({ mode: 'creative', turnCount }),
      undefined,
      `turnCount ${String(turnCount)} must not be gated`,
    )
  }
})

test('creativeReviewGate never fires for surgical mode', () => {
  for (const turnCount of [0, 1, 2, undefined]) {
    assert.equal(creativeReviewGate({ mode: 'surgical', turnCount }), undefined)
  }
})

test('creativeReviewGate never fires for document mode', () => {
  for (const turnCount of [0, 1, 2, undefined]) {
    assert.equal(creativeReviewGate({ mode: 'document', turnCount }), undefined)
  }
})

test('creativeReviewGate tolerates a missing or malformed argument', () => {
  assert.equal(creativeReviewGate(), undefined)
  assert.equal(creativeReviewGate({}), undefined)
  assert.equal(creativeReviewGate({ mode: 'creative' }), undefined)
  assert.equal(creativeReviewGate(null), undefined)
})

// ---------------------------------------------------------------------------
// documentReviewGate() — fires on EVERY document turn, unlike the creative gate
// ---------------------------------------------------------------------------

test('documentReviewGate fires for document mode on every turn', () => {
  // The mirror image of the creative gate: `git diff` never becomes informative
  // for an office file, so the evidence check is per-turn, not pass-1 only.
  for (const turnCount of [1, 2, 3, 8, 42, undefined, '2']) {
    const gate = documentReviewGate({ mode: 'document', turnCount })
    assert.match(gate, /^\[Supervisor Document Gate/, `turnCount ${String(turnCount)}`)
  }
})

test('documentReviewGate asks whether a structure summary was printed', () => {
  const gate = documentReviewGate({ mode: 'document', turnCount: 3 })
  assert.match(gate, /DOCUMENT STRUCTURE SUMMARY/)
  assert.match(gate, /git diff/)
  // It must tell the supervisor to re-dispatch, not just to frown.
  assert.match(gate, /delegate_coding_task/)
  assert.match(gate, /task_mode: "document"/)
})

test('documentReviewGate stands down once the summary is present', () => {
  assert.equal(documentReviewGate({ mode: 'document', hasSummary: true }), undefined)
  // Only the literal boolean counts; a truthy non-boolean stays gated.
  assert.match(documentReviewGate({ mode: 'document', hasSummary: 'yes' }), /Document Gate/)
})

test('documentReviewGate never fires outside document mode', () => {
  for (const mode of ['surgical', 'creative', undefined, null, 'matchbox']) {
    assert.equal(documentReviewGate({ mode, turnCount: 1 }), undefined, String(mode))
  }
})

test('documentReviewGate tolerates a missing or malformed argument', () => {
  assert.equal(documentReviewGate(), undefined)
  assert.equal(documentReviewGate({}), undefined)
  assert.equal(documentReviewGate(null), undefined)
})

// ---------------------------------------------------------------------------
// renderTaskMode()
// ---------------------------------------------------------------------------

test('renderTaskMode labels an explicit choice', () => {
  assert.equal(
    renderTaskMode({ mode: 'creative', source: 'call' }),
    'task_mode    : creative (explicit)',
  )
  assert.equal(
    renderTaskMode({ mode: 'document', source: 'call' }),
    'task_mode    : document (explicit)',
  )
})

test('renderTaskMode labels auto-detection', () => {
  assert.equal(
    renderTaskMode({ mode: 'creative', source: 'auto' }),
    'task_mode    : creative (auto-detected from task_spec)',
  )
  assert.equal(
    renderTaskMode({ mode: 'surgical', source: 'auto' }),
    'task_mode    : surgical (auto-detected from task_spec)',
  )
  // REQ-05 acceptance wording.
  assert.equal(
    renderTaskMode({ mode: 'document', source: 'auto' }),
    'task_mode    : document (auto-detected from task_spec)',
  )
})

test('renderTaskMode labels the inherited (sticky) mode distinctly', () => {
  const line = renderTaskMode({ mode: 'document', source: 'sticky' })
  assert.equal(line, 'task_mode    : document (sticky, inherited from session)')
})

test('renderTaskMode admits that an explicit value was ignored', () => {
  const line = renderTaskMode({ mode: 'surgical', source: 'invalid', note: 'ignored' })
  assert.equal(line, 'task_mode    : surgical (auto, explicit value ignored)')
})

test('renderTaskMode degrades to the default persona for a malformed decision', () => {
  // A rendering helper must never be the thing that breaks a report.
  assert.equal(
    renderTaskMode(undefined),
    'task_mode    : surgical (auto-detected from task_spec)',
  )
  assert.equal(
    renderTaskMode({ mode: 'matchbox', source: 'call' }),
    'task_mode    : surgical (explicit)',
  )
})

test('renderTaskMode keeps the check_environment column width', () => {
  const line = renderTaskMode(resolveTaskMode({ task_spec: 'a 3D scene' }))
  assert.match(line, /^task_mode {4}: /)
})

test('renderTaskMode renders every mode from a real decision', () => {
  assert.match(renderTaskMode(resolveTaskMode({ task_spec: '生成 report.xlsx' })), /document/)
  assert.match(renderTaskMode(resolveTaskMode({ task_spec: 'a 3D scene' })), /creative/)
  assert.match(
    renderTaskMode(resolveTaskMode({ task_spec: '继续', sessionTaskMode: 'document' })),
    /sticky/,
  )
})
