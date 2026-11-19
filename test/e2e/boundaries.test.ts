import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'

const owner = createE2E('boundaries')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

describe('limits on a run of a whole file', () => {
  // With the tool's own limits cut to a fraction of the defaults, as a slow
  // machine leaves them against what a file takes: the project gives every
  // test and hook a minute.
  it('ends no run sooner than the suite would, nor sooner than loading the file and its hooks take', () => {
    const report = reportPath('limits')
    const cli = tool(['--root', fixture('limits'), '--no-clone', '--timeout-ms', '100', '--timeout-factor', '1', '--report', report])
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const result: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    const status = (file: string, line: number, replacement: string) =>
      result.mutants.find((m) => m.file === file && m.location.start.line === line && m.replacement === replacement)?.status
    // The test keeps the processor busy for a second or more without the memo.
    expect(status('src/fib.ts', 6, 'false')).toBe('Survived')
    // The file takes a second in `beforeAll` and a millisecond in its test.
    expect(status('src/scale.ts', 2, 'v / 2')).toBe('Survived')
    // Four seconds by the clock under a limit of five, and more than five on the processor.
    expect(status('src/settle.ts', 2, "mode !== 'quick'")).toBe('Survived')
    expect(status('src/settle.ts', 2, 'false')).toBe('Survived')
  }, 300_000)

  // A limit by the clock on the run as a whole would come here to five times
  // the file's few milliseconds and 100 ms, and the project's five seconds:
  // under six, where the file takes ten with the mutant and the suite passes.
  it('ends no run of a whole file by the clock while its tests are each within their limit', () => {
    const report = reportPath('wait')
    const cli = tool(['--root', fixture('wait'), '--no-clone', '--timeout-ms', '100', '--timeout-factor', '1', '--report', report])
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const result: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    const status = (replacement: string) => result.mutants.find((m) => m.location.start.line === 2 && m.replacement === replacement)?.status
    expect(status("mode !== 'quick'")).toBe('Survived')
    expect(status('false')).toBe('Survived')
    expect(status('""')).toBe('Survived')
  }, 300_000)
})

describe('a mutant that keeps a test file from ever finishing to load', () => {
  it('is a timeout, and the run ends', () => {
    const report = reportPath('stuck')
    const cli = tool(['--root', fixture('stuck'), '--report', report], { timeout: 110_000 })
    expect(cli.status, cli.stderr).toBe(0)
    const stuck: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(stuck.mutants.map((mutant) => mutant.status)).toEqual(['Timeout'])
  }, 120_000)
})

