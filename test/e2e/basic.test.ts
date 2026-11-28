import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { basicRunMs, runBasic } from '../helpers/basic.ts'
import { createE2E, root } from '../helpers/e2e.ts'
import { addonTarget } from '../../src/platform.ts'
import type { MutantResult, RunResult } from '../../src/run.ts'

const owner = createE2E('basic')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

let result: RunResult
/** What that run and its workers wrote. */
let output = ''
/** What each worker of that run said of the tests it drove. */
let tests: { file: string; id: string; name: string; baseline?: string; nonRepeatable?: boolean; needsReplay?: boolean }[] = []
/** The test file of each run of that run made again in a worker started for it, its copy having ended without a verdict. */
let lost: string[] = []

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
  const lines = fs.readdirSync(records).flatMap((name) => fs.readFileSync(path.join(records, name), 'utf8').split('\n'))
  tests = lines.filter((line) => line.includes('"type":"test"')).map((line) => JSON.parse(line))
  lost = lines.filter((line) => line.includes('"type":"plain"')).map((line) => JSON.parse(line) as { file: string; memory?: boolean })
    .filter((record) => !record.memory).map((record) => record.file)
}, basicRunMs)

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
  }, basicRunMs)

  it('gives every mutant the same verdict with the runs that confirm a failure one at a time on the machine', () => {
    const report = reportPath('strict')
    const cli = tool(['--root', fixture('basic'), '--strict', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const strict: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    const verdicts = (run: RunResult) =>
      run.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${m.status}`)
    expect(verdicts(strict)).toEqual(verdicts(result))
  }, basicRunMs)

  // Without this a build that quietly fell back to starting workers would pass every other test.
  it.skipIf(!addonTarget())('makes the whole-file runs in copies of a worker', () => {
    const runs = result.wholeRuns
    expect(runs['copied before load']).toBeGreaterThan(0)
    expect(runs['copied while loading']).toBeGreaterThan(0)
    expect(runs['copied after load']).toBeGreaterThan(0)
    // A copy that ends without a verdict is run again in a worker started for
    // it: the one `guard.ts` ends with SIGKILL in every run, and now and then
    // another on a busy machine. A copy not made because the mutant's code
    // ran while it waited, as `queue-ready.ts`'s chain of promises makes it,
    // is none, though its run was claimed: it is made before the file loads.
    expect(runs.lost).toBeLessThan(3)
    expect(lost.filter((file) => file.endsWith('test/queue.test.ts'))).toEqual([])
    // What is left to workers started for the run: mutants that block or end
    // the process, and the runs made alone, four of them for `delay.ts`; the
    // count varies by a few between runs.
    expect(runs.started).toBeLessThan(22)
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

  it('leaves a snapshot file as it was when a mutant fails a test before the snapshot', () => {
    expect(statusOf('src/copies.ts', 2, 'count <= 1')).toBe('Killed')
    const snap = 'test/__snapshots__/copies.test.ts.snap'
    expect(fs.readFileSync(path.join(fixture('basic'), snap), 'utf8')).toBe(fs.readFileSync(path.join(root, 'fixtures/basic', snap), 'utf8'))
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

  // A test stubs the variable, which the module reads only where Vitest has
  // rewritten `import.meta.env`: with that text in pieces the test failed
  // with no mutant on, and was left out.
  it('reads the environment of the worker through import.meta.env in a replaced condition', () => {
    expect(statusOf('src/volume.ts', 2, 'false')).toBe('Killed')
    expect(statusOf('src/volume.ts', 2, '""')).toBe('Killed')
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

  // The loop also fills the memory, so which limit ends a run of it first,
  // and Timeout or Killed with it, depends on the machine.
  it('detects a loop whose end from outside leaves callbacks that never let the event loop turn', () => {
    expect(['Killed', 'Timeout']).toContain(statusOf('src/unwind.ts', 3, 'index++'))
  })

  it('counts an error nothing handles, which fails a run whose tests all pass', () => {
    expect(statusOf('src/notify.ts', 3, 'strict || listeners.length === 0')).toBe('Killed')
  })

  // The run would not end: a try of the first test leaves a level open, and
  // the second test then loops for good with no mutant on. Whether a run of
  // the whole fixture meets that depends on the machine: the first test tries
  // its mutants in the first round only if it took less than `--cheap-ms`,
  // and later a worker may take the second test's own mutants after them. A
  // run of the first round alone, with every test cheap, always meets it.
  it('ends a test that what an earlier try left makes endless with no mutant on', () => {
    // The loop is the test's own, which no count of the tool's ends: at the
    // default limits each mutant's run of the file waits about 18 s on a CI
    // runner for the watchdog, in every run of a fixture that holds it. What
    // stops the run is the same at any limit.
    const limits = ['--timeout-factor', '1', '--timeout-ms', '100']
    const full = tool(['--root', fixture('nest'), ...limits, '--report', reportPath('nest')])
    expect(full.status, full.stdout.slice(-2000)).toBe(0)
    const nest: RunResult = JSON.parse(fs.readFileSync(reportPath('nest'), 'utf8'))
    // A mutant that leaves a level open fails no test it reaches: only the
    // run of the whole file, where the second test then loops, shows it.
    expect(nest.mutants.map((m) => `${m.location.start.line}:${m.location.start.column} ${m.replacement} ${m.status}`)).toEqual([
      '4:44 {} Killed',
      '5:2 open-- Timeout',
      '6:6 {} Killed',
      '8:12 {} Timeout',
      '9:4 open++ Timeout',
      '14:34 {} Timeout',
      '15:9 open !== 0 Timeout',
      '15:9 true Survived',
      '15:9 false Timeout',
    ])
    const records = path.join(fixture('nest'), 'node_modules/.vitant/session/results')
    const read = () => fs.readdirSync(records).flatMap((name) => fs.readFileSync(path.join(records, name), 'utf8').split('\n')).filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; name?: string; id?: string; mutant?: number; cold?: boolean; survived?: number[]; pid: number })
    // Read now: the run below replaces them.
    const endless = read().find((record) => record.type === 'test' && record.name === 'finds every level closed')!.id
    const cli = tool(['--root', fixture('nest'), '--cheap-ms', '1000', '--max-rounds', '1', ...limits, '--report', reportPath('nest-round-1')])
    expect(cli.stdout).toContain('test/nest.test.ts: still had runs to make after 1 rounds')
    const seen = read()
    // The mutants that survive the first test are those that leave a level open.
    const tried = seen.find((record) => record.type === 'test' && record.name === 'returns what the work returns')!
    expect(tried.survived?.length, JSON.stringify(tried)).toBeGreaterThan(0)
    const stopped = seen.filter((record) => record.type === 'stall' && record.pid === tried.pid)
    expect(stopped.map(({ id, mutant, cold }) => ({ id, mutant, cold }))).toEqual([{ id: endless, mutant: -1, cold: true }])
  }, basicRunMs)

  it('does not go by what a test reached in a worker a mutant had left its mark on', () => {
    // With the module a level off, the test that fails on this mutant returns before the line.
    expect(statusOf('src/depth.ts', 20, 'true')).toBe('Killed')
  })

  it('makes no copy once a file has loaded whose loading set a timer, kept alive or not', () => {
    // A copy made later met the timer done, passed the test with the mutant
    // and failed it without, and the mutant was left unconfirmed.
    expect(statusOf('src/warm.ts', 7, 'x - 1')).toBe('Killed')
  })

  it('keeps what it needs out of reach of a walk from globalThis', () => {
    // With the runtime a property of globalThis the test saw it change, failed
    // with no mutant on, and every mutant of the file was reported as one no test covers.
    expect(result.neverPassedTests).not.toContain('test/sign.test.ts > changes nothing reachable from globalThis')
    expect(statusOf('src/sign.ts', 3, 'value <= 0')).toBe('Killed')
    expect(statusOf('src/sign.ts', 4, 'value >= 0')).toBe('Killed')
    // No test passes NaN. Were the tool's state seen to change while a mutant is on, this one would be counted as Killed.
    expect(statusOf('src/sign.ts', 2, 'false')).toBe('Survived')
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

  it('keeps the modules Vitest hands its workers out of reach of a test that removes the temp directory, and says it was removed', () => {
    // `sweep.test.ts` lets the mutant at the temp directory only where this file marks it.
    const temp = fs.mkdtempSync(path.join(owner.directory, 'temp-'))
    fs.writeFileSync(path.join(temp, 'vitant-sweep-sandbox'), '')
    const report = reportPath('sweep')
    const cli = tool(['--root', fixture('basic'), '--mutate', 'src/sweep.ts', '--report', report], {
      env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    })
    expect(fs.existsSync(temp), 'the mutant removed the temp directory').toBe(false)
    // The runs after it have no temp directory to make one in, which the suite never sees.
    expect(cli.status, cli.stdout.slice(-2000)).toBe(1)
    expect(cli.stdout).toContain(`tests removed the temp directory they were given, ${temp}; the verdicts may rest on it`)
    const swept: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(swept.removedTempDirs).toEqual([temp])
    // Vitest's files for the workers were not in it: every later run still loaded its modules.
    expect(swept.abandonedFiles).toEqual([])
    expect(swept.suiteErrors).toEqual([])
    // What the verdicts are rests on the removal: the test fails with no mutant on from then on.
    expect(swept.mutants.map((m) => m.status)).not.toContain('Pending')
  }, 180_000)
})
