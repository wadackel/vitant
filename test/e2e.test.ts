import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addonTarget } from '../src/platform.ts'
import type { MutantResult, RunResult } from '../src/run.ts'

const root = path.join(import.meta.dirname, '..')
let result: RunResult

function statusOf(file: string, line: number, replacement: string): string {
  const matches = result.mutants.filter(
    (m: MutantResult) =>
      m.file === file && m.location.start.line === line && m.replacement === replacement,
  )
  expect(matches, `${file}:${line} ${replacement}`).toHaveLength(1)
  return matches[0].status
}

describe('running the fixture project', () => {
  beforeAll(() => {
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-')), 'report.json')
    const cli = spawnSync(
      process.execPath,
      [path.join(root, 'src/cli.ts'), '--root', path.join(root, 'fixtures/basic'), '--report', report],
      { encoding: 'utf8' },
    )
    expect(cli.status, cli.stderr).toBe(0)
    result = JSON.parse(fs.readFileSync(report, 'utf8'))
  }, 60_000)

  it('gives every mutant the same verdict with a worker started per whole-file run', () => {
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-')), 'report.json')
    const cli = spawnSync(
      process.execPath,
      [path.join(root, 'src/cli.ts'), '--root', path.join(root, 'fixtures/basic'), '--no-clone', '--report', report],
      { encoding: 'utf8' },
    )
    expect(cli.status, cli.stderr).toBe(0)
    const plain: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    const verdicts = (run: RunResult) =>
      run.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${m.status}`)
    expect(verdicts(plain)).toEqual(verdicts(result))
    expect(plain.wholeRuns['copied before load'] + plain.wholeRuns['copied after load']).toBe(0)
    expect(plain.wholeRuns.started).toBeGreaterThan(0)
  }, 60_000)

  // Without this a build that quietly fell back to starting workers would pass every other test.
  it.skipIf(!addonTarget())('makes the whole-file runs in copies of a worker', () => {
    const runs = result.wholeRuns
    expect(runs['copied before load']).toBeGreaterThan(0)
    expect(runs['copied after load']).toBeGreaterThan(0)
    expect(runs.lost).toBe(0)
    // What is left to workers started for the run: mutants that block or end the process.
    expect(runs.started).toBeLessThan(10)
  })

  it('kills a mutant a test fails on and keeps one no test notices', () => {
    expect(statusOf('src/math.ts', 4, 'value >= min')).toBe('Killed')
    expect(statusOf('src/math.ts', 19, 'value % 2 !== 0')).toBe('Survived')
  })

  it('credits every test that reaches a mutant, not just the first', () => {
    const mutant = result.mutants.find(
      (m) => m.file === 'src/math.ts' && m.location.start.line === 4 && m.replacement === 'value >= min',
    )!
    expect(mutant.coveredBy).toBe(3)
  })

  it('reports a mutant whose value never differed as survived without having to run it', () => {
    // No test calls `clamp` with a value equal to the bound.
    expect(statusOf('src/math.ts', 4, 'value <= min')).toBe('Survived')
  })

  it('stops a mutant that loops forever or never settles', () => {
    expect(statusOf('src/math.ts', 12, 'i--')).toBe('Timeout')
    expect(statusOf('src/counter.ts', 13, '() => undefined')).toBe('Timeout')
  })

  it('separates code no test reaches from code that only runs at import', () => {
    expect(statusOf('src/math.ts', 23, 'value')).toBe('NoCoverage')
    expect(statusOf('src/math.ts', 1, '{}')).toBe('Static')
  })

  it('counts a failure that only shows while an aroundEach hook tears down', () => {
    expect(statusOf('src/ledger.ts', 3, '{}')).toBe('Killed')
  })

  it('judges code that only the hooks cleaning up after a test reach', () => {
    // `total` is called by the hook alone, once the test is over.
    expect(statusOf('src/ledger.ts', 9, 'sum -= amount')).toBe('Killed')
  })

  it('judges code that only afterEach reaches, where the next test is what fails', () => {
    expect(statusOf('src/pool.ts', 9, 'false')).toBe('Killed')
    expect(statusOf('src/pool.ts', 13, 'true')).toBe('Killed')
  })

  it('judges code that only a hook after the last test reaches', () => {
    expect(statusOf('src/handles.ts', 7, '{}')).toBe('Killed')
    expect(statusOf('src/handles.ts', 12, 'true')).toBe('Killed')
  })

  it('judges code that only the teardown of a fixture shared by the file reaches', () => {
    expect(statusOf('src/scope.ts', 2, 'value / 2')).toBe('Killed')
  })

  it('leaves tests that are retried or repeated to run as the project has them', () => {
    // The first try throws before the call and the first run does not look at the result.
    expect(statusOf('src/again.ts', 2, 'value - 1')).toBe('Killed')
    expect(result.failedBaselines).toEqual([])
  })

  it('judges what a test that skipped itself had reached', () => {
    expect(statusOf('src/flags.ts', 2, 'true')).toBe('Killed')
  })

  it('does not take a loop for endless because it is long', () => {
    // Three million iterations in place of two, done in milliseconds.
    expect(statusOf('src/scan.ts', 3, 'i < values.length || i < cap')).toBe('Survived')
    expect(statusOf('src/scan.ts', 3, 'i--')).toBe('Timeout')
    // The loop runs in `beforeAll`, with or without the mutant.
    expect(statusOf('src/setup.ts', 8, 'value - 1')).toBe('Survived')
  })

  it('counts a mutant that ends the process as detected and goes on with the rest of the file', () => {
    expect(statusOf('src/guard.ts', 2, 'true')).toBe('Killed')
    expect(statusOf('src/guard.ts', 2, 'false')).toBe('Survived')
    expect(statusOf('src/guard.ts', 3, '""')).toBe('Killed')
    expect(result.abandonedFiles).toEqual([])
  })

  it('does not take a pass for an answer when a filled cache kept the mutant from running', () => {
    expect(statusOf('src/cache.ts', 4, '40 - 2')).toBe('Killed')
  })

  it('counts a failure whose error Vitest cannot serialise', () => {
    // The error holds a revoked proxy. Thrown by the test, Vitest ends the
    // attempt there; thrown by a hook, it also skips what follows the hook.
    expect(statusOf('src/view.ts', 10, 'true')).toBe('Killed')
    expect(statusOf('src/view.ts', 14, 'true')).toBe('Killed')
  })

  it('runs the whole file with a mutant that changes what the file computes while it loads', () => {
    // The one test that calls `double` cannot tell the mutant apart; the
    // one that can only compares a list built before any test ran.
    expect(statusOf('src/registry.ts', 4, 'value / 2')).toBe('Killed')
  })

  it('judges what only the first run in a process can show with the mutant on from the start', () => {
    // The registry keeps the first value it is given; in a worker that ran
    // the test unmutated first, the mutated value is built and dropped.
    expect(statusOf('src/registry.ts', 8, '10 - 10')).toBe('Killed')
  })

  it('counts an error nothing handles, which fails a run whose tests all pass', () => {
    expect(statusOf('src/notify.ts', 3, 'strict || listeners.length === 0')).toBe('Killed')
  })

  it('settles what only a test that cannot be re-run sees by running the whole file', () => {
    // A mutant of the pool leaves its count below zero, where the hook does not bring it
    // back; which of the two tests there meets that first differs from run to run.
    const elsewhere = result.nonRepeatableTests.filter((name) => !name.startsWith('test/pool.test.ts'))
    expect(elsewhere.sort()).toEqual([
      'test/sequence.test.ts > starts at one',
      'test/words.test.ts > reads the first word from the start of the file',
    ])
    // Re-running the test in place fails with or without the mutant; a worker
    // running the file once shows the mutant breaks it.
    expect(statusOf('src/sequence.ts', 5, 'next -= 1')).toBe('Killed')
  })
})

describe('reusing an earlier run', () => {
  // A copy inside the repository, so that it still resolves the repository's Vitest.
  const copy = path.join(root, 'fixtures', `.tmp-${process.pid}`)
  const report = path.join(copy, 'report.json')
  const runCopy = () => {
    const cli = spawnSync(
      process.execPath,
      [path.join(root, 'src/cli.ts'), '--root', copy, '--incremental', '--report', report],
      { encoding: 'utf8' },
    )
    expect(cli.status, cli.stderr).toBe(0)
    const reused = /(\d+) of \d+ test file\(s\) reused/.exec(cli.stderr)
    return { reused: Number(reused?.[1]), result: JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult }
  }
  const statuses = (run: RunResult) => run.mutants.map((m) => `${m.file}:${m.id}:${m.status}:${m.coveredBy}`)

  beforeAll(() => {
    fs.rmSync(copy, { recursive: true, force: true })
    fs.cpSync(path.join(root, 'fixtures/basic'), copy, {
      recursive: true,
      filter: (source) => !source.includes('node_modules'),
    })
  })
  afterAll(() => fs.rmSync(copy, { recursive: true, force: true }))

  it('gives the same report without running anything when nothing changed', () => {
    const first = runCopy()
    expect(first.reused).toBe(0)
    const second = runCopy()
    expect(second.reused).toBe(20)
    expect(second.result.rounds).toBe(0)
    expect(statuses(second.result)).toEqual(statuses(first.result))
  }, 60_000)

  it('remembers which test killed a mutant, under a key that survives edits elsewhere in the file', () => {
    const cache = JSON.parse(fs.readFileSync(path.join(copy, 'node_modules/.vitant/cache.json'), 'utf8'))
    const [key] = Object.keys(cache.killers).filter((entry) =>
      entry.startsWith('src/math.ts|EqualityOperator|value >= min|'),
    )
    expect(key).toBeDefined()
    expect(key).not.toMatch(/\|\d+\|/)
    expect(cache.killers[key][0]).toMatch(/^test\/math\.test\.ts\n/)
  })

  it('runs again only the test files that load a changed file', () => {
    const before = runCopy().result
    fs.appendFileSync(path.join(copy, 'src/counter.ts'), '\n// touched\n')
    const after = runCopy()
    // Only counter.test.ts imports counter.ts.
    expect(after.reused).toBe(19)
    expect(after.result.counts).toEqual(before.counts)
  }, 60_000)

  it('picks up a new test that kills a mutant the cached run left alive', () => {
    const before = runCopy().result
    expect(before.mutants.some((m) => m.status === 'Survived' && m.replacement === 'value % 2 !== 0')).toBe(true)
    fs.appendFileSync(
      path.join(copy, 'test/math.test.ts'),
      "\nit('tells even from odd', () => {\n  expect(isEven(2)).toBe(true)\n  expect(isEven(3)).toBe(false)\n})\n",
    )
    const after = runCopy()
    expect(after.reused).toBe(19)
    const mutant = after.result.mutants.find((m) => m.replacement === 'value % 2 !== 0')!
    expect(mutant.status).toBe('Killed')
  }, 60_000)
})

describe('with mutants in code that only runs while a module loads run too', () => {
  it('judges them, and every other mutant as before', () => {
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-')), 'report.json')
    const cli = spawnSync(
      process.execPath,
      [path.join(root, 'src/cli.ts'), '--root', path.join(root, 'fixtures/basic'), '--static', '--report', report],
      { encoding: 'utf8' },
    )
    expect(cli.status, cli.stderr).toBe(0)
    const judged: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(judged.counts.Static).toBe(0)
    // The array is filled while the module loads and no test looks at what it starts as.
    const loaded = judged.mutants.find((m) => m.file === 'src/math.ts' && m.location.start.line === 1)!
    expect(['Killed', 'Survived']).toContain(loaded.status)
    const others = (run: RunResult) =>
      run.mutants.filter((m) => result.mutants[m.id].status !== 'Static').map((m) => `${m.id} ${m.status}`)
    expect(others(judged)).toEqual(others(result))
  }, 60_000)
})

describe('a mutant that keeps a test file from ever finishing to load', () => {
  it('is a timeout, and the run ends', () => {
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-')), 'report.json')
    const cli = spawnSync(
      process.execPath,
      [path.join(root, 'src/cli.ts'), '--root', path.join(root, 'fixtures/stuck'), '--report', report],
      { encoding: 'utf8', timeout: 110_000 },
    )
    expect(cli.status, cli.stderr).toBe(0)
    const stuck: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(stuck.mutants.map((mutant) => mutant.status)).toEqual(['Timeout'])
  }, 120_000)
})
