/**
 * Static sanity sweep over the shipped modules.
 *
 * WHY THIS EXISTS
 * ---------------
 * A pure-ESM package with no bundler has no build step to catch a dangling
 * import, and a dead import in `index.js` is invisible until the module fails to
 * link on someone's machine. `node --test` links the file but cannot tell you an
 * imported name is never used — so the check is spelled out here instead.
 *
 * It also guards the packaging contract: every path in `package.json#files` must
 * actually exist, because a missing entry is only discovered at publish time.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** Every named import in a module, per specifier. Comments are stripped first. */
function namedImports(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const names = []
  for (const match of stripped.matchAll(/import\s*\{([\s\S]+?)\}\s*from/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name !== '') names.push(name)
    }
  }
  return names
}

/** Count whole-word occurrences of `name`, excluding the import line itself. */
function usages(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, 'g')
  return (source.match(pattern) ?? []).length
}

describe('package hygiene', () => {
  it('lib/index.js imports nothing it does not use', async () => {
    const source = await readFile(join(PKG_DIR, 'lib/index.js'), 'utf8')
    const unused = namedImports(source).filter((name) => usages(source, name) <= 1)
    assert.deepEqual(unused, [], `dead imports in lib/index.js: ${unused.join(', ')}`)
  })

  it('every non-glob path in package.json#files exists', async () => {
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8'))
    const missing = pkg.files.filter((entry) => !entry.includes('*') && !existsSync(join(PKG_DIR, entry)))
    assert.deepEqual(missing, [], `declared but absent: ${missing.join(', ')}`)
  })

  it('every module the plugin ships at runtime is packaged', async () => {
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8'))
    const source = await readFile(join(PKG_DIR, 'lib/index.js'), 'utf8')
    // Only local specifiers matter; a deep import of a peer dependency is not ours
    // to package.
    const local = [...source.matchAll(/from\s+'(\.\/[^']+)'/g)].map((m) => m[1])
    const unpackaged = local
      .map((spec) => join('lib', spec.replace('./', '')))
      .filter((rel) => !pkg.files.includes(rel.replace(/\\/g, '/')))
    assert.deepEqual(unpackaged, [], `imported but not packaged: ${unpackaged.join(', ')}`)
  })

  it('the package version matches the release this tree documents', async () => {
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8'))
    assert.equal(pkg.version, '0.8.0')
  })
})
