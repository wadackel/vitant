import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import { addonTarget } from '../../src/platform.ts'
import type { RunResult } from '../../src/run.ts'

const owner = createE2E('smoke')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

describe('runs copied after the tests before the first to reach the mutant', () => {
  it.skipIf(!addonTarget())('are made, and not where an earlier test wrote a file or the tests run at once', () => {
    const walk = fixture('walk')
    const report = reportPath('walk')
    const cli = tool(['--root', walk, '--report', report])
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const run: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(run.wholeRuns['copied before a test']).toBeGreaterThan(0)
    const results = path.join(walk, 'node_modules/.vitant/session/results')
    const refused = fs
      .readdirSync(results)
      .flatMap((name) => fs.readFileSync(path.join(results, name), 'utf8').split('\n'))
      .filter((line) => line.includes('"type":"walk"'))
      .map((line) => JSON.parse(line) as { file: string; why: string })
      .map((record) => `${path.basename(record.file)} ${record.why}`)
    expect([...new Set(refused)].sort()).toEqual(['inbox.test.ts wrote', 'pair.test.ts concurrent'])
    // Copied once after the first test, the file it leaves is there for one copy and gone for the next.
    expect(run.mutants.find((mutant) => mutant.replacement === 'n / 2')?.status).toBe('Killed')
  }, 60_000)
})

describe('copies of a worker made one after another', () => {
  it('read the clock as a run of the suite would, not later by the copies before them', () => {
    const report = reportPath('clock')
    const cli = tool(['--root', fixture('clock'), '--report', report, '--max-workers', '1'])
    expect(cli.status, cli.stdout.slice(-2000)).toBe(0)
    const clock: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    // With the clock as it runs, the test that checks how long has passed
    // since the file loaded failed in later copies and was taken to fail now
    // and then, and each failure was run again with nothing else running.
    expect(clock.flakyTests).toEqual([])
    expect(clock.quietRuns).toEqual({ failed: 0, passed: 0 })
  }, 60_000)
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
