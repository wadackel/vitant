import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'
import { addonTarget } from '../../src/platform.ts'

const owner = createE2E('process-listeners')
afterAll(() => owner.cleanup())

const versions = ['vitest3', 'vitest', 'vitest51'].map((name) => [name, path.join(root, 'node_modules', name)])
if (process.env.VITANT_TEST_VITEST) versions.push(['external', path.resolve(process.env.VITANT_TEST_VITEST)])
const modes = [['default', []], ['no-clone', ['--no-clone']], ['strict', ['--strict']]] as const

it.each(versions.flatMap(([version, vitestPath]) => modes.map(([name, mode]) => [version, name, vitestPath, mode] as const)))('preserves application listener identity and delivery with %s in %s mode', (version, name, vitestPath, mode) => {
  const project = path.join(owner.directory, version)
  if (!fs.existsSync(project)) {
    for (const directory of ['src', 'test', 'node_modules']) fs.mkdirSync(path.join(project, directory), { recursive: true })
    fs.symlinkSync(vitestPath, path.join(project, 'node_modules/vitest'), 'junction')
    fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
    for (const file of ['src/process-listeners.ts', 'test/process-listeners.test.ts']) {
      fs.copyFileSync(path.join(root, 'fixtures/basic', file), path.join(project, file))
    }
  }
  const report = owner.reportPath(`listeners-${version}-${name}`)
  const cli = owner.tool(['--root', project, '--mutate', 'src/process-listeners.ts',
    '--report', report, ...mode, 'test/process-listeners.test.ts'])
  expect(cli.status, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
  expect(result.vitestVersion).toBe(JSON.parse(fs.readFileSync(path.join(vitestPath, 'package.json'), 'utf8')).version)
  expect(result.abandonedFiles).toEqual([])
  expect(result.mutants).toHaveLength(10)
  expect(result.mutants.filter((mutant) => mutant.status === 'Killed')).toHaveLength(2)
  expect(result.mutants.filter((mutant) => mutant.status === 'Survived')).toHaveLength(8)
  const copied = result.wholeRuns['copied before load'] + result.wholeRuns['copied while loading'] +
    result.wholeRuns['copied after load'] + result.wholeRuns['copied before a test']
  if (name === 'no-clone') expect(copied).toBe(0)
  else if (addonTarget()) expect(copied).toBeGreaterThan(0)
}, 60_000)

const errors = ['rejection', 'exception'] as const
it.each(versions.flatMap(([version, vitestPath]) => errors.flatMap((kind) => [false, true].map((ignored) => [version, kind, ignored, vitestPath] as const))))('matches source-written %s %s with ignored=%s', (version, kind, ignored, vitestPath) => {
  const name = `${version}-${kind}-${ignored}`
  const project = path.join(owner.directory, name)
  for (const directory of ['src', 'test', 'node_modules']) fs.mkdirSync(path.join(project, directory), { recursive: true })
  fs.symlinkSync(vitestPath, path.join(project, 'node_modules/vitest'), 'junction')
  fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(project, 'vitest.config.mjs'), `export default { test: { dangerouslyIgnoreUnhandledErrors: ${ignored} } }`)
  fs.writeFileSync(path.join(project, 'src/error.ts'), 'export function fire() { return false }\n')
  const fail = kind === 'rejection' ? "void Promise.reject(new Error('unhandled mutation'))" : "throw new Error('unhandled mutation')"
  fs.writeFileSync(path.join(project, 'test/error.test.ts'), `import { it } from 'vitest'
import { fire } from '../src/error'
it('waits for asynchronous work', async () => {
  setImmediate(() => { if (fire()) { ${fail} } })
  await new Promise(resolve => setTimeout(resolve, 20))
})
`)
  const reports = []
  const results: RunResult[] = []
  for (const mode of [[], ['--no-clone']]) {
    const report = owner.reportPath(`${name}-${mode.length}`)
    const cli = owner.tool(['--root', project, '--report', report, ...mode])
    expect(cli.status, cli.stdout + cli.stderr).toBe(0)
    const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    reports.push(report)
    results.push(result)
  }
  const truth = spawnSync(process.execPath, [path.join(root, 'bench/truth.ts'), 'make', '--root', project,
    '--report', reports[0], '--out', owner.reportPath(`${name}-truth`)], { cwd: root, encoding: 'utf8', timeout: 60_000 })
  fs.writeFileSync(path.join(owner.reports, `${name}-truth.log`), truth.stdout + truth.stderr)
  expect(truth.status, truth.stdout + truth.stderr).toBe(0)
  for (const result of results) {
    expect(result.mutants).toHaveLength(2)
    expect(result.mutants.find((mutant) => mutant.replacement === '{}')?.status).toBe('Survived')
    expect(result.mutants.find((mutant) => mutant.replacement === 'true')?.status).toBe(ignored ? 'Survived' : 'Killed')
  }
}, 120_000)

it.each(versions.flatMap(([version, vitestPath]) => modes.map(([name, mode]) => [version, name, vitestPath, mode] as const)))('keeps a loop interruption as Timeout with %s in %s mode', (version, name, vitestPath, mode) => {
  const project = path.join(owner.directory, `loop-${version}-${name}`)
  for (const directory of ['src', 'test', 'node_modules']) fs.mkdirSync(path.join(project, directory), { recursive: true })
  fs.symlinkSync(vitestPath, path.join(project, 'node_modules/vitest'), 'junction')
  fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
  for (const file of ['src/uncaught-loop.ts', 'test/uncaught-loop.test.ts']) {
    fs.copyFileSync(path.join(root, 'fixtures/basic', file), path.join(project, file))
  }
  const report = owner.reportPath(`loop-${version}-${name}`)
  const cli = owner.tool(['--root', project, '--mutate', 'src/uncaught-loop.ts',
    '--report', report, ...mode, 'test/uncaught-loop.test.ts'])
  expect(cli.status, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
  expect(result.abandonedFiles).toEqual([])
  expect(result.mutants.find((mutant) => mutant.replacement === 'true')?.status).toBe('Timeout')
  expect(result.mutants.find((mutant) => mutant.replacement === '{}')?.status).toBe('Survived')
}, 60_000)
