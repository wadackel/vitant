import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createE2E } from '../helpers/e2e.ts'
import { addonTarget } from '../../src/platform.ts'
import type { MutantResult, RunResult } from '../../src/run.ts'

const owner = createE2E('basic')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

let result: RunResult
/** What that run and its workers wrote. */
let output = ''

function statusOf(file: string, line: number, replacement: string): string {
  const matches = result.mutants.filter(
    (m: MutantResult) =>
      m.file === file && m.location.start.line === line && m.replacement === replacement,
  )
  expect(matches, `${file}:${line} ${replacement}`).toHaveLength(1)
  return matches[0].status
}

// The runs here get three minutes each: a hosted runner with an Intel
// processor has taken more than one over a run that takes ten seconds elsewhere.
beforeAll(() => {
  const report = reportPath('basic')
  const cli = tool(['--root', fixture('basic'), '--report', report])
  expect(cli.status, cli.stderr).toBe(0)
  result = JSON.parse(fs.readFileSync(report, 'utf8'))
  output = cli.stdout + cli.stderr
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
  }, 120_000)

  it('gives every mutant the same verdict with the runs that confirm a failure one at a time on the machine', () => {
    const report = reportPath('strict')
    const cli = tool(['--root', fixture('basic'), '--strict', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const strict: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    const verdicts = (run: RunResult) =>
      run.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${m.status}`)
    expect(verdicts(strict)).toEqual(verdicts(result))
  }, 180_000)

  it('gives every mutant the same verdict with a worker started per whole-file run', () => {
    const report = reportPath('no-clone')
    const cli = tool(['--root', fixture('basic'), '--no-clone', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const plain: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    const verdicts = (run: RunResult) =>
      run.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${m.status}`)
    expect(verdicts(plain)).toEqual(verdicts(result))
    expect(plain.wholeRuns['copied before load'] + plain.wholeRuns['copied while loading'] + plain.wholeRuns['copied after load'] + plain.wholeRuns['copied before a test']).toBe(0)
    expect(plain.wholeRuns.started).toBeGreaterThan(0)
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

describe('with mutants in code that only runs while a module loads run too', () => {
  it('judges them, and every other mutant as before', () => {
    const report = reportPath('static')
    const cli = tool(['--root', fixture('basic'), '--static', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const judged: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(judged.counts.Static).toBe(0)
    // The array is filled while the module loads and no test looks at what it starts as.
    const loaded = judged.mutants.find((m) => m.file === 'src/math.ts' && m.location.start.line === 1)!
    expect(['Killed', 'Survived']).toContain(loaded.status)
    const others = (run: RunResult) =>
      run.mutants.filter((m) => result.mutants[m.id].status !== 'Static').map((m) => `${m.id} ${m.status}`)
    expect(others(judged)).toEqual(others(result))

    // Each label is read in one way: by name, through a function, the
    // namespace, a copy of it, a barrel, the original a mock is made from,
    // or as the default export; the last only by a `Set.prototype.add` a
    // test put in place, which the module's check of the built-ins sees. A
    // file that reads none of what a mutant changes is not run with it.
    const labels = judged.mutants.filter((m) => m.file === 'src/labels.ts' && m.mutator !== 'BlockStatement' && m.location.start.line !== 10)
    expect(labels.map((m) => `${m.location.start.line} ${m.status}`)).toEqual([
      ...[1, 2, 3, 4, 5, 6].map((line) => `${line} Killed`),
      '7 Survived',
      '13 Killed',
      ...['16 Killed', '16 Killed', '16 Killed'],
    ])
    const ran = new Map<number, Set<string>>()
    const records = path.join(fixture('basic'), 'node_modules/.vitant/session/results')
    for (const name of fs.readdirSync(records)) {
      for (const line of fs.readFileSync(path.join(records, name), 'utf8').split('\n')) {
        if (!line.includes('"type":"whole"')) continue
        const run = JSON.parse(line) as { mutant: number; file: string }
        ran.set(run.mutant, (ran.get(run.mutant) ?? new Set()).add(path.basename(run.file)))
      }
    }
    const filesOf = (line: number) => [...(ran.get(labels.find((m) => m.location.start.line === line)!.id) ?? [])].sort()
    // The test that replaces `Set.prototype.add` imports the module by `import()`, whose result it drops: all of it counts as read.
    // A mutant detected in one file needs no other, and which comes first differs from run to run.
    const readers = ['labels.greet.test.ts', 'labels.mock.test.ts', 'labels.names.test.ts', 'labels.patched.test.ts']
    expect(filesOf(1).length).toBeGreaterThan(0)
    expect(readers).toEqual(expect.arrayContaining(filesOf(1)))
    // One that survives is run with every file that reads it, and with no other.
    expect(filesOf(7)).toEqual(['labels.mock.test.ts', 'labels.names.test.ts', 'labels.patched.test.ts'])
  }, 180_000)
})

describe('with a limit on the test files a mutant is run against', () => {
  it('reports a mutant with files left as unconfirmed, and no other verdict differently', () => {
    const report = reportPath('confirm')
    const cli = tool(['--root', fixture('basic'), '--confirm', '1', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const limited: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    // Only the hook of the farther file fails with `reset` emptied; the nearest file passes.
    const emptied = limited.mutants.find((m) => m.file === 'src/tally.ts' && m.location.start.line === 17)!
    expect(result.mutants[emptied.id].status).toBe('Killed')
    expect(emptied.status).toBe('Unconfirmed')
    expect(emptied.confirmed).toEqual({ passed: 1, open: 1 })
    expect(cli.stdout).toContain('Unconfirmed (passed 1 of 2 files) src/tally.ts:17')
    for (const mutant of limited.mutants) {
      if (mutant.status !== 'Unconfirmed') expect(`${mutant.id} ${mutant.status}`).toBe(`${mutant.id} ${result.mutants[mutant.id].status}`)
      else expect(['Killed', 'Timeout', 'Survived']).toContain(result.mutants[mutant.id].status)
    }
    // What the run without the limit said the limit would leave out is an upper bound on what it did.
    const lost = limited.mutants.filter((m) => m.status === 'Unconfirmed' && result.mutants[m.id].status !== 'Survived').length
    expect(result.nearest!.detected.slice(1).reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(lost)
    expect(limited.nearest).toBeUndefined()
  }, 180_000)
})

describe('with leads taken at their word', () => {
  it('reports a mutant a test failed with as led, and no other verdict differently', () => {
    const report = reportPath('led')
    const cli = tool(['--root', fixture('basic'), '--led', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const led: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(led.counts.Led).toBeGreaterThan(0)
    const runs = ({ started, lost, ...copied }: RunResult['wholeRuns']) => started + Object.values(copied).reduce((sum, count) => sum + count, 0)
    expect(runs(led.wholeRuns)).toBeLessThan(runs(result.wholeRuns))
    const kind = (status: string) => (status === 'Timeout' ? 'Killed' : status)
    for (const mutant of led.mutants) {
      // A failure next to other runs is left at that too, and that mutant is unconfirmed.
      if (mutant.besideOnly) expect(`${mutant.id} ${mutant.status} ${kind(result.mutants[mutant.id].status)}`).toBe(`${mutant.id} Unconfirmed Killed`)
      else if (mutant.status !== 'Led') expect(`${mutant.id} ${kind(mutant.status)}`).toBe(`${mutant.id} ${kind(result.mutants[mutant.id].status)}`)
      else {
        expect(mutant.led!.tests.length).toBeGreaterThan(0)
        expect(['Killed', 'Timeout', 'Survived']).toContain(result.mutants[mutant.id].status)
      }
    }
    expect(cli.stdout).toMatch(/--led: \d+ mutant\(s\) failed a test while trying it/)
    // A try that ran out of the time Vitest gives the test has no control
    // run after it to say the test passes without the mutant: no lead.
    const delayed = led.mutants.find((m) => m.file === 'src/delay.ts' && m.location.start.line === 2 && m.replacement === 'false')!
    expect(`${delayed.status} ${delayed.besideOnly}`).toBe('Unconfirmed test/delay.test.ts')
  }, 180_000)
})
