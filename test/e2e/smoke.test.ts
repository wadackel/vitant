import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import { addonTarget } from '../../src/platform.ts'
import type { RunResult } from '../../src/run.ts'

const owner = createE2E('smoke')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

it('replays a file when a suite hook requires an earlier test', () => {
  const report = reportPath('hook-order')
  const cli = tool([
    '--root', fixture('basic'),
    '--mutate', 'src/hook-order.ts',
    '--cheap-ms', '0',
    '--max-workers', '2',
    '--report', report,
  ])
  expect(cli.status, cli.stdout + cli.stderr).toBe(0)
  const run = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
  expect(run.abandonedFiles).toEqual([])
  expect(run.counts.Pending).toBe(0)
  expect(run.counts.Survived).toBeGreaterThan(0)
  expect(run.mutants.find((mutant) => mutant.location.start.line === 6 && mutant.replacement === 'false')?.status).toBe('Killed')
}, 120_000)

describe('console output on Vitest 5.1', () => {
  // Vitest 5.0 does not consume the console RPC's returned promise, so it cannot expose a missing one.
  const project = path.join(owner.directory, 'console')
  beforeAll(() => {
    fs.cpSync(fixture('basic'), project, {
      recursive: true,
      filter: (source) => !source.includes('node_modules'),
    })
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true })
    fs.symlinkSync(path.join(root, 'node_modules/vitest51'), path.join(project, 'node_modules/vitest'), 'junction')
  })

  it('does not kill a mutant whose only effect is an extra console message', () => {
    const report = reportPath('console')
    const cli = tool(['--root', project, '--mutate', 'src/logging.ts', '--report', report])
    expect(cli.status, cli.stdout + cli.stderr).toBe(0)
    const logged = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    expect(logged.vitestVersion).toMatch(/^5\.1\./)
    if (addonTarget()) expect(logged.wholeRuns['copied after load']).toBeGreaterThan(0)
    expect(logged.mutants.find((mutant) => mutant.replacement === 'true')?.status).toBe('Survived')
    expect(logged.mutants.find((mutant) => mutant.replacement === 'value >= 0')?.status).toBe('Survived')
    expect(logged.mutants.find((mutant) => mutant.mutator === 'BlockStatement')?.status).toBe('Killed')
  }, 120_000)
})

describe('runs copied after the tests before the first to reach the mutant', () => {
  it.skipIf(!addonTarget())('are made, and not where an earlier test wrote a file or the tests run at once, nor in a file whose hook starts a thread', () => {
    const walk = fixture('walk')
    const report = reportPath('walk')
    const cli = tool(['--root', walk, '--report', report])
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const run: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(run.wholeRuns['copied before a test']).toBeGreaterThan(0)
    const results = path.join(walk, 'node_modules/.vitant/session/results')
    const records = fs
      .readdirSync(results)
      .flatMap((name) => fs.readFileSync(path.join(results, name), 'utf8').split('\n'))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { type: string; file: string; why?: string; clock?: boolean })
    const refused = records.filter((record) => record.type === 'walk').map((record) => `${path.basename(record.file)} ${record.why}`)
    expect([...new Set(refused)].sort()).toEqual(['inbox.test.ts wrote', 'pair.test.ts concurrent'])
    // The thread the hook starts is still there as the file's first run
    // ends, and might read the clock for a test: no run of the file is made
    // in a copy whose clocks stood still, a copy made before a test included.
    const clocked = records.filter((record) => record.type === 'early' && record.clock).map((record) => path.basename(record.file))
    expect([...new Set(clocked)]).toEqual(['relay.test.ts'])
    // Copied once after the first test, the file it leaves is there for one copy and gone for the next.
    expect(run.mutants.find((mutant) => mutant.replacement === 'n / 2')?.status).toBe('Killed')
    // Copied after the hook that started the thread, the last hook would wait on it in vain and fail the file.
    expect(run.mutants.find((mutant) => mutant.file === 'src/relay.ts' && mutant.mutator === 'StringLiteral')?.status).toBe('Survived')
  }, 60_000)
})

