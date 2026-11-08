import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(process.env.YAML119_ROOT + '/package.json')
const { VitestTestRunner } = await import(pathToFileURL(require.resolve('vitest/runners')))
function record(phase,test) {
 fs.appendFileSync(process.env.YAML119_EVENTS, JSON.stringify({phase,name:test.name,id:test.id,state:test.result?.state,fails:test.fails,retry:test.retry,repeats:test.repeats,errors:test.result?.errors?.map(error=>({name:error.name,message:error.message,stack:error.stack})),at:Date.now()})+'\n')
}
export default class extends VitestTestRunner {
 async onBeforeRunTask(test) { const result = await super.onBeforeRunTask?.(test); record('before',test); return result }
 async onAfterRunTask(test) { const result = await super.onAfterRunTask?.(test); record('after',test); return result }
}
