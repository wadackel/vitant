import fs from 'node:fs'
import path from 'node:path'

const write = (record) => {
  const file = process.env.VITANT_WITNESS_RECORDS
  if (!file) return
  fs.appendFileSync(file, JSON.stringify({ ...record, run: path.basename(process.env.VITANT_TRUTH_ERRORS ?? ''), at: Date.now() }) + '\n')
}

export default class {
  tasks = new Map()

  onCollected(files) {
    const visit = (task, file, names) => {
      const fullName = [...names, task.name].filter(Boolean)
      this.tasks.set(task.id, { file, name: task.name, fullName: fullName.join(' > '), type: task.type })
      for (const child of task.tasks ?? []) visit(child, file, fullName)
    }
    for (const file of files) visit(file, file.filepath, [])
    write({ event: 'collected', files: files.map((file) => file.filepath), tests: [...this.tasks.values()].filter((task) => task.type === 'test').length })
  }

  onTaskUpdate(packs) {
    for (const [id, result] of packs) {
      if (result?.state !== 'fail') continue
      write({ event: 'failed', id, ...this.tasks.get(id), errors: (result.errors ?? []).map((error) => ({ name: error.name, message: error.message, stack: error.stack })) })
    }
  }

  onFinished(_files, errors) {
    write({ event: 'finished', errors: (errors ?? []).map((error) => ({ name: error.name, message: error.message, stack: error.stack })) })
  }

  onTestModuleCollected(module) {
    write({ event: 'collected', files: [module.moduleId], tests: [...module.children.allTests()].length })
  }

  onTestCaseResult(test) {
    const result = test.result()
    if (result.state !== 'failed') return
    write({ event: 'failed', id: test.id, file: test.module.moduleId, name: test.name, fullName: test.fullName,
      errors: (result.errors ?? []).map((error) => ({ name: error.name, message: error.message, stack: error.stack })) })
  }

  onTestRunEnd(modules, errors) {
    this.onFinished(modules, errors)
  }
}
