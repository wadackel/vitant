import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBasic } from '../helpers/basic.ts'
import { createE2E } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'

const owner = createE2E('basic-options')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

let result: RunResult
beforeAll(() => {
  result = runBasic(owner).result
}, 180_000)

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

describe('with --fast', () => {
  it('leads only by tests that failed with their file to themselves, and settles failures next to other runs', () => {
    const report = reportPath('fast')
    const cli = tool(['--root', fixture('basic'), '--fast', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const fast: RunResult = JSON.parse(fs.readFileSync(report, 'utf8'))
    expect(fast.counts.Led).toBeGreaterThan(0)
    const kind = (status: string) => (status === 'Timeout' ? 'Killed' : status)
    for (const mutant of fast.mutants) {
      expect(mutant.besideOnly).toBeUndefined()
      const plain = kind(result.mutants[mutant.id].status)
      if (mutant.status === 'Led') {
        expect(mutant.led!.sole).toBe(true)
        expect(['Killed', 'Survived']).toContain(plain)
      } else if (mutant.status === 'Unconfirmed') expect(['Killed', 'Survived']).toContain(plain)
      else expect(`${mutant.id} ${kind(mutant.status)}`).toBe(`${mutant.id} ${plain}`)
    }
    // The delayed test leads to nothing, so its failure is made again alone as without the option.
    const delayed = fast.mutants.find((m) => m.file === 'src/delay.ts' && m.location.start.line === 2 && m.replacement === 'false')!
    expect(kind(delayed.status)).toBe(kind(result.mutants[delayed.id].status))
    const { Killed, Timeout, Led, Survived, Unconfirmed, NoCoverage } = fast.counts
    const score = ((Killed + Timeout + Led) / (Killed + Timeout + Led + Survived + Unconfirmed + NoCoverage)) * 100
    expect(cli.stdout).toContain(`score ${score.toFixed(2)}%`)
    expect(cli.stdout).toMatch(/--fast: \d+ mutant\(s\) failed a test with its file to itself/)
  }, 180_000)
})

describe('in shares', () => {
  it('gives every mutant of two shares merged the verdict of one run of all of them', () => {
    const reports = [1, 2].map((index) => {
      const report = reportPath(`shard-${index}`)
      const cli = tool(['--root', fixture('basic'), '--shard', `${index}/2`, '--report', report])
      expect(cli.status, cli.stderr).toBe(0)
      return report
    })
    const shares: RunResult[] = reports.map((report) => JSON.parse(fs.readFileSync(report, 'utf8')))
    const files = shares.map((share) => new Set(share.mutants.map((m) => m.file)))
    expect([...files[0]].filter((file) => files[1].has(file))).toEqual([])
    expect(shares.every((share) => share.mutants.length > 0)).toBe(true)

    const merged = reportPath('merged')
    const cli = tool(['merge', '--report', merged, ...reports])
    expect(cli.status, cli.stderr).toBe(0)
    const kind = (status: string) => (status === 'Timeout' ? 'Killed' : status)
    const verdicts = (run: RunResult) =>
      run.mutants.map((m) => `${m.id} ${m.file}:${m.location.start.line}:${m.location.start.column} ${m.replacement} ${kind(m.status)}`)
    expect(verdicts(JSON.parse(fs.readFileSync(merged, 'utf8')))).toEqual(verdicts(result))

    // A share left out would leave its mutants out of the score without a word.
    const partial = tool(['merge', '--report', reportPath('partial'), reports[0]])
    expect(partial.status).toBe(2)
    expect(partial.stderr).toContain('2 shares need each of 1, 2 once')
  }, 540_000)
})