describe('test files whose runs do not stand each other, or that fail now and then', () => {
  const clash = fixture('clash')
  const verdicts = (run: RunResult) =>
    run.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${m.status}`)
  const runClash = (name: string, env: Record<string, string> = {}): RunResult => {
    const report = reportPath(name)
    const cli = tool(['--root', clash, '--report', report], { env: { ...process.env, VITANT_DEBUG: '1', ...env } })
    // Which runs of a file meet depends on the machine; what each run did and
    // when is kept beside the report, as the next run of the fixture overwrites it.
    fs.writeFileSync(report.replace(/\.json$/, '.log'), cli.stdout)
    fs.cpSync(path.join(clash, 'node_modules/.vitant/session/results'), report.replace(/\.json$/, '-records'), { recursive: true })
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    return JSON.parse(fs.readFileSync(report, 'utf8'))
  }
  let plain: RunResult

  it('runs a file one process at a time once its runs have failed each other, and blames no mutant for it', () => {
    plain = runClash('clash')
    expect(plain.exclusiveFiles, JSON.stringify({ failedBaselines: plain.failedBaselines, flaky: plain.flakyTests, counts: plain.counts, rounds: plain.rounds, wholeRuns: plain.wholeRuns })).toEqual(['test/slot.test.ts'])
    expect(fs.readFileSync(reportPath('clash').replace(/\.json$/, '.log'), 'utf8')).toContain('1 test file(s) were run one at a time: their runs failed each other\n  test/slot.test.ts\n')
    // The test that takes the slot reaches none of the code; whatever it fails says nothing of a mutant.
    const blamed = plain.mutants.filter((mutant) => mutant.evidence?.some((entry) => entry.kind !== 'lead' && entry.test === 'has the slot to itself'))
    expect(blamed.map((mutant) => mutant.replacement)).toEqual([])
    const survivors = plain.mutants.filter((mutant) => mutant.file === 'src/slot.ts' && mutant.status === 'Survived')
    expect(survivors.length).toBeGreaterThan(5)
  }, 120_000)

  it('gives the same verdicts when a test fails every few executions for reasons of its own', () => {
    const unlucky = runClash('clash-unlucky', { CLASH_RUN: `${process.pid}-${Date.now()}` })
    expect(verdicts(unlucky)).toEqual(verdicts(plain))
  }, 120_000)

  it('does not call a mutant survived that a test left out for failing by itself reaches', () => {
    const run = runClash('clash-gauge', { CLASH_GAUGE: `${process.pid}-${Date.now()}` })
    const test = 'test/gauge.test.ts > reads the gauge'
    const killed = new Set(plain.mutants.filter((mutant) => mutant.file === 'src/gauge.ts' && mutant.status === 'Killed').map((mutant) => mutant.id))
    expect(killed.size).toBeGreaterThan(5)
    // Whether the test is found out depends on which of its executions the
    // failures fall on, which the machine's speed decides. Where it is, the
    // one test that detects these mutants was not run with them, or failed
    // with them as it fails without, and nothing says they survive; where
    // it is not, it detects them.
    for (const mutant of run.mutants.filter((mutant) => killed.has(mutant.id))) {
      if (mutant.status === 'Killed') {
        expect([mutant.leftOut, mutant.doubted]).toEqual([undefined, undefined])
      } else {
        expect(mutant.status).toBe('Unconfirmed')
        expect(mutant.leftOut ?? mutant.doubted).toEqual([test])
      }
    }
    expect(verdicts(run).filter((line) => !line.startsWith('src/gauge.ts'))).toEqual(verdicts(plain).filter((line) => !line.startsWith('src/gauge.ts')))
  }, 120_000)

  it('does not call a mutant survived that failed a run of a file in a test that reaches it, though another run passed', () => {
    const run = runClash('clash-lever', { CLASH_LEVER: `${process.pid}-${Date.now()}` })
    const halved = run.mutants.find((mutant) => mutant.file === 'src/lever.ts' && mutant.replacement === 'turns / 2')!
    expect(plain.mutants.find((mutant) => mutant.id === halved.id)!.status).toBe('Killed')
    expect(halved.status).toBe('Unconfirmed')
    expect(halved.wavered).toEqual(['test/lever.test.ts > pulls the lever'])
    expect(fs.readFileSync(reportPath('clash-lever').replace(/\.json$/, '.log'), 'utf8')).toContain('failed in one run of their file and not in another: test/lever.test.ts > pulls the lever')
    expect(verdicts(run).filter((line) => !line.includes('turns / 2'))).toEqual(verdicts(plain).filter((line) => !line.includes('turns / 2')))
  }, 120_000)
})

describe('a test file that fails outside its tests with no mutant on', () => {
  it('is given up on, and the run ends', () => {
    const report = reportPath('restless')
    const cli = tool(['--root', fixture('basic'), '--mutate', 'src/reserve.ts', '--report', report, 'test/reserve.test.ts'], {
      env: { ...process.env, RESERVE_SERVER_DOWN: '1' },
      timeout: 110_000,
    })
    expect(cli.error, 'the run did not end in time').toBeUndefined()
    expect(cli.status, cli.stdout.slice(-2000)).toBe(1)
    expect(cli.stdout).toContain('gave up on 1 test file(s)')
    const result: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(result.abandonedFiles.map((file) => path.relative(fixture('basic'), file))).toEqual(['test/reserve.test.ts'])
    expect(result.counts.Pending).toBe(result.mutants.length)
    // Runs planned again and again in the file give up too, at the cap of 200
    // rounds: here in a minute, on mikro-orm in some ten hours.
    expect(result.rounds).toBeLessThan(20)
  }, 120_000)
})

describe('a test that fails in every run with no mutant on', () => {
  it('leaves every mutant its file reaches unconfirmed, naming the test, where the suite would detect them', () => {
    let stdout = ''
    const run = (name: string, env: Record<string, string> = {}): RunResult => {
      const report = reportPath(name)
      const cli = tool(['--root', fixture('basic'), '--mutate', 'src/postage.ts', '--static', '--report', report, 'test/postage.test.ts', 'test/postage-tracking.test.ts'], {
        env: { ...process.env, ...env },
      })
      expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
      stdout = cli.stdout
      return JSON.parse(fs.readFileSync(report, 'utf8'))
    }
    const plain = run('postage')
    expect(plain.mutants.map((mutant) => mutant.status)).toEqual(plain.mutants.map(() => 'Killed'))
    const down = run('postage-down', { POSTAGE_RATES_DOWN: '1' })
    const test = 'test/postage.test.ts > charges more for a parcel'
    expect(down.failedBaselines).toEqual([test])
    expect(down.neverPassedTests).toEqual([test])
    const unconfirmed = down.mutants.filter((mutant) => mutant.status === 'Unconfirmed').length
    expect(stdout).toContain(`1 of them never passed, and ${unconfirmed} mutant(s) in the sources their files load are unconfirmed for that alone:\n  ${test}\n`)
    const open = down.mutants.filter((mutant) => mutant.status !== 'Killed')
    // The one at load among them, which no test's own record holds, and one
    // that only another file's test was seen to reach.
    expect(open.map((mutant) => mutant.replacement)).toEqual(expect.arrayContaining(['50 / 2', 'grams >= 500']))
    for (const mutant of open) expect([mutant.replacement, mutant.status, mutant.leftOut]).toEqual([mutant.replacement, 'Unconfirmed', [test]])
  }, 120_000)

  it('leaves open, for a test left out after it passed, a mutant of a value its file made while loading', () => {
    const report = reportPath('postage-quota')
    const quota = report.replace(/\.json$/, '.quota')
    fs.rmSync(quota, { force: true })
    const cli = tool(['--root', fixture('basic'), '--mutate', 'src/postage.ts', '--static', '--report', report, 'test/postage-quota.test.ts'], {
      env: { ...process.env, POSTAGE_RATES_QUOTA: quota },
    })
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const result: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(result.neverPassedTests).toEqual([])
    const loaded = result.mutants.find((mutant) => mutant.replacement === '50 / 2')!
    expect([loaded.status, loaded.leftOut]).toEqual(['Unconfirmed', ['test/postage-quota.test.ts > charges more for a parcel within the quota']])
  }, 120_000)
})

describe('a run in which no test runs', () => {
  it('says so and fails, where every mutant would read as not covered', () => {
    const cli = tool(['--root', fixture('basic'), '--mutate', 'src/math.ts', 'no-such-test-file'])
    expect(cli.stdout).toContain('no test ran')
    expect(cli.status).toBe(1)
  }, 180_000)
})

describe('tests that leave a file under version control changed', () => {
  // Inside the repository, so that it resolves the repository's Vitest, and a repository of its own.
  const project = path.join(owner.directory, 'written')

  it('get their verdicts with the files named and a failing exit code', () => {
    fs.rmSync(project, { recursive: true, force: true })
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.mkdirSync(path.join(project, 'test'))
    fs.writeFileSync(path.join(project, 'package.json'), '{ "name": "fixture-written", "private": true, "type": "module" }\n')
    fs.copyFileSync(path.join(root, 'fixtures/basic/vitest.config.ts'), path.join(project, 'vitest.config.ts'))
    fs.writeFileSync(path.join(project, 'data.txt'), 'as committed\n')
    fs.writeFileSync(path.join(project, 'src/add.ts'), 'export const add = (a: number, b: number): number => a + b\n')
    fs.writeFileSync(
      path.join(project, 'test/add.test.ts'),
      [
        "import fs from 'node:fs'",
        "import { expect, it } from 'vitest'",
        "import { add } from '../src/add'",
        "it('adds, and leaves a line in a file of the project', () => {",
        "  fs.appendFileSync(new URL('../data.txt', import.meta.url), 'a run was here\\n')",
        '  expect(add(1, 2)).toBe(3)',
        '})',
        '',
      ].join('\n'),
    )
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: project })
    git('init', '-q')
    git('add', '.')
    expect(git('commit', '-q', '-m', 'as committed').status).toBe(0)

    const cli = tool(['--root', project])
    expect(cli.stdout).toContain('1 file(s) under version control differ from before the run')
    expect(cli.stdout).toContain('data.txt')
    expect(cli.status).toBe(1)
  }, 180_000)
})

describe('a project that has Vitest check types with its tests', () => {
  const project = path.join(owner.directory, 'typed')

  it('is told that this is not done, and its tests run without it', () => {
    fs.rmSync(project, { recursive: true, force: true })
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.mkdirSync(path.join(project, 'test'))
    fs.writeFileSync(path.join(project, 'package.json'), '{ "name": "fixture-typed", "private": true, "type": "module" }\n')
    fs.writeFileSync(
      path.join(project, 'vitest.config.ts'),
      "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'], typecheck: { enabled: true } } })\n",
    )
    fs.writeFileSync(path.join(project, 'src/add.ts'), 'export const add = (a: number, b: number): number => a + b\n')
    fs.writeFileSync(
      path.join(project, 'test/add.test.ts'),
      "import { expect, it } from 'vitest'\nimport { add } from '../src/add'\nit('adds', () => {\n  expect(add(1, 2)).toBe(3)\n})\n",
    )
    const report = reportPath('typed')
    const cli = tool(['--root', project, '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    expect(cli.stdout).toContain('check types along with its tests')
    const typed = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    expect(typed.leftOut.typeCheck).toBe(true)
    expect(typed.counts.Killed).toBeGreaterThan(0)
  }, 180_000)
})

describe("a file the project's own plugins compile from its source and not once instrumented", () => {
  // The fixture's plugin compiles `box` only as written, and its test holds
  // only for the compiled function. Instrumented, the test failed with no
  // mutant on and the file's mutants were reported as covered by no test,
  // where the suite fails with each of them.
  it.each(['vitest3', 'vitest', 'vitest51'])('is left out and named with why, and the other file is mutated, with %s', (version) => {
    const project = path.join(owner.directory, `compiled-${version}`)
    fs.rmSync(project, { recursive: true, force: true })
    fs.cpSync(path.join(root, 'fixtures/compiled'), project, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' })
    fs.mkdirSync(path.join(project, 'node_modules'))
    fs.symlinkSync(path.join(root, 'node_modules', version), path.join(project, 'node_modules/vitest'), 'junction')
    const report = reportPath(`compiled-${version}`)
    const cli = tool(['--root', project, '--mutate', 'src/{box,double}.js', '--report', report])
    expect(cli.status, cli.stdout + cli.stderr).toBe(0)
    const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    const reason = "the project's plugins do not compile its instrumented code as they compile its source (only its source imports /src/memoize.js), so its tests would not run the code the suite runs"
    expect(result.skippedFiles).toEqual([{ file: 'src/box.js', reason }])
    expect(cli.stdout).toContain(`1 file(s) could not be mutated and were left out:\n  src/box.js: ${reason}`)
    expect(result.failedBaselines).toEqual([])
    expect(result.mutants.map((mutant) => `${mutant.file} ${mutant.replacement} ${mutant.status}`).sort()).toEqual(['src/double.js value / 2 Killed', 'src/double.js {} Killed'])
  }, 180_000)
})
