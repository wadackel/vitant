import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'

const owner = createE2E('pool-argv')
afterAll(() => owner.cleanup())

const versions = ['vitest3', 'vitest', 'vitest51'].map((name) => [name, path.join(root, 'node_modules', name)])
if (process.env.VITANT_TEST_VITEST) versions.push(['external', path.resolve(process.env.VITANT_TEST_VITEST)])

/**
 * How a project gives the workers of a pool a flag, in the form the version
 * reads, and the fixture's test that needs it: Node refuses `--expose-gc` for
 * a worker thread, so the pools of threads are given `--no-deprecation`.
 */
type Shape = { name: string; config: (major: number, minor: number) => object; needs: 'collect' | 'quiet' }
const shapes: Shape[] = [
  {
    name: 'forks',
    config: (major) => major < 4
      ? { test: { poolOptions: { forks: { execArgv: ['--expose-gc'] } } } }
      : { test: { execArgv: ['--expose-gc'] } },
    needs: 'collect',
  },
  {
    // Before Vitest 4 a project takes its pool's arguments from the root's
    // `poolOptions`, and from Vitest 4 its own, as SvelteKit gives them.
    // Before 3.2 there is no `projects`, and the root runs on vmForks.
    name: 'a project on vmForks',
    config: (major, minor) => major < 4
      ? { test: { poolOptions: { vmForks: { execArgv: ['--expose-gc'] } }, ...(minor < 2 ? { pool: 'vmForks' } : { projects: [{ test: { name: 'gc', pool: 'vmForks' } }] }) } }
      : { test: { projects: [{ test: { name: 'gc', pool: 'vmForks', execArgv: ['--expose-gc'] } }] } },
    needs: 'collect',
  },
  {
    name: 'threads',
    config: (major) => major < 4
      ? { test: { pool: 'threads', poolOptions: { threads: { execArgv: ['--no-deprecation'] } } } }
      : { test: { pool: 'threads', execArgv: ['--no-deprecation'] } },
    needs: 'quiet',
  },
  {
    name: 'vmThreads',
    config: (major) => major < 4
      ? { test: { pool: 'vmThreads', poolOptions: { vmThreads: { execArgv: ['--no-deprecation'] } } } }
      : { test: { pool: 'vmThreads', execArgv: ['--no-deprecation'] } },
    needs: 'quiet',
  },
]

it.each(versions.flatMap(([version, vitestPath]) => shapes.map((shape) => [version, shape.name, vitestPath, shape] as const)))('gives the workers the arguments the project gives its pool, with %s on %s', (version, name, vitestPath, shape) => {
  const vitestVersion: string = JSON.parse(fs.readFileSync(path.join(vitestPath, 'package.json'), 'utf8')).version
  const [major, minor] = vitestVersion.split('.').map(Number)
  const slug = `${version}-${name.replaceAll(' ', '-')}`
  const project = path.join(owner.directory, slug)
  for (const directory of ['src', 'test', 'node_modules']) fs.mkdirSync(path.join(project, directory), { recursive: true })
  fs.symlinkSync(vitestPath, path.join(project, 'node_modules/vitest'), 'junction')
  fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(project, 'vitest.config.mjs'), `export default ${JSON.stringify(shape.config(major, minor))}\n`)
  for (const file of [`src/${shape.needs}.ts`, `test/${shape.needs}.test.ts`]) fs.copyFileSync(path.join(root, 'fixtures/basic', file), path.join(project, file))
  // The suite passes, so a test that fails in the tool's runs with no mutant on fails for want of the flag.
  const plain = spawnSync(process.execPath, [path.join(vitestPath, 'vitest.mjs'), 'run'], { cwd: project, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  expect(plain.status, plain.stdout + plain.stderr).toBe(0)
  const report = owner.reportPath(slug)
  const cli = owner.tool(['--root', project, '--max-workers', '2', '--report', report])
  expect(cli.status, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
  expect(result.vitestVersion).toBe(vitestVersion)
  expect(result.failedBaselines).toEqual([])
  expect(result.mutants.length).toBeGreaterThan(0)
  expect(result.mutants.filter((mutant) => mutant.status === 'NoCoverage')).toEqual([])
  expect(result.mutants.filter((mutant) => mutant.status === 'Killed').length).toBeGreaterThan(0)
}, 120_000)
