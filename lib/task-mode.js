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
 * The personas therefore differ in exactly two places:
 *
 *   mode       preamble                                    after turn 1
 *   surgical   the existing minimal-diff prefix             nothing (fast return)
 *   creative   the same prefix + visual-density block       the supervisor gate (pass 1 only)
 *   document   office-automation + structure-summary block  the structure gate (EVERY turn)
 *
 * Selection is automatic because the alternative is a config edit. Users switch
 * between "fix this bug" and "build me a 3D scene" inside one conversation; a
 * setting that has to be edited between those two asks is a setting nobody
 * edits, so the visual task silently comes back skeletal again.
 *
 * WHY THE CREATIVE GATE IS TURN-1 ONLY
 * ------------------------------------
 * {@link creativeReviewGate} nudges the supervisor to re-dispatch a second pass.
 * If it fired on every turn the model would keep expanding the scene forever,
 * burning quota long after the result was good enough. It is a one-shot review
 * prompt, not a loop condition.
 *
 * v0.8.0 / REQ-05: THE THIRD MODE — `document`
 * --------------------------------------------
 * Office documents (`.xlsx` / `.pptx` / `.docx` / `.pdf` / `.csv`) are a third
 * failure class, neither engineering nor visual. The engineering persona's
 * "smallest diff" instinct tempts an executor to poke at the file directly, and
 * a zip-of-XML or PDF edited by hand is not a small diff — it is a corrupt file
 * that only fails when the user opens it. So `document` mode is a separate
 * persona: every write goes through a library script (openpyxl / python-pptx /
 * python-docx / pypdf / reportlab / the csv module), styling is explicit rather
 * than library-default, and the turn ends with a printed structure summary.
 *
 * WHY `document` IS MATCHED BEFORE `creative`
 * -------------------------------------------
 * The two keyword sets genuinely overlap: a spreadsheet task routinely mentions
 * "图表动画" (chart animation) or a slide deck mentions "视觉设计", and the
 * creative list is deliberately generous. Matching creative first would hand a
 * workbook job to the 3D persona, which then tries to build a WebGL dashboard
 * instead of filling cells. Document mode is also the more specific, more
 * constraining persona, so it wins the tie: extensions and office-document
 * nouns are much narrower evidence than "animation".
 *
 * WHY STICKINESS CANNOT OUTRANK A REGEX HIT
 * -----------------------------------------
 * Session stickiness exists because a long `session_id` drifts: after three
 * rounds of "现在把第 3 页改成…", the increment no longer contains the word
 * "excel" and the task would silently degrade to surgical. But the moment the
 * increment DOES hit a marker — "再帮我做个季度汇报.pptx" inside a surgical
 * session, or "现在来搭个 3D 便利店场景" inside a document session — the user is
 * *changing task class*, and an old sticky mode that dragged them back would run
 * the work under the wrong persona. Precedence is therefore:
 * explicit `task_mode` > mode regex > sticky > {@link DEFAULT_TASK_MODE}.
 *
 * The asymmetry is deliberate: there is no positive "surgical" marker (surgical
 * is the *absence* of markers), so a bare "修一下 index.js" in a document session
 * still inherits document. Leaving a sticky mode is opt-in — pass `task_mode`
 * explicitly, which outranks everything.
 *
 * WHY THE DOCUMENT GATE FIRES ON EVERY TURN (the mirror image of the creative one)
 * -------------------------------------------------------------------------------
 * The creative gate is about *effort*: once pass 2 is done, more nudging only
 * burns quota. The document gate is about *evidence*, and the evidence is
 * missing on every single turn: `git diff` of a `.xlsx`/`.pptx`/`.pdf` is empty
 * whether the deck has 12 slides or 3, and a `.csv` diff shows values but never
 * the layout. Unlike a visual scene, where the supervisor can at least open the
 * page, the acceptance blind spot never closes — so the only usable signal is
 * "did the executor print a structure summary?", and that question has to be
 * asked again after every turn. Hence: every turn, not turn 1 only.
 *
 * @module antigravity-executor/lib/task-mode
 */

