import fs from 'node:fs'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'

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
  for (const mode of [[], ['--no-clone']]) {
    const report = owner.reportPath(`${version}-${mode.length}`)
    const cli = owner.tool(['--root', project, '--report', report, ...mode], { env: { ...process.env, VITANT_DEBUG: '1' } })
    expect(cli.status, cli.stdout + cli.stderr).toBe(0)
    const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
    expect(result.vitestVersion).toBe(JSON.parse(fs.readFileSync(path.join(vitestPath, 'package.json'), 'utf8')).version)
    expect(result.mutants).toHaveLength(8)
    expect(result.mutants.every((mutant) => mutant.status === 'Survived')).toBe(true)
    const records = fs.readdirSync(path.join(project, 'node_modules/.vitant/session/results'))
      .flatMap((file) => fs.readFileSync(path.join(project, 'node_modules/.vitant/session/results', file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    expect(records.filter((record) => record.type === 'hookObserver').length).toBeGreaterThan(0)
  }
}, 180_000)
