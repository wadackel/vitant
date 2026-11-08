import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { getHeapStatistics } from 'node:v8'

const require = createRequire(process.env.SOURCE_EVIDENCE_ROOT + '/package.json')
const { VitestTestRunner } = await import(pathToFileURL(require.resolve('vitest/runners')))
const record = value => fs.appendFileSync(process.env.SOURCE_EVIDENCE_EVENTS, JSON.stringify({ ...value, at: Date.now(), pid: process.pid }) + '\n')
record({ phase: 'worker', node: process.version, execArgv: process.execArgv, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, heapSizeLimit: getHeapStatistics().heap_size_limit })
const taskRecord = (phase, task) => record({ phase, file: task.file?.filepath, id: task.id, name: task.name, state: task.result?.state, flags: { fails: task.fails === true, retry: task.retry ?? null, repeats: task.repeats ?? null }, errors: task.result?.errors?.map(error => ({ name: error.name, message: error.message, stack: error.stack })) ?? [] })

export default class extends VitestTestRunner {
  async onBeforeRunTask(task) {
    await super.onBeforeRunTask?.(task)
    taskRecord('before', task)
  }
  async onAfterRunTask(task) {
    await super.onAfterRunTask?.(task)
    taskRecord('after', task)
  }
}