/** The three personas. Order is meaningful only for error messages. */
export const TASK_MODES = ['surgical', 'creative', 'document']
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
 * Markers that a task is office-document automation rather than engineering.
 *
 * Two families:
 *   1. file extensions (`.xlsx` / `.pptx` / `.docx` / `.pdf` / `.csv`) — the
 *      narrowest, strongest evidence, and the one REQ-05 explicitly names;
 *   2. nouns of the office world, English and Chinese, plus the libraries the
 *      document persona mandates (mentioning `openpyxl` is a near-certain
 *      signal that the task is about a workbook, not about a web app).
 *
 * English and library markers are word-bounded so `word` does not fire inside
 * `password` and `ppt` does not fire inside an identifier. Bare `文档` is
 * deliberately NOT a marker: "更新 README 文档" is engineering, so only the
 * office compounds (`文档自动化` / `文档生成` / `文档排版` / `办公文档`) count.
 *
 * Like the creative list this one is generous — the persona it selects is
 * stricter, so a false positive costs style guidance, never a broken file.
 *
 * @remarks Matching order matters: see {@link resolveTaskMode} — this regex is
 *   tested BEFORE {@link CREATIVE_TASK_RE}.
 */
export const DOCUMENT_TASK_RE =
  /\.(?:xlsx|pptx|docx|pdf|csv)\b|\b(?:excel|ppt|pptx|docx|xlsx|pdf|csv|spreadsheet|workbook|worksheet|slides?|slideshow|powerpoint|openpyxl|xlsxwriter|python-docx|python-pptx|pdfplumber|pypdf|reportlab)\b|\bms[\s-]?word\b|\bmicrosoft\s+word\b|\bword\s*(?:doc(?:ument|x)?\b|文档|文件|报表|报告|方案|合同|模板|简历|通知|排版)|数据报表|办公文档|文档自动化|文档生成|文档排版|幻灯片|演示文稿|演示稿|投标文件|表格|报表/i

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
 * The document-mode persona, minus the closing structure-summary demand.
 *
 * Kept separate from {@link documentPreamble} only so the composition is
 * obvious: the persona says HOW to write the file, and the summary block says
 * HOW to prove it. Every rule here exists because the naive path corrupts a
 * file or ships an unstyled one:
 *
 *   - hand-written bytes            -> a zip/PDF the user cannot open;
 *   - library defaults              -> 8pt Calibri soup with no merged headers;
 *   - "the script exited 0"         -> success reported for a workbook that
 *                                      never got saved.
 */
const DOCUMENT_PERSONA = [
  '[DOCUMENT & OFFICE AUTOMATION MODE]',
  '- NEVER hand-write a binary document. Do not `echo` / `cat` / `printf` bytes ' +
    'into an `.xlsx` / `.pptx` / `.docx` / `.pdf`, do not paste raw XML or base64 ' +
    'into one, and never edit these files with `sed` / `awk` / `patch`. A single ' +
    'wrong byte silently corrupts the file and the user only discovers it when ' +
    'they open it.',
  '- Always drive the file through a library script: write the script to a file, ' +
    'run it, then re-open the result to verify it. Required libraries — ' +
    '`xlsx` -> python + `openpyxl`, `pptx` -> `python-pptx`, `docx` -> ' +
    '`python-docx`, `pdf` read -> `pypdf` / `pdfplumber`, `pdf` write -> ' +
    '`reportlab`, `csv` -> the stdlib `csv` module. If an import fails, install ' +
    'the package with `pip` and retry; falling back to hand-editing is forbidden.',
  '- Apply a style book instead of library defaults: one title size (18-20pt ' +
    'bold) and one body size (10-11pt), a single accent colour plus greys, ' +
    'consistent cell/slide margins, frozen header rows, and a table style with a ' +
    'bold filled header row, thin borders, explicit column widths and wrapped ' +
    'text. Number formats must be stated (currency, percent, thousands ' +
    'separator), never raw floats.',
  '- Verify by RE-OPENING the saved file with the same library and printing the ' +
    'values you expect to find (sheet names, row/column counts, slide titles). ' +
    '"The script exited 0" is not verification, and `git diff` is not either — ' +
    'these formats are opaque to it.',
  '- Keep every scratch/temp file out of the workspace root and delete it before ' +
    'you finish. The only files left behind are the real deliverables.',
].join('\n')

/**
 * The end-of-turn demand that replaces `git diff` for document work.
 *
 * `git diff` on a `.xlsx` prints nothing useful even for a perfect file, so the
 * structure summary IS the review artifact: the supervisor reads sheet names,
 * rows x columns, slide titles and heading levels instead of a patch. Exported
 * separately because the report/settlement code may want to inject it even when
 * the preamble came from somewhere else (e.g. a retried turn).
 *
 * @returns {string} the verbatim prompt block
 */
