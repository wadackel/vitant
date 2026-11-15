import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBasic } from '../helpers/basic.ts'
import { createE2E } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'

const owner = createE2E('basic-modes')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

let result: RunResult
beforeAll(() => {
  result = runBasic(owner).result
}, 180_000)

describe('running the fixture project', () => {
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
