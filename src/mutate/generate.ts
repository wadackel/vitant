import fs from 'node:fs'
import path from 'node:path'
import { instrument, type Mutant } from './instrument.ts'

export interface MutatedFile {
  /** Absolute path. */
  file: string
  source: string
  code: string
  mutants: Mutant[]
}

export interface Generated {
  files: Map<string, MutatedFile>
  mutants: (Mutant & { file: string })[]
  /** Id of the first mutant of each site, plus one trailing total. */
  siteMutants: Uint32Array
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
  let unplaced = 0

  const sources = new Map<string, string>()
  for (const relative of found.sort()) {
    const file = path.resolve(options.root, relative)
    if (options.lines && !options.lines.get(file)) continue
    if (!fs.statSync(file).isFile()) continue
    sources.set(file, fs.readFileSync(file, 'utf8'))
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
    files.set(file, { file, source, code: result.code, mutants: result.mutants })
  }

  firstMutants.push(mutants.length)
  return {
    files,
    mutants,
    siteMutants: Uint32Array.from(firstMutants),
    tracked: Uint8Array.from(mutants, (mutant) => Number(mutant.tracked)),
    unplaced,
    skipped,
  }
}
