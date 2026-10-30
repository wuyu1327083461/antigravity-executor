/**
 * Guard the manifest's dsh peer ranges against exact-version pinning.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The plugin only borrows one API from the host: `defineTool`, imported from
 * `@deepseek-ai/dsh-tools`. That function is byte-identical across the
 * 0.2.1-rc and 0.2.2-alpha lines, so every dsh release in that window can run
 * this plugin. The manifest nevertheless pinned the peer to an exact
 * `0.2.1-rc.4` for five releases, which made the host skip the whole bundle:
 *
 *   Plugin antigravity-executor@0.6.0 is incompatible with dsh 0.2.2-alpha.2:
 *   requirements {"@deepseek-ai/dsh-tools":"0.2.1-rc.4"}
 *
 * A host that refuses to load a plugin is a much bigger failure than a host
 * that loads it against a slightly newer dependency, and the pin turned an
 * ordinary version bump into a hard outage. These tests fail if an exact pin
 * comes back, so the regression cannot silently return in a future release.
 *
 * The range checks below are a deliberately small SemVer subset rather than a
 * dependency: this package ships zero runtime dependencies on purpose (see
 * the rationale in config-schema.js), and adding `semver` just to test its own
 * manifest would undo that. Only the comparator forms the manifest is allowed
 * to use are implemented, and an unsupported form fails the test loudly.
 *
 * Run: node --test lib/manifest.test.js
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const manifest = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
)

// ---------------------------------------------------------------------------
// minimal SemVer comparison
// ---------------------------------------------------------------------------

/** Parse `1.2.3` / `1.2.3-rc.4` into comparable parts. Rejects anything else. */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  assert.ok(match, `not a semantic version: ${JSON.stringify(value)}`)
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare two prerelease identifier lists.
 * Numeric identifiers compare numerically and rank below alphanumeric ones; a
 * version without a prerelease outranks any prerelease of the same core.
 */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** Compare two semantic versions, returning -1, 0 or 1. */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index] - b.core[index]
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Expand a caret or tilde comparator into the plain comparator list it means,
 * so the evaluator only ever has to handle `<`, `<=`, `>` and `>=`.
 * `~a.b.c` allows patch-level movement, `^a.b.c` allows everything left of the
 * leftmost non-zero field; both are what npm's own resolution does.
 */
function expandRange(range) {
  assert.ok(!range.includes('||'), `union ranges are not implemented: ${JSON.stringify(range)}`)
  return range
    .trim()
    .split(/\s+/)
    .flatMap((comparator) => {
      const sugar = /^([~^])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator)
      if (sugar === null) return [comparator]
      const [, operator, version] = sugar
      const { core, prerelease } = parseVersion(version)
      const lower = `${prerelease.length === 0 ? '>=' : '>='}${version}`
      if (operator === '~') return [lower, `<${core[0]}.${core[1] + 1}.0-0`]
      if (core[0] !== 0) return [lower, `<${core[0] + 1}.0.0-0`]
      if (core[1] !== 0) return [lower, `<0.${core[1] + 1}.0-0`]
      return [lower, `<0.0.${core[2] + 1}-0`]
    })
}

/**
 * Test a version against a space-separated comparator list such as
 * `>=0.2.1-rc.4 <0.3.0`. Every comparator must hold (logical AND), which is
 * all the manifest needs.
 */
function satisfies(version, range) {
  for (const comparator of expandRange(range)) {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator)
    assert.ok(match, `unsupported comparator ${JSON.stringify(comparator)} in ${JSON.stringify(range)}`)
    const operator = match[1] ?? '='
    const order = compareVersions(version, match[2])
    const holds =
      operator === '>=' ? order >= 0
      : operator === '<=' ? order <= 0
      : operator === '>' ? order > 0
      : operator === '<' ? order < 0
      : order === 0
    if (!holds) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/** dsh releases that carry a compatible `defineTool`, oldest first. */
const SUPPORTED_DSH_TOOLS = ['0.2.1-rc.4', '0.2.2-alpha.2']

test('the dsh-tools peer range is a range, not an exact pin', () => {
  const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
  assert.equal(typeof range, 'string')
  // An exact pin here makes the host skip the whole bundle on the next dsh
  // release, which is the outage this file exists to prevent.
  assert.ok(
    /[<>=^~]|\|\|/.test(range),
    `"@deepseek-ai/dsh-tools" must be a range so newer dsh releases are not rejected; got ${JSON.stringify(range)}`,
  )
})

test('the dsh-tools peer range accepts every supported dsh release', () => {
  const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
  for (const version of SUPPORTED_DSH_TOOLS) {
    assert.ok(satisfies(version, range), `${JSON.stringify(range)} rejects dsh-tools ${version}`)
  }
})

test('the dsh-tools peer range still excludes the next major line', () => {
  const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
  // Widening is not the same as giving up on compatibility: a 0.3.0 host may
  // have changed the API, and silently loading against it is what the peer
  // range is supposed to stop.
  assert.ok(!satisfies('0.3.0', range), `${JSON.stringify(range)} must not claim 0.3.x compatibility`)
})

test('the cordis peer range accepts the version the 0.2.2 host ships', () => {
  // dsh 0.2.2-alpha.2 carries cordis 4.0.6-alpha.1; `~4.0.5` already allows it,
  // so this assertion documents why only the dsh-tools pin needed to move.
  assert.ok(satisfies('4.0.6-alpha.1', manifest.peerDependencies['@deepseek-ai/cordis']))
})
