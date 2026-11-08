import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const append = fs.appendFileSync.bind(fs)
const now = Date.now.bind(Date)
const stringify = JSON.stringify
const pid = process.pid
const events = process.env.YAML_BATCH_EVENTS
const require = createRequire(`${process.env.YAML_BATCH_ROOT}/package.json`)
const { VitestTestRunner } = await import(pathToFileURL(require.resolve('vitest/runners')))

function record(phase, task, kind) {
  const hierarchy = []
  for (let current = task; current; current = current.suite) hierarchy.unshift(current.name)
  append(events, `${stringify({
    phase,
    kind,
    file: task.file?.filepath ?? task.filepath,
    id: task.id,
    name: task.name,
    hierarchy,
    fullName: hierarchy.join(' > '),
    mode: task.mode,
    state: task.result?.state,
    flags: { fails: task.fails === true, retry: task.retry ?? null, repeats: task.repeats ?? null, concurrent: task.concurrent === true },
    errors: (task.result?.errors ?? []).map(error => ({ name: error.name, message: error.message, stack: error.stack, code: error.code })),
    at: now(),
    pid,
  })}\n`)
}

export default class extends VitestTestRunner {
  constructor(...args) {
    super(...args)
    append(events, `${stringify({ phase: 'runner-config', node: process.version, vitest: require('vitest/package.json').version, testTimeout: this.config.testTimeout, hookTimeout: this.config.hookTimeout, fakeTimers: this.config.fakeTimers, at: now(), pid })}\n`)
  }

  async onCollected(files) {
    const result = await super.onCollected?.(files)
    for (const file of files) record('collected', file, 'file')
    return result
  }

  async onBeforeRunTask(test) {
    const result = await super.onBeforeRunTask?.(test)
    record('before', test, 'test')
    return result
  }

  async onAfterRunTask(test) {
    const result = await super.onAfterRunTask?.(test)
    // A later synchronous loop can prevent the parent reporter from receiving this result.
    record('after', test, 'test')
    return result
  }

  async onAfterRunFiles(files) {
    const result = await super.onAfterRunFiles?.(files)
    for (const file of files) record('file-after', file, 'file')
    return result
  }
}
