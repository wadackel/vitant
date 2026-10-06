// Reuse of an earlier run's results. A test file's results carry over only if
// nothing it loaded has changed: every module it imported, its snapshot file,
// and everything that shapes the run as a whole (tool and Vitest versions,
// lock files, config, limits). What a test reads from disk in other ways is
// not tracked, which is why this is opt-in.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Generated } from './mutate/generate.ts'

/** Bumped whenever cached data would be read differently. */
const FORMAT = 3

export interface CachedTest {
  name: string
  baseline: 'pass' | 'fail' | 'skip'
  baselineMs: number
  baselineLoops: number
  /** The test does not pass when re-run in place; a fresh worker judges its mutants. */
  nonRepeatable: boolean
  /** Sites reached, each named by the key of its first mutant. */
  sites: string[]
  covered: string[]
  cleanup: string[]
  killed: string[]
  timedOut: string[]
  survived: string[]
}

export interface CachedFile {
  /** Content hash of everything the test file loaded, by path relative to the root. */
  deps: Record<string, string>
  staticSites: string[]
  /** Sites reached once the file had loaded, outside the tests that try mutants. */
  hookSites: string[]
  /** Mutants that would have changed a value while the file loaded. */
  staticMutants: string[]
  /** How a run of the whole file with the mutant always on ended. */
  whole: Record<string, 'failed' | 'timeout' | 'passed'>
  tests: Record<string, CachedTest>
}

export interface Cache {
  fingerprint: string
  /** Per source file, the mutants the cached tests were run against. */
  mutants: Record<string, string[]>
  files: Record<string, CachedFile>
  /**
   * Per mutant, by `hintKeys`, the tests that detected it, as
   * `<test file>\n<test name>`. Unlike the results above this only decides
   * which test tries a mutant first, so it is used even when nothing else in
   * the cache still holds.
   */
  killers?: Record<string, string[]>
}

export function cachePath(root: string): string {
  return path.join(root, 'node_modules/.vitant/cache.json')
}

const hashes = new Map<string, string>()

/** Content hash of a file, or a marker when it does not exist. */
export function hashFile(file: string): string {
  let hash = hashes.get(file)
  if (hash === undefined) {
    hash = fs.existsSync(file)
      ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
      : 'missing'
    hashes.set(file, hash)
  }
  return hash
}

/** Everything outside the test files' own imports that a verdict depends on. */
export function fingerprint(root: string, vitestVersion: string, limits: unknown): string {
  const shared = fs
    .readdirSync(root)
    .filter((name) =>
      /^(vitest|vite)\.(config|workspace)\.|^(package\.json|yarn\.lock|pnpm-lock\.yaml|package-lock\.json|bun\.lockb?)$/.test(name),
    )
    .sort()
    .map((name) => `${name}:${hashFile(path.join(root, name))}`)
  return JSON.stringify([FORMAT, process.versions.node.split('.')[0], vitestVersion, limits, shared])
}

export function mutantKeys(generated: Generated, root: string): string[] {
  return generated.mutants.map(
    (mutant) =>
      `${path.relative(root, mutant.file)}|${mutant.start}|${mutant.end}|${mutant.mutator}|${mutant.replacement}`,
  )
}

/**
 * Keys that survive edits elsewhere in the file: what the mutant replaces
 * with what, and the text of the line it starts on.
 */
export function hintKeys(generated: Generated, root: string): string[] {
  const lines = new Map<string, string[]>()
  return generated.mutants.map((mutant) => {
    let source = lines.get(mutant.file)
    if (!source) lines.set(mutant.file, (source = fs.readFileSync(mutant.file, 'utf8').split('\n')))
    const line = source[mutant.loc.start.line - 1]?.trim() ?? ''
    return `${path.relative(root, mutant.file)}|${mutant.mutator}|${mutant.replacement}|${line}`
  })
}

export function testKey(root: string, file: string, name: string): string {
  return `${path.relative(root, file)}\n${name}`
}

/** The killers a previous run recorded, whatever else has changed since. */
export function loadKillers(root: string): Record<string, string[]> {
  try {
    return (JSON.parse(fs.readFileSync(cachePath(root), 'utf8')) as Cache).killers ?? {}
  } catch {
    return {}
  }
}

export function loadCache(root: string, expected: string): Cache | undefined {
  try {
    const cache: Cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'))
    return cache.fingerprint === expected ? cache : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a test file's cached results still hold: nothing it loaded changed,
 * and every current mutant in those files was already there when it ran.
 */
export function isFresh(
  cached: CachedFile,
  root: string,
  cache: Cache,
  currentBySource: Map<string, string[]>,
): boolean {
  for (const [dep, hash] of Object.entries(cached.deps)) {
    if (hashFile(path.join(root, dep)) !== hash) return false
    const current = currentBySource.get(dep)
    if (!current) continue
    const known = new Set(cache.mutants[dep])
    if (current.some((key) => !known.has(key))) return false
  }
  return true
}