export function documentStructurePrompt() {
  return [
    '[DOCUMENT STRUCTURE SUMMARY — REQUIRED AT THE END OF EVERY TURN]',
    '- `git diff` shows NOTHING for a spreadsheet, deck, PDF or CSV, so "empty ' +
      'diff, no errors" is not evidence that the document is correct. Close that ' +
      'blind spot by printing a plain-text structure summary in your FINAL REPLY ' +
      '(not only to stdout), inside a `[DOCUMENT STRUCTURE SUMMARY]` block:',
    '  - xlsx / csv : every sheet name, rows x columns, the column headers, and ' +
      'which sheet holds the totals;',
    '  - pptx       : slide count and each slide title, in order;',
    '  - docx       : heading outline with levels, paragraph count, table count;',
    '  - pdf        : page count, page size, and the extracted text of page 1;',
    '  - every entry: absolute file path and byte size.',
    '- Keep the block under the configured `documentMaxSummaryChars` limit (6000 ' +
      'characters by default). Summarise; do not dump the whole document.',
  ].join('\n')
}

/**
 * Alias of {@link documentStructurePrompt}, which is the canonical name
 * (`index.js` imports it).
 *
 * Both spellings exist because the block was written up twice in parallel during
 * the v0.8.0 split; keeping the alias means neither call site has to change.
 *
 * @returns {string} same block as {@link documentStructurePrompt}
 */
export function documentSummaryPrompt() {
  return documentStructurePrompt()
}

/**
 * The persona block appended to the executor prompt for document mode.
 *
 * Product requirement, same as {@link creativePreamble}: the wording is what
 * constrains the executor, so editing it is a product change, not a refactor.
 * It already contains {@link documentStructurePrompt}, so a caller that injects
 * this one block has the full contract — injecting both would duplicate it.
 *
 * @returns {string} the verbatim preamble block (persona + summary demand)
 */
