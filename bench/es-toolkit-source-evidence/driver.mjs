import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const offset = (text, [line, column]) => text.split('\n').slice(0, line - 1).reduce((n, value) => n + value.length + 1, 0) + column

export async function withMutation(file, entry, inspect) {
  const original = fs.readFileSync(file, 'utf8')
  assert.equal(hash(original), entry.sourceSha256, 'source hash differs')
  const from = offset(original, entry.start)
  const to = offset(original, entry.end)
  assert.equal(original.slice(from, to), entry.original, 'source range differs')
  const changed = original.slice(0, from) + entry.replacement + original.slice(to)
  try {
    fs.writeFileSync(file, changed)
    return await inspect(changed)
  } finally {
    fs.writeFileSync(file, original)
    assert.equal(hash(fs.readFileSync(file)), entry.sourceSha256, 'source was not restored')
  }
}

export function classify(result, failures, log) {
  const errors = failures.flatMap(event => event.errors ?? [])
  if (errors.some(error => !/timed out|timeout|out of memory|allocation failed/i.test(error.message ?? ''))) return { kind: 'ordinary-test-failure', errors }
  if (errors.some(error => /^(Test|Hook) timed out in \d+ms/.test(error.message ?? ''))) return { kind: 'native-test-deadline', errors }
  if (!result.bounded && result.code !== null && result.code !== 0 && /FATAL ERROR:[\s\S]*JavaScript heap out of memory/.test(log)) return { kind: 'source-worker-oom' }
  return { kind: result.bounded ? 'outer-cap-only' : result.code === 0 ? 'passed' : 'unclassified-exit' }
}

async function main() {
  const [rootArgument, outputArgument, manifestArgument] = process.argv.slice(2)
  assert(rootArgument && outputArgument && manifestArgument, 'Usage: node driver.mjs <isolated-root> <output> <manifest>')
  const root = fs.realpathSync(rootArgument)
  const output = path.resolve(outputArgument)
  const manifest = read(manifestArgument)
  fs.mkdirSync(output, { recursive: true })
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), manifest.targetCommit)
  const require = createRequire(path.join(root, 'package.json'))
  const vitest = require('vitest/package.json').version
  assert.equal(vitest, manifest.vitest)
  const bin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const config = path.join(output, 'capture.config.mjs')
  fs.writeFileSync(config, `import base from ${JSON.stringify(pathToFileURL(path.join(root, manifest.config)).href)}\nexport default {...base,test:{...base.test,runner:${JSON.stringify(path.join(import.meta.dirname, 'capture-runner.mjs'))}}}\n`)
  const files = [...new Set([manifest.mutant.file, manifest.config, 'package.json', 'yarn.lock', ...manifest.cases.map(entry => entry.file)])]
  const hashes = () => Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
  const before = hashes()
  const summary = { targetCommit: manifest.targetCommit, root, node: process.version, platform: process.platform, vitest, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, before, cases: [] }
  const save = () => fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  let active
  let interrupted = false
  const stop = () => { if (active) try { process.kill(-active.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  const interrupt = () => { interrupted = true; stop() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  async function execute(directory, name, entry) {
    assert(!interrupted, 'interrupted')
    const eventsFile = path.join(directory, name + '.events.jsonl')
    const logFile = path.join(directory, name + '.log')
    const reportFile = path.join(directory, name + '.json')
    fs.writeFileSync(eventsFile, '')
    const log = fs.openSync(logFile, 'w')
    const args = [bin, 'run', entry.file, '--config=' + config, '--reporter=json', '--outputFile=' + reportFile]
    const started = performance.now()
    active = spawn(process.execPath, args, { cwd: root, env: { ...process.env, SOURCE_EVIDENCE_ROOT: root, SOURCE_EVIDENCE_EVENTS: eventsFile }, stdio: ['ignore', log, log], detached: true })
    let bounded = false
    const timer = setTimeout(() => { bounded = true; stop() }, manifest.boundMs)
    let exit
    try {
      exit = await new Promise((resolve, reject) => {
        active.once('error', reject)
        active.once('close', (code, signal) => resolve({ code, signal }))
      })
    } finally {
      clearTimeout(timer)
      active = undefined
      fs.closeSync(log)
    }
    const events = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    const result = { ...exit, bounded, boundMs: manifest.boundMs, ms: performance.now() - started, command: [process.execPath, ...args], reportFile, eventsFile, logFile, interrupted }
    const failures = events.filter(event => event.phase === 'after' && event.id === entry.testId && event.state === 'fail')
    result.assessment = classify(result, failures, fs.readFileSync(logFile, 'utf8'))
    fs.writeFileSync(path.join(directory, name + '.result.json'), JSON.stringify(result, null, 2) + '\n')
    return { result, events }
  }
  try {
    save()
    for (const [index, entry] of manifest.cases.entries()) {
      const directory = path.join(output, String(index).padStart(3, '0'))
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'case.json'), JSON.stringify(entry, null, 2) + '\n')
      const control = await execute(directory, 'original', entry)
      assert.equal(control.result.code, 0, 'original exited unsuccessfully')
      assert.equal(control.result.bounded, false)
      const report = read(control.result.reportFile)
      assert(report.success && report.numPassedTests > 0 && report.numFailedTests === 0)
      assert(control.events.some(event => event.phase === 'after' && event.id === entry.testId && event.state === 'pass'), 'requested original test did not pass')
      assert.deepEqual(hashes(), before, 'original run changed tracked evidence files')
      const sourceFile = path.join(root, manifest.mutant.file)
      fs.copyFileSync(sourceFile, path.join(directory, 'source.original.ts'))
      const source = await withMutation(sourceFile, manifest.mutant, async changed => {
        fs.writeFileSync(path.join(directory, 'source.mutated.ts'), changed)
        return execute(directory, 'source', entry)
      })
      const after = hashes()
      assert.deepEqual(after, before, 'evidence files were not restored')
      summary.cases.push({ index, entry, original: control.result, source: source.result, after, restored: true })
      save()
      console.log(JSON.stringify({ index, file: entry.file, source: source.result.assessment, exit: source.result.code, signal: source.result.signal, bounded: source.result.bounded, restored: true }))
    }
  } finally {
    summary.after = hashes()
    summary.restored = JSON.stringify(summary.after) === JSON.stringify(before)
    save()
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main()
