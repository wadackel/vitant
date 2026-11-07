import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const out = process.argv[3]
process.chdir(root)
const require = createRequire(path.join(root, 'package.json'))
const packageEntry = require.resolve('@stryker-mutator/vitest-runner')
const { VitestTestRunner } = await import(pathToFileURL(path.join(path.dirname(packageEntry), 'vitest-test-runner.js')))
const log = { debug(){}, trace(){}, info(){}, warn(...args){console.error(...args)}, error(...args){console.error(...args)}, isDebugEnabled(){return false} }
const runner = new VitestTestRunner({ vitest: { related: true }, disableBail: false }, log, '__stryker__')
const source = path.join(root, 'src/server/budget/base.ts')
const test = path.join(root, 'src/server/budget/base.test.ts')
const timeout = setTimeout(() => { console.error('diagnostic timeout after 120 seconds'); process.exit(124) }, 120000)
const result = { versions: { node: process.version, stryker: require('@stryker-mutator/vitest-runner/package.json').version, vitest: require('vitest/package.json').version } }
try {
  await runner.init()
  result.environment = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST, TEST: process.env.TEST ?? null, ENV: process.env.ENV ?? null }
  result.config = { root: runner.ctx.config.root, pool: runner.ctx.config.pool, maxWorkers: runner.ctx.config.maxWorkers, testTimeout: runner.ctx.config.testTimeout, hookTimeout: runner.ctx.config.hookTimeout, projects: runner.ctx.projects.map(p => ({ root: p.config.root, name: p.config.name, setupFiles: p.config.setupFiles })) }
  const start = performance.now()
  result.dryRun = await runner.dryRun({ files: [source], testFiles: [test], coverageAnalysis: 'perTest', timeout: 60000, disableBail: false })
  result.dryRunMs = performance.now() - start
  console.log('diagnostic dry run', JSON.stringify({status:result.dryRun.status,tests:result.dryRun.tests?.length,ms:result.dryRunMs}))
  if (result.dryRun.status === 'complete') {
    const testFilter = result.dryRun.tests.filter(t => t.status === 0).map(t => t.id)
    result.testFilter = testFilter
    result.mutantRun = await runner.mutantRun({ activeMutant: { id: 'diagnostic-inactive' }, sandboxFileName: source, testFilter, hitLimit: 100000, mutantActivation: 'runtime', reloadEnvironment: false, timeout: 60000, disableBail: false })
    const tasks = []
    const walk = task => { if(task.type === 'test') tasks.push({ name: task.name, fullTestName: task.fullTestName, mode:task.mode, result:task.result }); for(const child of task.tasks ?? []) walk(child) }
    for(const file of runner.ctx.state.getFiles()) walk(file)
    result.mutantTasks = tasks
    console.log('diagnostic mutant run', JSON.stringify(result.mutantRun))
    result.exactNameFilter = tasks.map(t => path.relative(root, test) + '#' + t.fullTestName)
    result.exactNameRun = await runner.mutantRun({ activeMutant: { id: 'diagnostic-inactive' }, sandboxFileName: source, testFilter: result.exactNameFilter, hitLimit: 100000, mutantActivation: 'runtime', reloadEnvironment: false, timeout: 60000, disableBail: false })
    console.log('diagnostic exact-name run', JSON.stringify(result.exactNameRun))
  }
} finally {
  fs.writeFileSync(out, JSON.stringify(result, null, 2))
  await runner.dispose()
  clearTimeout(timeout)
}
