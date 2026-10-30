/**
 * Tests for the adaptive task mode (REQ-01).
 *
 * The whole point of the module is that the user never edits a config file, so
 * the tests are written from the user's side: a prose task in either language
 * has to land on the right persona, an explicit tool-call argument has to win,
 * and a typo has to degrade instead of failing a delegation. The two persona
 * texts are product requirements, so they are asserted verbatim — a refactor that
 * rewords them is a product regression, not a style choice.
 *
 * Run: node --test lib/task-mode.test.js
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CREATIVE_TASK_RE,
  DEFAULT_TASK_MODE,
  TASK_MODES,
  creativePreamble,
  creativeReviewGate,
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

/** Engineering asks that must never be mistaken for a visual task. */
const SURGICAL_SPECS = [
  '帮我修个 Bug',
  '修复 lib/index.js 里的并发 bug',
  'refactor the quota guard',
  'add a unit test for the pacer',
  'fix the off-by-one in turn.js',
  'bump the changelog entry',
]

// ---------------------------------------------------------------------------
// exported vocabulary
// ---------------------------------------------------------------------------

test('TASK_MODES and DEFAULT_TASK_MODE expose the documented pair', () => {
  assert.deepEqual(TASK_MODES, ['surgical', 'creative'])
  assert.equal(DEFAULT_TASK_MODE, 'surgical')
  assert.ok(CREATIVE_TASK_RE instanceof RegExp)
  assert.equal(CREATIVE_TASK_RE.flags.includes('i'), true, 'the regex must be case-insensitive')
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

test('an explicit mode is trimmed and lower-cased before matching', () => {
  assert.deepEqual(resolveTaskMode({ task_mode: 'CREATIVE ' }), {
    mode: 'creative',
    source: 'call',
  })
  assert.deepEqual(resolveTaskMode({ task_mode: '  Surgical' }), {
    mode: 'surgical',
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
// resolveTaskMode: degraded inputs
// ---------------------------------------------------------------------------

test('an empty, missing or non-string task_spec falls back to the default without throwing', () => {
  const inputs = [
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
  ]
  for (const input of inputs) {
    const decision = resolveTaskMode(input)
    assert.equal(decision.mode, DEFAULT_TASK_MODE, `input ${JSON.stringify(input)}`)
    assert.equal(decision.source, 'auto')
    assert.equal(decision.note, undefined)
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

test('creativeReviewGate tolerates a missing or malformed argument', () => {
  assert.equal(creativeReviewGate(), undefined)
  assert.equal(creativeReviewGate({}), undefined)
  assert.equal(creativeReviewGate({ mode: 'creative' }), undefined)
  assert.equal(creativeReviewGate(null), undefined)
})

// ---------------------------------------------------------------------------
// renderTaskMode()
// ---------------------------------------------------------------------------

test('renderTaskMode labels an explicit choice', () => {
  assert.equal(
    renderTaskMode({ mode: 'creative', source: 'call' }),
    'task_mode    : creative (explicit)',
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
