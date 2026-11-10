// Reuse of an earlier run's results. A test file's results carry over only if
// nothing it loaded has changed: every module it imported, its snapshot file,
// and everything that shapes the run as a whole (tool and Vitest versions,
// lock files, config, limits). What a test reads from disk in other ways is
// not tracked, which is why this is opt-in.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseSync } from 'oxc-parser'
import type { Generated } from './mutate/generate.ts'
import { relative } from './session.ts'

/** Bumped whenever cached data would be read differently. */
const FORMAT = 10

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
  /** The bindings only reading can make anything of that its unmutated runs read, by `bindingKeys`. */
  reads: string[]
}

export interface Cache {
  fingerprint: string
  /** Per source file, the mutants the cached tests were run against. */
  mutants: Record<string, string[]>
  files: Record<string, CachedFile>
  /** Every binding of that kind there was, by `bindingKeys`: one there was not was never marked where it is read. */
  watched: string[]
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

const SCRIPT = /\.(m|c)?[jt]sx?$/
// Syntax that only TypeScript reads: nothing of it is left once the module is compiled.
const TYPE_ONLY = new Set([
  'TSTypeAnnotation',
  'TSTypeParameterDeclaration',
  'TSTypeParameterInstantiation',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSDeclareFunction',
])
const UNWRAPPED = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'])

function runtimeShape(node: unknown): unknown {
  if (Array.isArray(node)) return node.flatMap((child) => (isTypeOnly(child) ? [] : [runtimeShape(child)]))
  if (!node || typeof node !== 'object') return node
  const object = node as Record<string, unknown>
  if (typeof object.type === 'string' && UNWRAPPED.has(object.type)) return runtimeShape(object.expression)
  const shape: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    if (key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
    // A type left out and no type at all have to look the same.
    if (value === null || value === undefined || isTypeOnly(value)) continue
    shape[key] = runtimeShape(value)
  }
  return shape
}

function isTypeOnly(node: unknown): boolean {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false
  const object = node as Record<string, unknown>
  if (typeof object.type !== 'string') return false
  if (TYPE_ONLY.has(object.type)) return true
  if (object.declare === true) return true
  if ((object.type === 'ImportDeclaration' || object.type === 'ExportNamedDeclaration') && (object.importKind === 'type' || object.exportKind === 'type')) return true
  return (object.type === 'ImportSpecifier' || object.type === 'ExportSpecifier') && (object.importKind === 'type' || object.exportKind === 'type')
}

/**
 * Content hash of a file, or a marker when it does not exist. A script is
 * hashed by its syntax tree without positions, comments and types, so that a
 * change Vite compiles away does not count as one; positions are left out too,
 * which a test that reads its own stack's line numbers would see.
 */
export function hashFile(file: string): string {
  let hash = hashes.get(file)
  if (hash === undefined) {
    if (!fs.existsSync(file)) hash = 'missing'
    else {
      const bytes = fs.readFileSync(file)
      let content: string | Buffer = bytes
      if (SCRIPT.test(file)) {
        const parsed = parseSync(file, bytes.toString('utf8'))
        if (parsed.errors.length === 0) content = JSON.stringify(runtimeShape(parsed.program), (_, value) => (typeof value === 'bigint' ? `${value}n` : value))
      }
      hash = crypto.createHash('sha1').update(content).digest('hex')
    }
    hashes.set(file, hash)
  }
  return hash
}

/** Everything outside the test files' own imports that a verdict depends on. */
export function fingerprint(root: string, vitestVersion: string, limits: unknown): string {
  const shared = fs
    .readdirSync(root)
    .filter((name) =>
      // A `tsconfig` decides how classes and decorators compile, and Vite reads `.env` files into the code.
      /^(vitest|vite)\.(config|workspace)\.|^(package\.json|yarn\.lock|pnpm-lock\.yaml|package-lock\.json|bun\.lockb?)$|^tsconfig[^/]*\.json$|^\.env(\..+)?$/.test(name),
    )
    .sort()
    .map((name) => `${name}:${hashFile(path.join(root, name))}`)
  return JSON.stringify([FORMAT, process.versions.node.split('.')[0], process.platform, process.arch, vitestVersion, limits, shared])
}

/**
 * Per source whose hash still holds, cached mutant keys by the current
 * mutant's id, where the mutants are the same kinds and replacements in the
 * same order: lines added or taken away that held no code moved them. Any
 * other difference leaves the source out, and its mutants count as new.
 */
export function alignedKeys(cache: Cache, currentBySource: Map<string, string[]>, idByKey: Map<string, number>, root: string): Map<string, number> {
  const moved = new Map<string, number>()
  const kind = (key: string) => key.split('|').filter((_, i) => i !== 1 && i !== 2).join('|')
  for (const [source, cached] of Object.entries(cache.mutants)) {
    const current = currentBySource.get(source)
    if (!current || current.length !== cached.length || hashFile(path.join(root, source)) === 'missing') continue
    if (!current.every((key, i) => kind(key) === kind(cached[i]))) continue
    cached.forEach((key, i) => moved.set(key, idByKey.get(current[i])!))
  }
  return moved
}

/** Per read site, `<source file>#<binding>`. */
export function bindingKeys(generated: Generated, root: string): Map<number, string> {
  const keys = new Map<number, string>()
  for (const [file, entry] of generated.files) for (const [name, site] of entry.bindings) keys.set(site, `${relative(root, file)}#${name}`)
  return keys
}

export function mutantKeys(generated: Generated, root: string): string[] {
  return generated.mutants.map(
    (mutant) =>
      `${relative(root, mutant.file)}|${mutant.start}|${mutant.end}|${mutant.mutator}|${mutant.replacement}`,
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
    return `${relative(root, mutant.file)}|${mutant.mutator}|${mutant.replacement}|${line}`
  })
}

export function testKey(root: string, file: string, name: string): string {
  return `${relative(root, file)}\n${name}`
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
  /** Sources whose mutants are those of the cached run in the same order, at moved positions. */
  aligned: ReadonlySet<string>,
): boolean {
  for (const [dep, hash] of Object.entries(cached.deps)) {
    if (hashFile(path.join(root, dep)) !== hash) return false
    const current = currentBySource.get(dep)
    if (!current || aligned.has(dep)) continue
    const known = new Set(cache.mutants[dep])
    if (current.some((key) => !known.has(key))) return false
  }
  return true
}
