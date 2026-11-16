import fs from 'node:fs'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'
import { addonTarget } from '../../src/platform.ts'

const owner = createE2E('hook-deadlines')
afterAll(() => owner.cleanup())

const calculation = `try {
  vm.runInNewContext('finish()', { finish }, { timeout: 1500 })
} catch (error) {
  expect(error.code).toBe('ERR_SCRIPT_EXECUTION_TIMEOUT')
}`

const versions = ['vitest3', 'vitest', 'vitest51'].map((name) => [name, path.join(root, 'node_modules', name)])
if (process.env.VITANT_TEST_VITEST) versions.push(['external', path.resolve(process.env.VITANT_TEST_VITEST)])

it.each(versions)('keeps parallel and completed hook deadlines separate with %s', (version, vitestPath) => {
  const project = path.join(owner.directory, version)
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(path.join(project, 'test'))
  fs.mkdirSync(path.join(project, 'node_modules'))
  fs.symlinkSync(vitestPath, path.join(project, 'node_modules/vitest'), 'junction')
  fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(project, 'vitest.config.mjs'), "export default { test: { hookTimeout: 100, sequence: { hooks: 'parallel' } } }")
  for (const name of ['parallel', 'completed']) {
    fs.writeFileSync(path.join(project, `src/${name}.ts`), 'export function finish() {\n  while (true) { break }\n}\n')
    const hooks = name === 'parallel'
      ? `afterAll(async () => { await new Promise(resolve => setImmediate(resolve)); ${calculation} }, 5000)
afterAll(() => Promise.resolve(), 1000)`
      : `vi.setConfig({ hookTimeout: 10000 })
let complete
afterAll(() => { setTimeout(() => { ${calculation}; complete() }, 100) }, 1000)
afterAll(() => new Promise(resolve => { complete = resolve }), 5000)`
    fs.writeFileSync(path.join(project, `test/${name}.test.ts`), `import vm from 'node:vm'
import { afterAll, expect, it, vi } from 'vitest'
import { finish } from '../src/${name}'
it('collects cleanup', () => expect(typeof finish).toBe('function'))
${hooks}
`)
  }
  fs.copyFileSync(path.join(root, 'fixtures/basic/src/hook-context.ts'), path.join(project, 'src/hook-context.ts'))
  fs.copyFileSync(path.join(root, 'fixtures/basic/test/hook-context.test.ts'), path.join(project, 'test/hook-context.test.ts'))
  for (const mode of [[], ['--no-clone']]) {
    const report = owner.reportPath(`${version}-${mode.length}`)
    const cli = owner.tool(['--root', project, '--report', report, ...mode], { env: { ...process.env, VITANT_DEBUG: '1' } })
    expect(cli.status, cli.stdout + cli.stderr).toBe(0)
    const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    expect(result.vitestVersion).toBe(JSON.parse(fs.readFileSync(path.join(vitestPath, 'package.json'), 'utf8')).version)
    expect(result.mutants).toHaveLength(10)
    expect(result.mutants.every((mutant) => mutant.status === 'Survived')).toBe(true)
    const copied = result.wholeRuns['copied before load'] + result.wholeRuns['copied while loading'] +
      result.wholeRuns['copied after load'] + result.wholeRuns['copied before a test']
    if (mode.length > 0) expect(copied).toBe(0)
    else if (addonTarget()) expect(copied).toBeGreaterThan(0)
    const records = fs.readdirSync(path.join(project, 'node_modules/.vitant/session/results'))
      .flatMap((file) => fs.readFileSync(path.join(project, 'node_modules/.vitant/session/results', file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    expect(records.filter((record) => record.type === 'hookObserver').length).toBeGreaterThan(0)
  }
}, 180_000)

// Before Vitest 5 the hooks put aside for the try that ends a test's loop
// come from `vitest/suite`, from 5 on from the runner; the context's
// `expect` has the same state in each.
it.each(versions)('keeps the hooks and assertions of each try to that try with %s', (version, vitestPath) => {
  const project = path.join(owner.directory, `tries-${version}`)
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(path.join(project, 'test'))
  fs.mkdirSync(path.join(project, 'node_modules'))
  fs.symlinkSync(vitestPath, path.join(project, 'node_modules/vitest'), 'junction')
  fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(project, 'vitest.config.mjs'), 'export default {}')
  for (const name of ['lease', 'tip']) {
    fs.copyFileSync(path.join(root, `fixtures/basic/src/${name}.ts`), path.join(project, `src/${name}.ts`))
    fs.copyFileSync(path.join(root, `fixtures/basic/test/${name}.test.ts`), path.join(project, `test/${name}.test.ts`))
  }
  const report = owner.reportPath(`tries-${version}`)
  const cli = owner.tool(['--root', project, '--report', report])
  expect(cli.status, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
  expect(result.vitestVersion).toBe(JSON.parse(fs.readFileSync(path.join(vitestPath, 'package.json'), 'utf8')).version)
  expect(result.failedBaselines).toEqual([])
  expect(result.nonRepeatableTests).toEqual([])
  expect(result.mutants.map((mutant) => `${mutant.file}:${mutant.location.start.line} ${mutant.replacement} ${mutant.status}`).sort()).toEqual([
    'src/lease.ts:1 {} Killed',
    'src/lease.ts:2 hours / 3 Killed',
    'src/tip.ts:1 {} Killed',
    'src/tip.ts:2 amount * 5 Killed',
  ])
  const records = fs.readdirSync(path.join(project, 'node_modules/.vitant/session/results'))
    .flatMap((file) => fs.readFileSync(path.join(project, 'node_modules/.vitant/session/results', file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .filter((record) => record.type === 'test')
  expect(records.filter((record) => record.baseline === 'fail' || record.nonRepeatable || record.needsReplay)).toEqual([])
}, 180_000)

// Inline: the main process sets every project to update no snapshot.
// Before Vitest 3.2 there is no `projects`, and the tool puts no mutant into
// a project declared under `workspace`: there the root project is the one.
it.each(versions)('leaves a snapshot file of an inline project, or before Vitest 3.2 of the root one, as it was, with %s', (version, vitestPath) => {
  const project = path.join(owner.directory, `snapshot-${version}`)
  const snap = 'test/__snapshots__/copies.test.ts.snap'
  const [major, minor] = (JSON.parse(fs.readFileSync(path.join(vitestPath, 'package.json'), 'utf8')).version as string).split('.').map(Number)
  const inline = major > 3 || minor >= 2 ? "projects: [{ extends: true, test: { name: 'inline' } }]" : ''
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(path.join(project, 'test/__snapshots__'), { recursive: true })
  fs.mkdirSync(path.join(project, 'node_modules'))
  fs.symlinkSync(vitestPath, path.join(project, 'node_modules/vitest'), 'junction')
  fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(project, 'vitest.config.ts'), `import { defineConfig } from 'vitest/config'\n\nexport default defineConfig({ test: { ${inline} } })\n`)
  for (const file of ['src/copies.ts', 'test/copies.test.ts', snap]) fs.copyFileSync(path.join(root, 'fixtures/basic', file), path.join(project, file))
  const report = owner.reportPath(`snapshot-${version}`)
  const cli = owner.tool(['--root', project, '--mutate', 'src/copies.ts', '--report', report], { timeout: 100_000 })
  expect(cli.status, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
  expect(result.vitestVersion).toBe(JSON.parse(fs.readFileSync(path.join(vitestPath, 'package.json'), 'utf8')).version)
  expect(result.mutants.find((mutant) => mutant.replacement === 'count <= 1')?.status).toBe('Killed')
  expect(fs.readFileSync(path.join(project, snap), 'utf8')).toBe(fs.readFileSync(path.join(root, 'fixtures/basic', snap), 'utf8'))
}, 120_000)
