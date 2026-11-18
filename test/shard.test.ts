import { describe, expect, it } from 'vitest'
import { mergeReports } from '../src/merge.ts'
import { shareOf } from '../src/mutate/generate.ts'
import type { MutantResult, RunResult } from '../src/run.ts'

describe('dealing files to shares', () => {
  const files = new Map([['a.ts', 40], ['b.ts', 30], ['c.ts', 20], ['d.ts', 10], ['e.ts', 10], ['f.ts', 0]])

  it('puts every file in exactly one share, with about as many mutants in each', () => {
    const shares = shareOf(files, 2)
    expect([...shares.keys()].sort()).toEqual([...files.keys()].sort())
    const totals = [0, 0]
    for (const [file, share] of shares) totals[share] += files.get(file)!
    // Dealt largest first, no share is ahead of another by more than one file's mutants.
    expect(totals).toEqual([60, 50])
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(Math.max(...files.values()))
  })

  it('deals the same way whatever order the files come in', () => {
    const reversed = new Map([...files].reverse())
    expect([...shareOf(reversed, 3)].sort()).toEqual([...shareOf(files, 3)].sort())
  })

  it('leaves shares empty when there are more of them than files', () => {
    expect(new Set(shareOf(new Map([['a.ts', 3]]), 4).values())).toEqual(new Set([0]))
  })
})

const mutant = (file: string, line: number, status: MutantResult['status']): MutantResult =>
  ({ id: 0, file, mutator: 'BooleanLiteral', replacement: 'false', location: { start: { line, column: 0 }, end: { line, column: 4 } }, status, static: false, coveredBy: 0, killedBy: 0 }) as MutantResult

const report = (index: number, count: number, mutants: MutantResult[]): RunResult => {
  const counts = { Killed: 0, Survived: 0, Unconfirmed: 0, Led: 0, Timeout: 0, NoCoverage: 0, Static: 0, Pending: 0 }
  for (const m of mutants) counts[m.status]++
  return {
    mutants: mutants.map((m, id) => ({ ...m, id })),
    counts,
    timings: { generateMs: 1, vitestMs: 10 * index, totalMs: 11 * index },
    testFiles: 3,
    tests: 7,
    failedBaselines: [],
    neverPassedTests: [],
    flakyTests: [],
    leftOut: { projects: {}, typeTests: 0, browserTests: 0 },
    quietRuns: { failed: 0, passed: index },
    exclusiveFiles: [`test/${index}.test.ts`],
    unsureFiles: [],
    changedFiles: [],
    nonRepeatableTests: [],
    suiteErrors: [],
    abandonedFiles: [],
    rounds: index,
    wholeRuns: { started: 1, 'copied before load': 0, 'copied while loading': 0, 'copied after load': index, 'copied before a test': 0, lost: 0 },
    work: { trials: 1, trialCpuMs: 1, wholeMs: { passed: 1, detected: 1 }, workers: 1 },
    unplaced: 0,
    skippedFiles: [],
    vitestVersion: '5.0.3',
    shard: { index, count },
  }
}

describe('merging the reports of shares', () => {
  const first = report(1, 2, [mutant('src/b.ts', 1, 'Killed'), mutant('src/b.ts', 2, 'Survived')])
  const second = report(2, 2, [mutant('src/a.ts', 5, 'Timeout')])

  it('keeps each verdict, in file order, with ids of its own and counts added up', () => {
    const merged = mergeReports([second, first])
    expect(merged.mutants.map((m) => `${m.id} ${m.file}:${m.location.start.line} ${m.status}`)).toEqual([
      '0 src/a.ts:5 Timeout',
      '1 src/b.ts:1 Killed',
      '2 src/b.ts:2 Survived',
    ])
    expect(merged.counts).toMatchObject({ Killed: 1, Timeout: 1, Survived: 1 })
    expect(merged.wholeRuns['copied after load']).toBe(3)
    expect(merged.quietRuns.passed).toBe(3)
    expect(merged.timings.totalMs).toBe(22)
    expect(merged.rounds).toBe(2)
    expect(merged.exclusiveFiles).toEqual(['test/1.test.ts', 'test/2.test.ts'])
    expect(merged.shard).toBeUndefined()
  })

  it('refuses a missing or repeated share, shares of different counts, and reports without one', () => {
    expect(() => mergeReports([first])).toThrow('2 shares need each of 1, 2 once')
    expect(() => mergeReports([first, first])).toThrow('shares 1, 1 given')
    expect(() => mergeReports([first, report(2, 3, [])])).toThrow('the same number of shares')
    expect(() => mergeReports([{ ...first, shard: undefined }])).toThrow('--shard')
  })

  it('names each file left out once, with its reason', () => {
    const vue = { file: 'src/view.vue', reason: '.vue is not a language vitant instruments' }
    const broken = { file: 'src/broken.ts', reason: 'does not parse' }
    const merged = mergeReports([{ ...first, skippedFiles: [vue, broken] }, { ...second, skippedFiles: [vue] }])
    expect(merged.skippedFiles).toEqual([broken, vue])
  })

  it('refuses a mutant that two shares both have', () => {
    expect(() => mergeReports([first, report(2, 2, [mutant('src/b.ts', 1, 'Killed')])])).toThrow('a mutant is in two shares: src/b.ts:1:1')
  })

  it('refuses shares that ran different versions of Vitest', () => {
    expect(() => mergeReports([first, { ...second, vitestVersion: '4.1.12' }])).toThrow('different versions of Vitest')
  })
})
