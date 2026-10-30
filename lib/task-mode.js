/**
 * Adaptive task mode: pick the executor's persona from the task, not from config.
 *
 * WHY THIS EXISTS (v0.6.0 / REQ-01)
 * ---------------------------------
 * The plugin injects a conservative "minimal diff" preamble into every
 * delegation. That persona is exactly right for engineering work: touching one
 * file is easier to review, and a sprawling rewrite is the most common way a
 * three-line bug fix turns into a regression. It is exactly wrong for 3D and
 * front-end visual work, where "the smallest change that works" produces what
 * REQ-01 reported: a skeletal "matchbox" scene — one floor plane, a shelf made
 * of a single colored box, no textures, no lighting, no props. The executor did
 * precisely what the preamble asked for.
 *
 * The two personas therefore differ in exactly two places:
 *
 *   mode       preamble                                after turn 1
 *   surgical   the existing minimal-diff prefix         nothing (fast return)
 *   creative   the same prefix + visual-density block   the supervisor gate
 *
 * Selection is automatic because the alternative is a config edit. Users switch
 * between "fix this bug" and "build me a 3D scene" inside one conversation; a
 * setting that has to be edited between those two asks is a setting nobody
 * edits, so the visual task silently comes back skeletal again.
 *
 * WHY THE GATE IS TURN-1 ONLY
 * ---------------------------
 * {@link creativeReviewGate} nudges the supervisor to re-dispatch a second pass.
 * If it fired on every turn the model would keep expanding the scene forever,
 * burning quota long after the result was good enough. It is a one-shot review
 * prompt, not a loop condition.
 *
 * @module antigravity-executor/lib/task-mode
 */

/** The two personas. Order is meaningful only for error messages. */
export const TASK_MODES = ['surgical', 'creative']
/** What an empty or unreadable `task_spec` resolves to: stay conservative. */
export const DEFAULT_TASK_MODE = 'surgical'

/**
 * Markers that a task is visual rather than engineering.
 *
 * English markers are word-bounded on purpose: `3d` and `game` must not fire on
 * `3ds` inside a filename like `3ds-max.md`, but must fire on `3D scene`. The
 * Chinese markers have no usable `\b` boundary (CJK characters are non-word in
 * JS regex), so they are matched bare outside the bounded group.
 *
 * The list is intentionally generous — a false positive costs one richer
 * preamble, while a false negative ships the matchbox scene again.
 */
export const CREATIVE_TASK_RE =
  /\b(three\.?js|webgl|canvas|3d|shader|pbr|unrealbloom|orbitcontrols|landing\s*page|ui\s*design|game|animation)\b|三维|3D场景|便利店|着色器|粒子|动画|小游戏|界面设计|视觉效果/i

/**
 * The persona block appended to the executor prompt for creative mode.
 *
 * The wording is a product requirement and is deliberately concrete: the
 * failure this prevents is an executor that reads "build a store" and emits
 * three boxes, so the block names the exact techniques (composite geometry,
 * InstancedMesh, CanvasTexture, layered lighting) that make a scene read as
 * intentional rather than placeholder.
 *
 * @returns {string} the verbatim preamble block
 */
export function creativePreamble() {
  return [
    '[CREATIVE & VISUAL DENSITY MODE]',
    '- Do NOT build a minimal MVP or use bare single-primitive placeholders ' +
      '(e.g. plain colored boxes as furniture, shelves, or buildings).',
    '- Maximize visual richness and code completeness: build composite multi-part ' +
      'geometries, use InstancedMesh for repeating props/products, generate ' +
      'procedural CanvasTextures for signage/labels/tiles, and configure layered ' +
      'lighting (ambient + directional/spot lights with shadows, emissive ' +
      'materials, and post-processing where applicable).',
    '- Prioritize visual polish, material realism, and interactive details over ' +
      'code brevity.',
  ].join('\n')
}

/**
 * The Supervisor review prompt shown after the first creative turn.
 *
 * Kept as a module constant so the exact wording (REQ-01 acceptance) cannot
 * drift between call sites and tests.
 */
