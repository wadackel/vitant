import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'

const owner = createE2E('cache')
afterAll(() => owner.cleanup())
const { fixture, tool, reportPath } = owner

describe('reusing an earlier run', () => {
  // A copy inside the repository, so that it still resolves the repository's Vitest.
  const copy = path.join(owner.directory, 'incremental')
  const report = path.join(copy, 'report.json')
  const runCopy = () => {
    const cli = tool(['--root', copy, '--incremental', '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const reused = /(\d+) of \d+ test file\(s\) reused/.exec(cli.stderr)
    return { reused: Number(reused?.[1]), result: JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult }
  }
  const statuses = (run: RunResult) => run.mutants.map((m) => `${m.file}:${m.id}:${m.status}:${m.coveredBy}`)

  beforeAll(() => {
    fs.rmSync(copy, { recursive: true, force: true })
    fs.cpSync(fixture('basic'), copy, {
      recursive: true,
      filter: (source) => !source.includes('node_modules'),
    })
  })

  it('gives the same report without running anything when nothing changed', () => {
    const first = runCopy()
    expect(first.reused).toBe(0)
    const second = runCopy()
    expect(second.reused).toBe(39)
    expect(second.result.rounds).toBe(0)
    expect(statuses(second.result)).toEqual(statuses(first.result))
  }, 180_000)

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
    expect(after.reused).toBe(38)
    expect(after.result.counts).toEqual(before.counts)
  }, 180_000)

  it('picks up a new test that kills a mutant the cached run left alive', () => {
    const before = runCopy().result
    expect(before.mutants.some((m) => m.status === 'Survived' && m.replacement === 'value % 2 !== 0')).toBe(true)
    fs.appendFileSync(
      path.join(copy, 'test/math.test.ts'),
      "\nit('tells even from odd', () => {\n  expect(isEven(2)).toBe(true)\n  expect(isEven(3)).toBe(false)\n})\n",
    )
    const after = runCopy()
    expect(after.reused).toBe(38)
    const mutant = after.result.mutants.find((m) => m.replacement === 'value % 2 !== 0')!
    expect(mutant.status).toBe('Killed')
  }, 180_000)
})

describe('a project that keeps transformed modules on disk', () => {
  // Inside the repository, so that it resolves the repository's Vitest; the cache stays in the copy.
  const project = path.join(owner.directory, 'cached')
  const cache = path.join(project, '.vitest-cache')
  const verdicts = (mutate: string[]) => {
    const report = path.join(project, 'report.json')
    const cli = tool(['--root', project, ...mutate.flatMap((file) => ['--mutate', file]), '--report', report])
    expect(cli.status, cli.stderr).toBe(0)
    const run = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    return run.mutants.map((m) => `${m.file}:${m.location.start.line}:${m.location.start.column}:${m.mutator}:${m.replacement}:${m.status}`)
  }

  it('gets the same verdicts after a run that mutated other files as with nothing cached', () => {
    fs.rmSync(project, { recursive: true, force: true })
    fs.cpSync(fixture('basic'), project, { recursive: true, filter: (source) => !source.includes('node_modules') })
    fs.writeFileSync(
      path.join(project, 'vitest.config.ts'),
      "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'], fsModuleCache: true, fsModuleCachePath: '.vitest-cache' } })\n",
    )
    // The first run numbers the sites of words.ts after those of math.ts; the second has words.ts alone.
    verdicts(['src/math.ts', 'src/words.ts'])
    const after = verdicts(['src/words.ts'])
    fs.rmSync(cache, { recursive: true, force: true })
    const fresh = verdicts(['src/words.ts'])
    expect(fresh.some((verdict) => verdict.endsWith(':Killed'))).toBe(true)
    expect(after).toEqual(fresh)
  }, 180_000)
})
