/**
 * Cross-platform shell preambles and syntax hints (REQ-09).
 *
 * WHY THIS IS A PURE MODULE
 * -------------------------
 * The preamble is injected into the executor's prompt, so it is user-visible
 * text that must be correct on both platforms. Testing that text against the
 * *real* `process.platform` is impossible on a single host, so every rule lives
 * in a `buildX(kind, ...)` function that takes the platform as an argument and
 * the exported `shellPreamble` / `shellNotes` / `workspaceSwitchHint` are thin
 * wrappers bound to the live `process.platform`.
 *
 * @module antigravity-executor/lib/platform
 */

/** The two shell dialects this plugin speaks. */
export const PLATFORMS = Object.freeze(['windows', 'posix'])

/** Map a Node `process.platform` value onto one of {@link PLATFORMS}. */
export function detectPlatform(plat = process.platform) {
  return plat === 'win32' ? 'windows' : 'posix'
}

/** The platform this process is actually running on. */
export const platform = detectPlatform(process.platform)

/**
 * Quote a path for PowerShell. `-LiteralPath` takes the string verbatim, so the
 * only thing that needs escaping is the single quote itself, which PowerShell
 * doubles inside a single-quoted string.
 */
function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Quote a path for a POSIX shell: close the quote, emit an escaped quote, reopen. */
function quotePosix(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * The command prefix that puts the executor inside the workspace.
 *
 * Windows uses `Set-Location -LiteralPath` and a `;` separator because the
 * executor's `run_command` tool is PowerShell, where `&&` is only valid from
 * PowerShell 7 onwards. POSIX uses `cd` and `&&` so a failed `cd` aborts the
 * rest of the line instead of running in the wrong directory.
 *
 * @param {'windows'|'posix'} kind
 * @param {string} workspace absolute directory
 * @returns {string} preamble ending with the platform's statement separator,
 *   or `''` when no workspace is given
 */
export function buildPreamble(kind, workspace) {
  const ws = String(workspace ?? '').trim()
  if (ws === '') return ''
  return kind === 'windows'
    ? `Set-Location -LiteralPath ${quotePowerShell(ws)}; `
    : `cd ${quotePosix(ws)} && `
}

/**
 * Shell syntax hints for the executor prompt.
 * @param {'windows'|'posix'} kind
 * @returns {string[]}
 */
export function buildNotes(kind) {
  if (kind === 'windows') {
    return [
      '本执行器运行在 Windows PowerShell：同一行串联命令用 `;`，不要用 `&&`。',
      '读文件用 `Get-Content`，不要用 `cat`；列目录用 `Get-ChildItem`，不要用 `ls`。',
      '环境变量用 `$env:NAME = "value"`，不要用 `export`。',
      '路径一律用绝对路径并用单引号包裹；`Set-Location -LiteralPath` 不会解释通配符。',
    ]
  }
  return [
    '本执行器运行在 POSIX shell：串联命令用 `&&`，`cat` / `ls` / `export` 均可直接使用。',
    '路径含空格或特殊字符时用单引号包裹。',
    '需要中断后续命令时用 `set -e` 或 `&&`，不要依赖 `;`。',
  ]
}

/**
 * A one-line hint telling the user/model how to switch directories mid-command.
 * @param {'windows'|'posix'} kind
 * @param {string} workspace
 */
export function buildSwitchHint(kind, workspace) {
  const ws = String(workspace ?? '').trim()
  if (ws === '') {
    return kind === 'windows'
      ? '工作目录未指定：请在命令开头用 `Set-Location -LiteralPath \'<工作区>\'` 切换。'
      : '工作目录未指定：请在命令开头用 `cd \'<工作区>\' && ...` 切换。'
  }
  return kind === 'windows'
    ? `切换工作目录：Set-Location -LiteralPath ${quotePowerShell(ws)}（同一行内用 \`;\` 串联后续命令）`
    : `切换工作目录：cd ${quotePosix(ws)} && ...`
}

// ---------------------------------------------------------------------------
// wrappers bound to the live platform (the only exports the rest of the plugin
// should normally need)
// ---------------------------------------------------------------------------

/** @returns {string} */
export function shellPreamble(workspace) {
  return buildPreamble(platform, workspace)
}

/** @returns {string[]} */
export function shellNotes() {
  return buildNotes(platform)
}

/** @returns {string} */
export function workspaceSwitchHint(workspace) {
  return buildSwitchHint(platform, workspace)
}
