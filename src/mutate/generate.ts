import fs from 'node:fs'
import path from 'node:path'
import { instrument, type Mutant } from './instrument.ts'

export interface MutatedFile {
  /** Absolute path. */
  file: string
  source: string
  code: string
  mutants: Mutant[]
  /** Read sites of its watched bindings, by their names in the file. */
  bindings: Map<string, number>
  /** The same, by the names other modules import them by. */
  exports: Map<string, number>
  /** Those whose initializers call built-ins, see `Watched.builtins`. */
  checked: Set<string>
}

export interface Generated {
  files: Map<string, MutatedFile>
  mutants: (Mutant & { file: string })[]
  /** Id of the first mutant of each site, plus one trailing total. */
  siteMutants: Uint32Array
  /** Sites that record reads of a watched binding; they have no mutants. */
  readSites: Set<number>
  /** Per mutant, 1 when the unmutated run records whether it changes a value. */
  tracked: Uint8Array
  unplaced: number
  /** Files oxc could not parse. */
  skipped: string[]
}

export interface GenerateOptions {
  root: string
  include: string[]
  exclude: string[]
  /** When set, only these files and 1-based lines get mutants. */
  lines?: ReadonlyMap<string, ReadonlySet<number>>
  /** When set, only the files of this share of them, see `shareOf`; `index` counts from 1. */
  shard?: Shard
}

export interface Shard {
  index: number
  count: number
}

/**
 * Deals files out to `count` shares with about as many mutants in each: the
 * one with most mutants first, each to the share with fewest so far. It
 * depends on nothing but the files and their mutants, so every machine that
 * runs a share of the same sources deals them the same way. Returns the
 * share of each file, from 0.
 */
export function shareOf(mutantsByFile: ReadonlyMap<string, number>, count: number): Map<string, number> {
  const totals = new Array<number>(count).fill(0)
  const shares = new Map<string, number>()
  const files = [...mutantsByFile].sort(([a, m], [b, n]) => n - m || (a < b ? -1 : a > b ? 1 : 0))
  for (const [file, mutants] of files) {
    const share = totals.indexOf(Math.min(...totals))
    shares.set(file, share)
    totals[share] += mutants
  }
  return shares
}

export const defaultInclude = ['src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}']
export const defaultExclude = [
  '**/node_modules/**',
  '**/*.d.ts',
  '**/*.{test,spec}.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/tests/**',
  '**/test/**',
]

export function generate(options: GenerateOptions): Generated {
  const found = fs.globSync(options.include, { cwd: options.root, exclude: options.exclude })
  const files = new Map<string, MutatedFile>()
  const mutants: Generated['mutants'] = []
  const firstMutants: number[] = []
  const skipped: string[] = []
  const readSites = new Set<number>()
  let unplaced = 0

  const sources = new Map<string, string>()
  for (const relative of found.sort()) {
    const file = path.resolve(options.root, relative)
    if (options.lines && !options.lines.get(file)) continue
    if (!fs.statSync(file).isFile()) continue
    sources.set(file, fs.readFileSync(file, 'utf8'))
  }
  if (options.shard) {
    // Counted with the same lines as below, so that a share of a diff is a share of its mutants.
    const counts = new Map([...sources].map(([file, source]) => [file, instrument(source, file, { siteBase: 0, mutantBase: 0, lines: options.lines?.get(file) })?.mutants.length ?? 0]))
    const shares = shareOf(counts, options.shard.count)
    for (const file of sources.keys()) if (shares.get(file) !== options.shard.index - 1) sources.delete(file)
  }
  for (const [file, source] of sources) {
    const lines = options.lines?.get(file)
    const result = instrument(source, file, {
      siteBase: firstMutants.length,
      mutantBase: mutants.length,
      lines,
    })
    if (!result) {
      skipped.push(file)
      continue
    }
    unplaced += result.unplaced
    if (result.mutants.length === 0) continue
    let site = -1
    for (const mutant of result.mutants) {
      if (mutant.site !== site) {
        site = mutant.site
        firstMutants.push(mutant.id)
      }
      mutants.push({ ...mutant, file })
    }
    for (let index = 0; index < result.readSites; index++) {
      readSites.add(firstMutants.length)
      firstMutants.push(mutants.length)
    }
    files.set(file, { file, source, code: result.code, mutants: result.mutants, bindings: result.bindings, exports: result.exports, checked: result.checked })
  }

  firstMutants.push(mutants.length)
  return {
    files,
    mutants,
    siteMutants: Uint32Array.from(firstMutants),
    readSites,
    tracked: Uint8Array.from(mutants, (mutant) => Number(mutant.tracked)),
    unplaced,
    skipped,
  }
}