const CREATIVE_REVIEW_GATE = [
  '[Supervisor Creative Gate — Pass 1 Completed]',
  'This is Pass 1 of a creative/visual task. Before accepting, inspect the code ' +
    'for visual density:',
  '1. Are objects built from composite geometries and procedural textures ' +
    '(CanvasTexture / PBR materials), or just bare placeholder primitives?',
  '2. Are interior props, lighting atmosphere, and interactive controls fully ' +
    'fleshed out?',
  'If the scene is skeletal or under-detailed, DO NOT finish — immediately call ' +
    '`delegate_coding_task` again with the SAME `session_id` and ' +
    '`task_mode: "creative"` to execute Pass 2 (detail & prop expansion).',
].join('\n')

/**
 * Decide which persona a delegation runs under.
 *
 * Precedence: an explicit `task_mode` from the tool call, then a keyword scan
 * of `task_spec`, then {@link DEFAULT_TASK_MODE}. A caller-supplied value that
 * is not one of {@link TASK_MODES} is *reported*, not fatal: a typo must never
 * fail a delegation that would otherwise run fine, so it degrades to the
 * auto-detected mode and says so in `note`.
 *
 * @param {object} [options]
 * @param {unknown} [options.task_mode] explicit mode from the tool call
 * @param {unknown} [options.task_spec] the natural-language task
 * @returns {{mode: 'surgical'|'creative',
 *            source: 'call'|'auto'|'invalid',
 *            note?: string}}
 */
export function resolveTaskMode(options = {}) {
  const { task_mode: rawMode, task_spec: rawSpec } = options ?? {}

  // Normalise before matching so "  CREATIVE " is the documented spelling of
  // "creative" rather than an unknown value.
  const normalised = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : rawMode
  // An empty string is how most callers spell "I did not pass this", so it is
  // treated as absent instead of as an invalid value.
  const explicit = typeof normalised === 'string' ? normalised.length > 0 : normalised != null

  if (explicit && TASK_MODES.includes(normalised)) return { mode: normalised, source: 'call' }

  const mode = detectFromSpec(rawSpec)
  if (!explicit) return { mode, source: 'auto' }
  return {
    mode,
    source: 'invalid',
    note: `未知的 task_mode "${safeLabel(normalised)}"，已按 task_spec 自动判定为 ${mode}。`,
  }
}

/**
 * The one-shot review gate for the supervisor.
 *
 * @param {object} [options]
 * @param {unknown} [options.mode] decision from {@link resolveTaskMode}
 * @param {unknown} [options.turnCount] turns already spent on this session
 * @returns {string|undefined} the gate text, or `undefined` when it must not
 *   be shown (any non-creative mode, and any turn other than the first)
 */
export function creativeReviewGate(options = {}) {
  const { mode, turnCount } = options ?? {}
  if (mode !== 'creative') return undefined
  // `Number(...)` rather than `===` because turn counts arrive from RPC payloads
  // that stringify numbers; only the literal first turn qualifies.
  if (Number(turnCount) !== 1) return undefined
  return CREATIVE_REVIEW_GATE
}

/**
 * Render the decision as one report line (`check_environment` / delegation
 * report). The `invalid` line deliberately says the explicit value was ignored,
 * so a typo is visible without a separate note lookup.
 *
 * @param {{mode?: string, source?: string, note?: string}} [decision]
 * @returns {string}
 */
export function renderTaskMode(decision) {
  const { mode: rawMode, source } = decision ?? {}
  const mode = TASK_MODES.includes(rawMode) ? rawMode : DEFAULT_TASK_MODE
  if (source === 'call') return `task_mode    : ${mode} (explicit)`
  if (source === 'invalid') return `task_mode    : ${mode} (auto, explicit value ignored)`
  return `task_mode    : ${mode} (auto-detected from task_spec)`
}

/** Keyword scan; anything that is not a non-empty string is a no-match. */
function detectFromSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return DEFAULT_TASK_MODE
  return CREATIVE_TASK_RE.test(spec) ? 'creative' : DEFAULT_TASK_MODE
}

/** `String()` that cannot throw on an exotic `task_mode` (Symbol, bad toString). */
function safeLabel(value) {
  try {
    return String(value).trim()
  } catch {
    return '?'
  }
}
