/**
 * Unit tests for the long-session rollover brief (REQ-04).
 *
 * The brief is the only thing that crosses a session boundary, so the tests
 * pin the three properties that deciding "what to carry" depends on: order is
 * first-touch order, the list is bounded, and every path is workspace-relative
 * and slash-separated. The banner test asserts the exact text, because the
 * whole point of the hard instruction is that it reaches the agent verbatim.
 *
 * Run: node --test lib/session-brief.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildRolloverBrief, isLongSession, renderRolloverPrompt } from './session-brief.js'

const WORKSPACE = 'F:\\work\\app'

// ---------------------------------------------------------------------------
// buildRolloverBrief — shape and empty input
// ---------------------------------------------------------------------------

test('empty record yields an empty brief, not undefined', () => {
  assert.deepEqual(buildRolloverBrief({}), {
    cumulativeTouchedFiles: [],
    lastPlanHead: '',
    previousTurnCount: 0,
  })
})

test('missing or non-object records degrade to the empty brief', () => {
  const empty = {
    cumulativeTouchedFiles: [],
    lastPlanHead: '',
    previousTurnCount: 0,
  }
  for (const record of [undefined, null, 'F:\\work', 42, true]) {
    assert.deepEqual(buildRolloverBrief(record), empty)
  }
})

test('a missing options bag is tolerated (no destructuring throw)', () => {
  const record = { turn_count: 3, last_touched_files: ['src/a.js'] }
  for (const options of [undefined, null, 'nope']) {
    assert.deepEqual(buildRolloverBrief(record, options), {
      cumulativeTouchedFiles: ['src/a.js'],
      lastPlanHead: '',
      previousTurnCount: 3,
    })
  }
})

// ---------------------------------------------------------------------------
// buildRolloverBrief — files: merge, order, dedupe, cap
// ---------------------------------------------------------------------------

test('merges the record list then extraFiles, preserving first-touch order', () => {
  const brief = buildRolloverBrief(
    { last_touched_files: ['src/a.js', 'src/b.js'] },
    { extraFiles: ['src/c.js', 'src/d.js'] },
  )
  assert.deepEqual(brief.cumulativeTouchedFiles, [
    'src/a.js',
    'src/b.js',
    'src/c.js',
    'src/d.js',
  ])
})

test('de-duplicates while keeping the first occurrence position', () => {
  const brief = buildRolloverBrief(
    // 'src/b.js' is touched at index 1 and again at index 3; it must stay at 1.
    { last_touched_files: ['src/a.js', 'src/b.js', 'src/c.js', 'src/b.js', 'src/a.js'] },
    { extraFiles: ['src/c.js', 'src/e.js'] },
  )
  assert.deepEqual(brief.cumulativeTouchedFiles, [
    'src/a.js',
    'src/b.js',
    'src/c.js',
    'src/e.js',
  ])
})

test('de-duplicates across absolute and already-relative spellings', () => {
  const brief = buildRolloverBrief(
    {
      workspace_dir: WORKSPACE,
      last_touched_files: [
        'F:\\work\\app\\src\\auth.js',
        'src/auth.js',
        './src/auth.js',
        'src\\login.js',
      ],
    },
    { extraFiles: ['F:/work/app/src/login.js'] },
  )
  assert.deepEqual(brief.cumulativeTouchedFiles, ['src/auth.js', 'src/login.js'])
})

test('caps the cumulative list at 15 entries', () => {
  const many = Array.from({ length: 20 }, (_, i) => `src/file-${String(i + 1).padStart(2, '0')}.js`)
  const brief = buildRolloverBrief({ last_touched_files: many })
  assert.equal(brief.cumulativeTouchedFiles.length, 15)
  // The cap keeps the *first* 15, not the last 15.
  assert.equal(brief.cumulativeTouchedFiles[0], 'src/file-01.js')
  assert.equal(brief.cumulativeTouchedFiles[14], 'src/file-15.js')
  assert.equal(brief.cumulativeTouchedFiles.includes('src/file-16.js'), false)
})

test('the cap also applies when the overflow arrives via extraFiles', () => {
  const extra = Array.from({ length: 30 }, (_, i) => `lib/f${i}.js`)
  const brief = buildRolloverBrief({ last_touched_files: ['src/a.js'] }, { extraFiles: extra })
  assert.equal(brief.cumulativeTouchedFiles.length, 15)
  assert.deepEqual(brief.cumulativeTouchedFiles.slice(0, 2), ['src/a.js', 'lib/f0.js'])
})

test('non-string and blank entries are dropped', () => {
  const brief = buildRolloverBrief({
    last_touched_files: ['src/a.js', null, 42, { path: 'x' }, '   ', '', 'src/b.js'],
  })
  assert.deepEqual(brief.cumulativeTouchedFiles, ['src/a.js', 'src/b.js'])
})

test('a non-array file list reads as empty', () => {
  assert.deepEqual(buildRolloverBrief({ last_touched_files: 'src/a.js' }).cumulativeTouchedFiles, [])
  assert.deepEqual(buildRolloverBrief({ last_touched_files: 7 }).cumulativeTouchedFiles, [])
})

test('hostile values that make bare String()/Number() throw are absorbed', () => {
  // `String({toString: null})` and `Number(Symbol())` both throw; a hand-edited
  // or foreign record must not be able to break a delegation through them.
  const throwing = { toString: null, valueOf: null }
  assert.doesNotThrow(() => buildRolloverBrief({ workspace_dir: throwing, last_touched_files: [throwing] }))
  assert.doesNotThrow(() => buildRolloverBrief({ turn_count: Symbol('turns') }))
  assert.doesNotThrow(() => renderRolloverPrompt({ previousTurnCount: Symbol('turns') }))
  assert.doesNotThrow(() => isLongSession({ turn_count: 8 }, { longSessionTurns: Symbol('limit') }))
  assert.equal(buildRolloverBrief({ turn_count: Symbol('turns') }).previousTurnCount, 0)
  assert.equal(buildRolloverBrief({ workspace_dir: throwing, last_touched_files: [throwing] }).cumulativeTouchedFiles.length, 0)
  // An invalid watermark still degrades to the default rather than throwing.
  assert.equal(isLongSession({ turn_count: 8 }, { longSessionTurns: Symbol('limit') }), true)
})

test('camelCase record fields are accepted (UI projection shape)', () => {
  const brief = buildRolloverBrief({
    workspaceDir: 'F:/work/app',
    lastTouchedFiles: ['F:/work/app/src/a.js'],
    lastTaskHead: '把登录接口的 500 修掉',
    turnCount: 4,
  })
  assert.deepEqual(brief, {
    cumulativeTouchedFiles: ['src/a.js'],
    lastPlanHead: '把登录接口的 500 修掉',
    previousTurnCount: 4,
  })
})

// ---------------------------------------------------------------------------
// buildRolloverBrief — relativisation
// ---------------------------------------------------------------------------

test('windows paths become workspace-relative with forward slashes', () => {
  const brief = buildRolloverBrief({
    workspace_dir: WORKSPACE,
    last_touched_files: [
      'F:\\work\\app\\src\\nested\\deep.js',
      'F:\\work\\app\\index.js',
      'F:/work/app/src/mixed.js',
    ],
  })
  assert.deepEqual(brief.cumulativeTouchedFiles, ['src/nested/deep.js', 'index.js', 'src/mixed.js'])
  for (const path of brief.cumulativeTouchedFiles) {
    assert.equal(path.includes('\\'), false)
    assert.equal(path.startsWith('F:'), false)
  }
})

test('a trailing separator on the workspace does not defeat the strip', () => {
  const brief = buildRolloverBrief({
    workspace_dir: 'F:\\work\\app\\',
    last_touched_files: ['F:\\work\\app\\src\\a.js'],
  })
  assert.deepEqual(brief.cumulativeTouchedFiles, ['src/a.js'])
})

test('workspace prefix matching is case-insensitive, as Windows paths are', () => {
  const brief = buildRolloverBrief({
    workspace_dir: 'F:\\work\\app',
    last_touched_files: ['f:\\work\\APP\\src\\a.js'],
  })
  assert.deepEqual(brief.cumulativeTouchedFiles, ['src/a.js'])
})

test('a sibling directory sharing the prefix is not stripped', () => {
  const brief = buildRolloverBrief({
    workspace_dir: 'F:\\work\\app',
    last_touched_files: ['F:\\work\\app2\\src\\a.js'],
  })
  assert.deepEqual(brief.cumulativeTouchedFiles, ['F:/work/app2/src/a.js'])
})

test('out-of-workspace paths survive in slash form', () => {
  const brief = buildRolloverBrief({
    workspace_dir: WORKSPACE,
    last_touched_files: ['C:\\Users\\kiuhg\\AppData\\Roaming\\x\\config.json'],
  })
  assert.deepEqual(brief.cumulativeTouchedFiles, ['C:/Users/kiuhg/AppData/Roaming/x/config.json'])
})

test('without workspace_dir, paths are only slash-normalised', () => {
  const brief = buildRolloverBrief({ last_touched_files: ['src\\a.js', '../shared/b.js'] })
  assert.deepEqual(brief.cumulativeTouchedFiles, ['src/a.js', '../shared/b.js'])
})

// ---------------------------------------------------------------------------
// buildRolloverBrief — plan head and turn count
// ---------------------------------------------------------------------------

test('planText is preferred and hard-capped at 600 characters', () => {
  const long = 'P'.repeat(900)
  const brief = buildRolloverBrief({}, { planText: long })
  assert.equal(brief.lastPlanHead.length, 600)
  assert.equal(brief.lastPlanHead, 'P'.repeat(600))
  // A hard slice: no ellipsis is appended past the documented bound.
  assert.equal(brief.lastPlanHead.endsWith('…'), false)
  assert.equal(brief.lastPlanHead.endsWith('...'), false)
})

test('a short planText is kept verbatim (trimmed)', () => {
  const brief = buildRolloverBrief({}, { planText: '  把登录流程补齐回归测试  ' })
  assert.equal(brief.lastPlanHead, '把登录流程补齐回归测试')
})

test('empty / non-string planText falls back to last_task_head', () => {
  const record = { last_task_head: '修复支付回调超时' }
  for (const planText of [undefined, null, '', '   ', 42, {}, []]) {
    assert.equal(buildRolloverBrief(record, { planText }).lastPlanHead, '修复支付回调超时')
  }
})

test('the last_task_head fallback is capped at 600 characters too', () => {
  const brief = buildRolloverBrief({ last_task_head: 'T'.repeat(800) })
  assert.equal(brief.lastPlanHead.length, 600)
})

test('neither source present yields the empty string, not undefined', () => {
  const brief = buildRolloverBrief({ last_task_head: '   ' }, { planText: '' })
  assert.equal(brief.lastPlanHead, '')
  assert.equal(typeof brief.lastPlanHead, 'string')
})

test('previousTurnCount truncates, clamps at zero, and defaults to 0', () => {
  assert.equal(buildRolloverBrief({ turn_count: 8.9 }).previousTurnCount, 8)
  assert.equal(buildRolloverBrief({ turn_count: -3 }).previousTurnCount, 0)
  assert.equal(buildRolloverBrief({ turn_count: 5 }).previousTurnCount, 5)
  assert.equal(buildRolloverBrief({ turn_count: '5' }).previousTurnCount, 5)
  for (const turnCount of [undefined, null, 'abc', NaN, Infinity, {}, []]) {
    assert.equal(buildRolloverBrief({ turn_count: turnCount }).previousTurnCount, 0)
  }
})

// ---------------------------------------------------------------------------
// isLongSession
// ---------------------------------------------------------------------------

test('isLongSession is true from the 8-turn default watermark on', () => {
  assert.equal(isLongSession({ turn_count: 7 }), false)
  assert.equal(isLongSession({ turn_count: 8 }), true)
  assert.equal(isLongSession({ turn_count: 9 }), true)
})

test('isLongSession is false for a missing record or an unreadable count', () => {
  assert.equal(isLongSession(undefined), false)
  assert.equal(isLongSession(null), false)
  assert.equal(isLongSession({}), false)
  assert.equal(isLongSession({ turn_count: 'abc' }), false)
  assert.equal(isLongSession({ turn_count: -9 }), false)
})

test('isLongSession honours a custom watermark', () => {
  assert.equal(isLongSession({ turn_count: 2 }, { longSessionTurns: 3 }), false)
  assert.equal(isLongSession({ turn_count: 3 }, { longSessionTurns: 3 }), true)
  assert.equal(isLongSession({ turn_count: 5 }, { longSessionTurns: '5' }), true)
})

test('an invalid watermark degrades to the default instead of throwing', () => {
  for (const longSessionTurns of [undefined, null, 0, -1, NaN, Infinity, 'abc', {}, []]) {
    assert.equal(isLongSession({ turn_count: 7 }, { longSessionTurns }), false)
    assert.equal(isLongSession({ turn_count: 8 }, { longSessionTurns }), true)
  }
  // A non-object options bag must not throw on destructuring.
  assert.equal(isLongSession({ turn_count: 8 }, null), true)
  assert.equal(isLongSession({ turn_count: 8 }, 'nope'), true)
})

// ---------------------------------------------------------------------------
// renderRolloverPrompt — undefined branch
// ---------------------------------------------------------------------------

test('renderRolloverPrompt returns undefined when there is nothing to carry', () => {
  assert.equal(renderRolloverPrompt(undefined), undefined)
  assert.equal(renderRolloverPrompt(null), undefined)
  assert.equal(renderRolloverPrompt({}), undefined)
  assert.equal(
    renderRolloverPrompt({ cumulativeTouchedFiles: [], lastPlanHead: '', previousTurnCount: 0 }),
    undefined,
  )
  assert.equal(
    renderRolloverPrompt({ cumulative_touched_files: [], last_plan_head: '', previous_turn_count: 0 }),
    undefined,
  )
})

test('a zero-turn brief still renders when it carries files or a summary', () => {
  assert.equal(typeof renderRolloverPrompt({ cumulativeTouchedFiles: ['src/a.js'] }), 'string')
  assert.equal(typeof renderRolloverPrompt({ lastPlanHead: '只跑了一轮就换会话' }), 'string')
})

test('renderRolloverPrompt tolerates garbage briefs without throwing', () => {
  for (const brief of [[], 'x', 7, true, { cumulativeTouchedFiles: 'src/a.js' }]) {
    assert.doesNotThrow(() => renderRolloverPrompt(brief))
  }
  assert.equal(renderRolloverPrompt({ cumulativeTouchedFiles: 'src/a.js' }), undefined)
})

// ---------------------------------------------------------------------------
// renderRolloverPrompt — content
// ---------------------------------------------------------------------------

test('the banner states the rollover, lists the files and orders a cold-start-free start', () => {
  const brief = buildRolloverBrief(
    {
      workspace_dir: WORKSPACE,
      turn_count: 8,
      last_touched_files: ['F:\\work\\app\\src\\auth.js', 'src\\login.js'],
    },
    { extraFiles: ['F:\\work\\app\\test\\auth.test.js'], planText: '为登录流程补齐回归测试' },
  )
  const prompt = renderRolloverPrompt(brief)
  assert.equal(typeof prompt, 'string')

  // 1. says, explicitly, that this is a new session carrying memory over.
  assert.match(prompt, /这是一个带记忆结转的新会话/)
  assert.match(prompt, /\[Rollover Brief\]/)
  assert.match(prompt, /\[End of Rollover Brief\]/)
  // 2. the cumulative file list, relative and slash-separated.
  assert.match(prompt, /累计修改 3 个文件/)
  assert.match(prompt, /^ {3}1\. src\/auth\.js$/m)
  assert.match(prompt, /^ {3}2\. src\/login\.js$/m)
  assert.match(prompt, /^ {3}3\. test\/auth\.test\.js$/m)
  // 3. the progress digest.
  assert.match(prompt, /progress digest {2}: 为登录流程补齐回归测试/)
  // 4. the hard instruction that saves the cold-start cost.
  assert.match(prompt, /直接从上面这些相关文件切入/)
  assert.match(prompt, /不要重新全盘扫描项目/)
  // The turn count of the previous thread is reported too.
  assert.match(prompt, /前一段会话已完成 8 轮/)
  assert.equal(prompt.includes('\\'), false)
})

test('the exact banner text is stable', () => {
  const brief = buildRolloverBrief(
    {
      workspace_dir: 'F:\\work\\app',
      turn_count: 8,
      last_touched_files: ['F:\\work\\app\\src\\auth.js', 'src\\login.js'],
    },
    { extraFiles: ['F:\\work\\app\\test\\auth.test.js'], planText: '为登录流程补齐回归测试' },
  )
  assert.equal(
    renderRolloverPrompt(brief),
    [
      '[Rollover Brief] 这是一个带记忆结转的新会话：前一段会话已结束，下面是从它结转过来的全部记忆，请当作「已经做过功课」的续作，而不是一个陌生项目。',
      'turn count       : 前一段会话已完成 8 轮（本会话从第 1 轮重新计数）',
      'cumulative files : 累计修改 3 个文件，按首次触碰顺序（最多 15 条）',
      '   1. src/auth.js',
      '   2. src/login.js',
      '   3. test/auth.test.js',
      'progress digest  : 为登录流程补齐回归测试',
      'hard instruction : 直接从上面这些相关文件切入——先读它们再动手，不要重新全盘扫描项目，也不要重新探索目录结构或重跑一遍环境检查；整盘冷启动会白白烧掉大量配额。',
      '[End of Rollover Brief]',
    ].join('\n'),
  )
})

test('the banner renders from a persisted snake_case brief', () => {
  const prompt = renderRolloverPrompt({
    cumulative_touched_files: ['src/a.js'],
    last_plan_head: '把历史锁定横幅接到 UI',
    previous_turn_count: 12,
  })
  assert.match(prompt, /src\/a\.js/)
  assert.match(prompt, /把历史锁定横幅接到 UI/)
  assert.match(prompt, /前一段会话已完成 12 轮/)
})

test('the banner lists at most 15 files even if the brief was hand-built longer', () => {
  const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.js`)
  const prompt = renderRolloverPrompt({ cumulativeTouchedFiles: many, previousTurnCount: 9 })
  assert.match(prompt, /累计修改 15 个文件/)
  assert.match(prompt, /src\/f14\.js/)
  assert.equal(prompt.includes('src/f15.js'), false)
  assert.equal(prompt.includes('src/f24.js'), false)
})

test('the banner omits sections it has no data for', () => {
  const onlyFiles = renderRolloverPrompt({ cumulativeTouchedFiles: ['src/a.js'] })
  assert.equal(onlyFiles.includes('turn count'), false)
  assert.equal(onlyFiles.includes('progress digest'), false)
  assert.match(onlyFiles, /hard instruction/)

  const onlyTurns = renderRolloverPrompt({ previousTurnCount: 3 })
  assert.equal(onlyTurns.includes('cumulative files'), false)
  assert.match(onlyTurns, /前一段会话已完成 3 轮/)
})

test('a chained rollover keeps earlier generations through extraFiles', () => {
  const previous = buildRolloverBrief({ last_touched_files: ['src/a.js', 'src/b.js'] })
  const next = buildRolloverBrief(
    { last_touched_files: ['src/c.js'] },
    { extraFiles: previous.cumulativeTouchedFiles },
  )
  assert.deepEqual(next.cumulativeTouchedFiles, ['src/c.js', 'src/a.js', 'src/b.js'])
})