export function documentPreamble() {
  return `${DOCUMENT_PERSONA}\n\n${documentStructurePrompt()}`
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
 * The Supervisor review prompt shown after EVERY document turn.
 *
 * Deliberately not turn-1-only: see the module header. `git diff` is blind to
 * these formats on every turn, so the "did it print a structure summary?"
 * question has to be re-asked each time, and the supervisor must accept on the
 * summary + a re-open, never on "the script exited 0".
 */
const DOCUMENT_REVIEW_GATE = [
  '[Supervisor Document Gate — Structure Summary Required]',
  'This turn wrote or modified an office document. `git diff` cannot review it: ' +
    'an .xlsx / .pptx / .docx / .pdf / .csv is opaque binary (or, for csv, values ' +
    'without layout), so a broken deck and a perfect one produce the same empty ' +
    'diff.',
  '1. Did the executor print a `[DOCUMENT STRUCTURE SUMMARY]` block in its final ' +
    'reply — sheet names with rows x columns, slide count with titles, heading ' +
    'outline, page count, file size?',
  '2. If YES: check those numbers against the task (12 slides? 240 rows?) and ' +
    're-open the file before accepting.',
  '3. If NO: DO NOT finish on "the script exited 0" — immediately call ' +
    '`delegate_coding_task` again with the SAME `session_id` and ' +
    '`task_mode: "document"` and ask for the structure summary plus a re-open ' +
    'verification.',
].join('\n')

/**
 * Decide which persona a delegation runs under.
 *
 * v0.8.0 precedence (REQ-05):
 *
 *   1. an explicit `task_mode` from the tool call;
 *   2. a regular-expression hit on `task_spec` — {@link DOCUMENT_TASK_RE} first,
 *      then {@link CREATIVE_TASK_RE};
 *   3. the session's recorded mode (`sessionTaskMode` / `sticky` /
 *      `session.sticky`) — only when step 2 missed;
 *   4. {@link DEFAULT_TASK_MODE}.
 *
 * A caller-supplied `task_mode` that is not one of {@link TASK_MODES} is
 * *reported*, not fatal: a typo must never fail a delegation that would
 * otherwise run fine, so it degrades to steps 2-4 and says so in `note`.
 *
 * An unusable sticky value is ignored silently — it comes from a persisted
 * record, and a corrupt record must degrade to today's behaviour rather than
 * throwing inside a delegation.
 *
 * @param {object} [options]
 * @param {unknown} [options.task_mode] explicit mode from the tool call
 * @param {unknown} [options.task_spec] the natural-language task
 * @param {unknown} [options.sessionTaskMode] mode recorded on the first turn
 * @param {unknown} [options.sticky] alias of `sessionTaskMode`
 * @param {unknown} [options.session] session record; `session.sticky` is read
 * @returns {{mode: 'surgical'|'creative'|'document',
 *            source: 'call'|'auto'|'sticky'|'invalid',
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

  // A regex hit beats stickiness on purpose: the user changed task class.
  const detected = detectFromSpec(rawSpec)
  if (detected !== undefined) {
    if (!explicit) return { mode: detected, source: 'auto' }
    return {
      mode: detected,
      source: 'invalid',
      note: `未知的 task_mode "${safeLabel(normalised)}"，已按 task_spec 自动判定为 ${detected}。`,
    }
  }

  // No mode marker anywhere in this turn's increment: keep the session's mode.
  const inherited = inheritedMode(options)
  if (inherited !== undefined) {
    if (!explicit) return { mode: inherited, source: 'sticky' }
    return {
      mode: inherited,
      source: 'invalid',
      note:
        `未知的 task_mode "${safeLabel(normalised)}"，本轮 task_spec 未命中任何模式，` +
        `已继承会话首轮判定的 ${inherited}。`,
    }
  }

  if (!explicit) return { mode: DEFAULT_TASK_MODE, source: 'auto' }
  return {
    mode: DEFAULT_TASK_MODE,
    source: 'invalid',
    note: `未知的 task_mode "${safeLabel(normalised)}"，已按 task_spec 自动判定为 ${DEFAULT_TASK_MODE}。`,
  }
}

/**
 * The one-shot review gate for the supervisor (creative, pass-1 only).
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
 * The review gate for the supervisor (document, EVERY turn).
 *
 * `turnCount` is accepted and intentionally ignored — see the module header:
 * the creative gate is a one-shot effort nudge, this one is a per-turn evidence
 * check, because `git diff` never becomes informative for an office file.
 *
 * @param {object} [options]
 * @param {unknown} [options.mode] decision from {@link resolveTaskMode}
 * @param {unknown} [options.turnCount] accepted, deliberately not used
 * @param {unknown} [options.hasSummary] `true` when the turn's reply already
 *   contains a `[DOCUMENT STRUCTURE SUMMARY]` block, so there is nothing to nag
 * @returns {string|undefined} the gate text, or `undefined` when it must not be
 *   shown (any non-document mode, or a turn that already printed the summary)
 */
export function documentReviewGate(options = {}) {
  const { mode, hasSummary } = options ?? {}
  if (mode !== 'document') return undefined
  if (hasSummary === true) return undefined
  return DOCUMENT_REVIEW_GATE
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
  if (source === 'sticky') return `task_mode    : ${mode} (sticky, inherited from session)`
  if (source === 'invalid') return `task_mode    : ${mode} (auto, explicit value ignored)`
  return `task_mode    : ${mode} (auto-detected from task_spec)`
}

/**
 * Keyword scan. Returns `undefined` — not the default — when nothing matches, so
 * the caller can distinguish "no marker" from "marker says surgical" and let
 * session stickiness apply.
 *
 * Order is a product decision: `document` is the narrower, more constraining
 * persona and it is the one a spreadsheet task keeps accidentally resembling, so
 * it wins the overlap ("图表动画" inside an .xlsx task is a chart, not a scene).
 */
function detectFromSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return undefined
  if (DOCUMENT_TASK_RE.test(spec)) return 'document'
  return CREATIVE_TASK_RE.test(spec) ? 'creative' : undefined
}

/**
 * Read the sticky mode from whichever shape the caller used.
 *
 * Three spellings are accepted because two modules built this value in parallel
 * (`sessionTaskMode` for a plain field, `sticky` / `session.sticky` for a session
 * record). The first value that normalises into {@link TASK_MODES} wins; anything
 * else — `true`, `'auto'`, a number, a missing session — is silently ignored so a
 * corrupt/unreadable record degrades to v0.7.0 behaviour instead of throwing.
 */
function inheritedMode(options) {
  const candidates = [
    options?.sessionTaskMode,
    options?.sticky,
    options?.session?.sticky,
    options?.session?.taskMode,
  ]
  for (const candidate of candidates) {
    const normalised = typeof candidate === 'string' ? candidate.trim().toLowerCase() : undefined
    if (normalised !== undefined && TASK_MODES.includes(normalised)) return normalised
  }
  return undefined
}

/** `String()` that cannot throw on an exotic `task_mode` (Symbol, bad toString). */
function safeLabel(value) {
  try {
    return String(value).trim()
  } catch {
    return '?'
  }
}
