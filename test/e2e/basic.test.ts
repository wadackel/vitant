import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBasic } from '../helpers/basic.ts'
import { createE2E } from '../helpers/e2e.ts'
import { addonTarget } from '../../src/platform.ts'
import type { MutantResult, RunResult } from '../../src/run.ts'

const owner = createE2E('basic')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

let result: RunResult
/** What that run and its workers wrote. */
let output = ''
/** What each worker of that run said of the tests it drove. */
let tests: { file: string; name: string; baseline?: string; nonRepeatable?: boolean; needsReplay?: boolean }[] = []

function statusOf(file: string, line: number, replacement: string): string {
  const matches = result.mutants.filter(
    (m: MutantResult) =>
      m.file === file && m.location.start.line === line && m.replacement === replacement,
  )
  expect(matches, `${file}:${line} ${replacement}`).toHaveLength(1)
  return matches[0].status
}

beforeAll(() => {
  ({ result, output } = runBasic(owner))
  // Read now: the other runs of the fixture below replace them.
  const records = path.join(fixture('basic'), 'node_modules/.vitant/session/results')
  tests = fs.readdirSync(records)
    .flatMap((name) => fs.readFileSync(path.join(records, name), 'utf8').split('\n').filter((line) => line.includes('"type":"test"')))
    .map((line) => JSON.parse(line))
}, 180_000)