describe('copies of a worker made one after another', () => {
  it('read the clock as a run of the suite would, and are not made where a test reads another process or thread\'s', () => {
    const report = reportPath('clock')
    // A worker to each file, whose copies come one after another.
    const cli = tool(['--root', fixture('clock'), '--report', report, '--max-workers', '4'])
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const clock: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    // With the clock as it runs, the test that checks how long has passed
    // since the file loaded failed in later copies and was taken to fail now
    // and then. With it standing still, the tests that compare it with a
    // child process's or a worker thread's failed in them the same way.
    expect(clock.flakyTests).toEqual([])
    // `table.test.ts` holds what a test can see of the clocks to what
    // Vitest's main process sees of Node's. With dates whose constructor
    // was Node's `Date` and not the one in its place, both of its tests
    // failed in copies with no mutant on, and 21 mutants were Unconfirmed.
    expect(clock.failedBaselines).toEqual([])
    // Of the runs made with nothing else running, the one that fails is for
    // the mutant that empties `now`, which fails the hook, where no test
    // tried it. Others may pass: before its first test a run waits for
    // Vitest's main process to answer, as in the suite, and on a four-core
    // runner starting four workers that took 1.8 s, past what `is fresh` allows.
    expect(clock.quietRuns.failed).toBe(1)
    const results = path.join(fixture('clock'), 'node_modules/.vitant/session/results')
    const records = fs
      .readdirSync(results)
      .flatMap((name) => fs.readFileSync(path.join(results, name), 'utf8').split('\n'))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { type: string; file: string; clock?: boolean; id?: string; name?: string; mutant?: number; verdict?: string; tests?: string[] })
    const names = new Map(records.filter((record) => record.type === 'test').map((record) => [record.id, record.name] as const))
    // The suite fails only the two mutants that empty a function's body.
    const suite = (mutant: RunResult['mutants'][number]) => (mutant.mutator === 'BlockStatement' ? 'Killed' : 'Survived')
    const passing = new Set(clock.mutants.filter((mutant) => mutant.status !== 'NoCoverage' && suite(mutant) === 'Survived').map((mutant) => mutant.id))
    // With a mutant the suite passes, a run of a file may fail only as on a
    // machine that stalls: out of the time a test is given, or past `is
    // fresh`'s bound. A clock a test can tell from the suite's fails the
    // hook, the table or `apart` in a copy, where a worker passes them.
    const chance = records.filter((record) => record.type === 'whole' && record.verdict !== 'passed' && passing.has(record.mutant!))
    const fresh = (record: (typeof records)[number]) => record.tests?.length && record.tests.every((id) => names.get(id) === 'is fresh')
    expect(chance.filter((record) => record.verdict !== 'timeout' && !fresh(record)).map((record) => `${path.basename(record.file)} ${record.mutant} ${record.tests?.map((id) => names.get(id))}`)).toEqual([])
    // A stall of 7.7 s on a four-core runner timed `labels` out with a mutant
    // the suite passes, and the run of the file alone then passed: that
    // settles nothing, and the mutant is Unconfirmed for a test that wavered
    // or a file that failed by chance, never for a test left out.
    const unsettled = clock.mutants.filter((mutant) => mutant.status === 'Unconfirmed')
    expect(unsettled.filter((mutant) => mutant.leftOut || mutant.confirmed || mutant.besideOnly || !(mutant.wavered || mutant.doubted))).toEqual([])
    if (unsettled.length > 0) expect(chance.length).toBeGreaterThan(0)
    const verdicts = clock.mutants.filter((mutant) => mutant.status !== 'NoCoverage').map((mutant) => `${mutant.file} ${mutant.replacement} ${mutant.status === 'Unconfirmed' ? suite(mutant) : mutant.status}`)
    // The suite passes with `now` asking a child process; in a copy that had
    // stood still for the copies before it, the hook failed.
    expect(verdicts.filter((verdict) => verdict.startsWith('src/asked.ts'))).toEqual(['src/asked.ts {} Killed', 'src/asked.ts true Survived', 'src/asked.ts false Survived'])
    expect(verdicts.filter((verdict) => verdict.startsWith('src/stamp.ts') && !verdict.endsWith(' Survived'))).toEqual(['src/stamp.ts {} Killed'])
    if (!addonTarget()) return
    expect(clock.wholeRuns['copied before load']).toBeGreaterThan(0)
    // libuv's pool, which a worker starts before it copies itself and a copy starts again, is no such thread.
    const clocked = records.filter((record) => record.type === 'early' && record.clock).map((record) => path.basename(record.file))
    expect([...new Set(clocked)].sort()).toEqual(['apart.test.ts', 'asked.test.ts'])
  }, 120_000)
})

describe('mocks a test file clears between its tests, on Vitest 3.2', () => {
  // The fixture resolves Vitest 3.2 from the root's `vitest3`: the mocks the
  // tool holds weakly exist only before Vitest 5, which keeps no Set of them.
  beforeAll(() => {
    const link = path.join(fixture('mocks'), 'node_modules/vitest')
    if (fs.existsSync(link)) return
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(path.join(root, 'node_modules/vitest3'), link, 'junction')
  })

  it('are cleared for every test, so that a test counting calls passes unmutated and fails with a mutant', () => {
    const report = reportPath('mocks')
    const cli = tool(['--root', fixture('mocks'), '--report', report])
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const mocks: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(mocks.vitestVersion).toMatch(/^3\.2\./)
    expect(mocks.failedBaselines).toEqual([])
    const detected = (status: string) => (status === 'Timeout' ? 'Killed' : status)
    expect(mocks.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${detected(m.status)}`)).toEqual([
      // Only the teardown of a fixture scoped to the worker sees these, after the file's tests.
      'src/box.ts:1:56 {} Killed',
      'src/box.ts:2:14 box.value - 1 Killed',
      'src/relay.ts:1:60 {} Killed',
      'src/relay.ts:2:7 "" Killed',
      // Only the last test counts the calls of `burst`.
      'src/relay.ts:5:76 {} Killed',
      'src/relay.ts:6:18 i <= times Killed',
      'src/relay.ts:6:18 i >= times Killed',
      'src/relay.ts:6:18 false Killed',
      'src/relay.ts:6:29 i-- Killed',
      'src/relay.ts:6:39 "" Survived',
    ])
  }, 180_000)
})

// Vitest 3 resolves the path itself and later versions as a module first, both against the root.
describe.each(['vitest3', 'vitest'])('a config named with --config, on %s', (version) => {
  const project = path.join(owner.directory, `config-${version}`)
  beforeAll(() => {
    for (const dir of ['src', 'spec', 'config', 'node_modules']) fs.mkdirSync(path.join(project, dir), { recursive: true })
    fs.symlinkSync(path.join(root, 'node_modules', version), path.join(project, 'node_modules/vitest'), 'junction')
    fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
    // Under the name Vitest looks for: a run that takes it finds no test file.
    fs.writeFileSync(path.join(project, 'vitest.config.mjs'), "export default { test: { include: ['test/**/*.test.ts'] } }\n")
    fs.writeFileSync(path.join(project, 'config/unit.config.mjs'), "export default { test: { include: ['spec/**/*.check.ts'] } }\n")
    fs.writeFileSync(path.join(project, 'src/sign.ts'), 'export function positive(value: number): boolean {\n  return value > 0\n}\n')
    fs.writeFileSync(path.join(project, 'spec/sign.check.ts'), `import { expect, it } from 'vitest'
import { positive } from '../src/sign.ts'
it('tells positive numbers', () => {
  expect(positive(2)).toBe(true)
  expect(positive(-2)).toBe(false)
})
`)
  })

  it('runs the suite that config gives, and none without it', () => {
    const report = reportPath(`config-${version}`)
    const cli = tool(['--root', project, '--config', 'config/unit.config.mjs', '--report', report])
    expect(cli.status, cli.stdout + cli.stderr).toBe(0)
    const run = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    expect(run.vitestVersion).toMatch(version === 'vitest3' ? /^3\./ : /^5\./)
    expect(run.tests).toBe(1)
    expect(run.mutants.map((mutant) => `${mutant.replacement} ${mutant.status}`).sort()).toEqual([
      'false Killed',
      'true Killed',
      'value <= 0 Killed',
      'value >= 0 Survived',
      '{} Killed',
    ])
    const plain = tool(['--root', project, '--report', reportPath(`config-${version}-default`)])
    expect(plain.status).toBe(1)
    expect(plain.stdout).toContain('no test ran')
  }, 120_000)

  it('stops on a config that is not there', () => {
    const cli = tool(['--root', project, '--config', 'config/missing.mjs'])
    expect(cli.status).toBe(2)
    expect(cli.stderr).toContain(`--config: no file ${path.join(fs.realpathSync.native(project), 'config/missing.mjs')}`)
  })
})

// A young generation of another size decides whether a collection lands
// inside a span of work at all: with 64 MB semi-spaces a mutant of n8n's,
// which crashes V8 in a collection under isolated-vm in every run of the
// suite, passed. See "What a worker is given" in docs/design.md.
describe.each(['vitest3', 'vitest'])('the V8 arguments of copied workers, on %s', (version) => {
  const project = path.join(owner.directory, `argv-${version}`)
  const records = path.join(project, 'argv')
  beforeAll(() => {
    for (const dir of ['src', 'test', 'argv', 'node_modules']) fs.mkdirSync(path.join(project, dir), { recursive: true })
    fs.symlinkSync(path.join(root, 'node_modules', version), path.join(project, 'node_modules/vitest'), 'junction')
    fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
    fs.writeFileSync(path.join(project, 'vitest.config.mjs'), "export default { test: { include: ['test/**/*.test.ts'] } }\n")
    fs.writeFileSync(path.join(project, 'src/capped.ts'), 'export function capped(value: number): number {\n  if (value > 100) return 100\n  return value * 2\n}\n')
    fs.writeFileSync(path.join(project, 'test/capped.test.ts'), `import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { capped } from '../src/capped.ts'
it('doubles small values', () => {
  fs.writeFileSync(path.join(process.env.ARGV_RECORDS!, process.pid + '.json'), JSON.stringify(process.execArgv))
  expect(capped(2)).toBe(4)
})
`)
  })

  it.skipIf(!addonTarget())('carry no heap setting of the tool\'s own', () => {
    const report = reportPath(`argv-${version}`)
    const cli = tool(['--root', project, '--report', report], { env: { ...process.env, ARGV_RECORDS: records } })
    expect(cli.status, cli.stdout + cli.stderr).toBe(0)
    const run = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    expect(run.vitestVersion).toMatch(version === 'vitest3' ? /^3\./ : /^5\./)
    const copied = Object.entries(run.wholeRuns).filter(([kind]) => kind.startsWith('copied')).reduce((sum, [, count]) => sum + count, 0)
    expect(copied).toBeGreaterThan(0)
    const argvs = fs.readdirSync(records).map((name) => JSON.parse(fs.readFileSync(path.join(records, name), 'utf8')) as string[])
    expect(argvs.some((argv) => argv.includes('--single-threaded'))).toBe(true)
    expect(argvs.flat().filter((argument) => /semi[-_]space|memory[-_]reducer/.test(argument))).toEqual([])
  }, 120_000)
})

describe('whole-file runs that each hold memory no other process shares', () => {
  // The most runs in copies under way at once, from when each began and ended, and the waits for room.
  const seen = (results: string) => {
    const records = fs
      .readdirSync(results)
      .flatMap((name) => fs.readFileSync(path.join(results, name), 'utf8').split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; by?: string; at: number; ms?: number })
    const edges = records
      .filter((record) => record.type === 'whole' && record.by?.startsWith('copied') && record.ms !== undefined)
      .flatMap((record): [number, number][] => [[record.at - record.ms!, 1], [record.at, -1]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let now = 0
    let most = 0
    for (const [, step] of edges) most = Math.max(most, (now += step))
    return { most, waits: records.filter((record) => record.type === 'room').length }
  }
  const statuses = (run: RunResult) => run.mutants.map((mutant) => `${mutant.location.start.line}:${mutant.location.start.column} ${mutant.replacement} ${mutant.status}`)

  it.skipIf(!addonTarget())('wait for room in the memory they may hold together, and come to the same verdicts', () => {
    const project = fixture('memory')
    const results = path.join(project, 'node_modules/.vitant/session/results')
    const freeReport = reportPath('memory-free')
    const free = tool(['--root', project, '--report', freeReport, '--max-workers', '4'])
    expect(free.status, free.stdout.slice(-2000)).toBe(0)
    // The three files' runs meet where nothing holds them back.
    expect(seen(results).most).toBeGreaterThan(1)
    // Each run holds 160 MB and more besides: 300 MB together leaves room for one.
    const heldReport = reportPath('memory-held')
    const held = tool(['--root', project, '--report', heldReport, '--max-workers', '4', '--memory-mb', '300'])
    expect(held.status, held.stdout.slice(-2000)).toBe(0)
    const limited = seen(results)
    expect(limited.most).toBe(1)
    expect(limited.waits).toBeGreaterThan(0)
    const before = JSON.parse(fs.readFileSync(freeReport, 'utf8')) as RunResult
    const after = JSON.parse(fs.readFileSync(heldReport, 'utf8')) as RunResult
    expect(after.counts.Pending).toBe(0)
    expect(statuses(after)).toEqual(statuses(before))
    expect(after.wholeRuns).toEqual(before.wholeRuns)
  }, 120_000)
})