describe('running the fixture project', () => {


  // `trust.test.ts` reads what the system trusts, the first time in a copy
  // of a worker; macOS ends such a copy unless its check is off, and says
  // so. The run is then made by a worker started for it and the verdicts
  // are the same, so only the message shows it.
  it('loses no copy of a worker to what macOS checks in one', () => {
    expect(output).not.toContain('when fork() was called')
  })

  // Hosted CI machines have three or four cores; what holds a worker while it waits for another shows there.
  it('gives every mutant the same verdict with two workers, and gives up on no file', () => {
    const report = reportPath('two-workers')
    const cli = tool(['--root', fixture('basic'), '--max-workers', '2', '--report', report])
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const few: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(few.abandonedFiles).toEqual([])
    const verdicts = (run: RunResult) =>
      run.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${m.status}`)
    expect(verdicts(few)).toEqual(verdicts(result))
  }, 180_000)

  it('gives every mutant the same verdict with the runs that confirm a failure one at a time on the machine', () => {
    const report = reportPath('strict')
    const cli = tool(['--root', fixture('basic'), '--strict', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const strict: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    const verdicts = (run: RunResult) =>
      run.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${m.status}`)
    expect(verdicts(strict)).toEqual(verdicts(result))
  }, 180_000)

  // Without this a build that quietly fell back to starting workers would pass every other test.
  it.skipIf(!addonTarget())('makes the whole-file runs in copies of a worker', () => {
    const runs = result.wholeRuns
    expect(runs['copied before load']).toBeGreaterThan(0)
    expect(runs['copied while loading']).toBeGreaterThan(0)
    expect(runs['copied after load']).toBeGreaterThan(0)
    // A copy that ends without a verdict is run again in a worker started for
    // it, and with the other test files of this suite running next to it
    // that happens to one now and then.
    expect(runs.lost).toBeLessThan(3)
    // What is left to workers started for the run: mutants that block or end
    // the process, and the runs made alone, four of them for `delay.ts`.
    expect(runs.started).toBeLessThan(17)
  })

  it('kills a mutant a test fails on and keeps one no test notices', () => {
    expect(statusOf('src/math.ts', 4, 'value >= min')).toBe('Killed')
    expect(statusOf('src/math.ts', 19, 'value % 2 !== 0')).toBe('Survived')
  })

  it('preserves application error-listener management during whole-file runs', () => {
    const mutants = result.mutants.filter((mutant) => mutant.file === 'src/process-listeners.ts')
    expect(mutants).toHaveLength(10)
    expect(mutants.filter((mutant) => mutant.status === 'Killed')).toHaveLength(2)
    expect(mutants.filter((mutant) => mutant.status === 'Survived')).toHaveLength(8)
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

  it('runs afterEach only after a beforeEach while tests try mutants', () => {
    // Each test of the file holds what its `beforeEach` took and `afterEach`
    // gives back; one `afterEach` too many after the first test's tries left
    // the second holding nothing, and it failed with no mutant on.
    const lease = tests.filter((test) => test.file.endsWith('test/lease.test.ts'))
    expect(lease.map((test) => test.name)).toContain('charges for the hours of the lease')
    expect(lease.filter((test) => test.baseline === 'fail').map((test) => test.name)).toEqual([])
    expect(statusOf('src/lease.ts', 2, 'hours / 3')).toBe('Killed')
  })

  it('counts the assertions of each try of a test apart', () => {
    // The test asks the `expect` of its context for one assertion; counted
    // over its tries, it failed with no mutant on from its second try on.
    expect(result.nonRepeatableTests).not.toContain('test/tip.test.ts > adds a fifth for the tip')
    const tip = tests.filter((test) => test.file.endsWith('test/tip.test.ts'))
    expect(tip.map((test) => test.name)).toContain('adds a fifth for the tip')
    expect(tip.filter((test) => test.nonRepeatable || test.needsReplay)).toEqual([])
    expect(statusOf('src/tip.ts', 2, 'amount * 5')).toBe('Killed')
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

  it('does not detect a loop whose caller accepts its VM deadline', () => {
    expect(statusOf('src/vm-deadline.ts', 2, '{}')).toBe('Survived')
  })

  it('detects a looping finalizer even when its caller catches errors', () => {
    expect(statusOf('src/caught-finalizer.ts', 2, '{}')).toBe('Timeout')
  })

  it('preserves caller interruption within explicit and disabled hook deadlines', () => {
    expect(statusOf('src/hook-vm.ts', 2, '{}')).toBe('Survived')
    expect(statusOf('src/untimed-hook-vm.ts', 2, '{}')).toBe('Survived')
  })

  it('keeps internal hook contexts out of application spies', () => {
    expect(statusOf('src/hook-context.ts', 1, '{}')).toBe('Survived')
    expect(statusOf('src/hook-context.ts', 1, 'false')).toBe('Survived')
  })

  it('detects a mutant that makes a test run out of its time, though no control follows the try', () => {
    expect(statusOf('src/delay.ts', 2, 'false')).toBe('Timeout')
    expect(statusOf('src/delay.ts', 2, 'true')).toBe('Survived')
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

  it('keeps an uncaught loop interruption as a timeout', () => {
    expect(statusOf('src/uncaught-loop.ts', 2, 'true')).toBe('Timeout')
  })

  it('counts an error nothing handles, which fails a run whose tests all pass', () => {
    expect(statusOf('src/notify.ts', 3, 'strict || listeners.length === 0')).toBe('Killed')
  })

  it('does not go by what a test reached in a worker a mutant had left its mark on', () => {
    // With the module a level off, the test that fails on this mutant returns before the line.
    expect(statusOf('src/depth.ts', 20, 'true')).toBe('Killed')
  })

  it('makes no copy once a file has loaded whose loading set a timer, kept alive or not', () => {
    // A copy made later met the timer done, passed the test with the mutant
    // and failed it without, and the mutant was left unconfirmed.
    expect(statusOf('src/warm.ts', 7, 'x - 1')).toBe('Killed')
  })

  it('runs the tests with NODE_ENV set to test, as the vitest command does', () => {
    // Otherwise the rejection the module leaves outside a test environment fails every run of the file.
    expect(result.abandonedFiles).toEqual([])
    expect(statusOf('src/watch.ts', 2, 'true')).toBe('Killed')
    expect(statusOf('src/watch.ts', 2, 'false')).toBe('Survived')
  })

  it('settles what only a test that cannot be re-run sees by running the whole file', () => {
    // A mutant of the pool leaves its count below zero, where the hook does not bring it
    // back; which of the two tests there meets that first differs from run to run. So
    // it is with the test a mutant leaves a level off, and with the one that passes only
    // once the module's timer has turned `early` off: a second run in place finds it
    // done, and on a slow runner so does the first.
    const elsewhere = result.nonRepeatableTests.filter((name) => !/^test\/(pool|depth|warm)\.test\.ts/.test(name))
    expect(elsewhere.sort()).toEqual([
      'test/sequence.test.ts > starts at one',
      'test/words.test.ts > reads the first word from the start of the file',
    ])
    // Re-running the test in place fails with or without the mutant; a worker
    // running the file once shows the mutant breaks it.
    expect(statusOf('src/sequence.ts', 5, 'next -= 1')).toBe('Killed')
  })
})
