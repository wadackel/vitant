import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { written } from './literal-helper.ts'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const ordinaryErrors = errors => errors?.length > 0 && errors.every(error =>
  !/timeout|timed out|out of memory|allocation failed|heap limit|worker.*(?:exit|crash|terminat)|ipc|rpc.*(?:closed|timeout)|test run.*abort|cancelled|canceled|SIG(?:KILL|TERM|ABRT)|EPIPE/i.test(`${error.name ?? ''} ${error.code ?? ''} ${error.message ?? ''}`))

export function selectCases(cases, shardIndex, shardCount, ids = new Set()) {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || !Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error('Invalid shard index/count')
  }
  const known = new Set(cases.map(entry => String(entry.mutant.id)))
  for (const id of ids) if (!known.has(id)) throw new Error(`Unknown case ID: ${id}`)
  return cases.map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => index % shardCount === shardIndex && (!ids.size || ids.has(String(entry.mutant.id))))
}

export function classifyCase(entry, original, source) {
  const expected = new Set(entry.expectedTestIds)
  const controlPassed = original.events.filter(event => event.phase === 'after' && event.kind === 'test' && event.state === 'pass' && !event.flags?.fails)
  const passedIds = new Set(controlPassed.map(event => event.id))
  const expectedPassedIds = [...expected].filter(id => passedIds.has(id))
  const failures = source.events.filter(event => event.phase === 'after' && event.kind === 'test' && event.state === 'fail')
  const ordinary = failures.filter(event => !event.flags?.fails && ordinaryErrors(event.errors))
  const matched = ordinary.filter(event => expected.has(event.id) && passedIds.has(event.id))
  const collected = source.events.filter(event => event.phase === 'collected' && event.kind === 'file' && event.state === 'fail')
  const detail = {
    expectedPassedIds,
    expectedNotPassedIds: [...expected].filter(id => !passedIds.has(id)),
    matchedFailures: matched,
    unmatchedFailures: failures.filter(event => !matched.includes(event)),
    collectionFailures: collected,
    expectedWithoutOrdinaryFailure: [...expected].filter(id => !matched.some(event => event.id === id)),
  }
  if (original.bounded || original.signal || original.code !== 0 || original.report?.success !== true || !(original.report.numTotalTests > 0) || original.report.numFailedTests !== 0 || (!entry.fileLevelFailure && expectedPassedIds.length === 0)) {
    return { status: 'control-failed', ...detail }
  }
  if (!entry.fileLevelFailure) return { status: matched.length ? 'verified-named-failure' : 'manual-review', ...detail }
  const loading = !source.bounded && !source.signal && Number.isInteger(source.code) && source.code !== 0 && source.report?.success === false && source.report.numFailedTestSuites > 0 && collected.some(event => ordinaryErrors(event.errors))
  return { status: loading ? 'verified-loading-failure' : 'manual-review', ...detail }
}

async function main() {
  const [rootArgument, outputArgument, manifestArgument] = process.argv.slice(2)
  if (!rootArgument || !outputArgument || !manifestArgument) throw new Error('Usage: batch-check.mjs <root> <outputDir> <manifestPath>; SHARD_INDEX, SHARD_COUNT, CASE_IDS')
  const root = fs.realpathSync(rootArgument)
  const output = path.resolve(outputArgument)
  fs.mkdirSync(output, { recursive: true })
  const manifestBytes = fs.readFileSync(path.resolve(manifestArgument))
  const manifest = JSON.parse(manifestBytes)
  const shardIndex = Number(process.env.SHARD_INDEX ?? 0)
  const shardCount = Number(process.env.SHARD_COUNT ?? 1)
  const ids = new Set((process.env.CASE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean))
  const selected = selectCases(manifest.cases, shardIndex, shardCount, ids)
  const require = createRequire(path.join(root, 'package.json'))
  const bin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const runner = path.join(scriptDirectory, 'batch-runner.mjs')
  const config = path.join(output, 'batch-runner.config.mjs')
  const configSource = path.join(root, manifest.config)
  fs.writeFileSync(config, `import base from ${JSON.stringify(pathToFileURL(configSource).href)}\nexport default { ...base, test: { ...base.test, runner: ${JSON.stringify(runner)}, bail: 0 } }\n`)
  const summary = {
    root, manifest: path.resolve(manifestArgument), manifestSha256: hash(manifestBytes), shardIndex, shardCount,
    ids: [...ids], selectedIndices: selected.map(({ index }) => index), node: process.version,
    vitest: require('vitest/package.json').version, runnerSha256: hash(fs.readFileSync(runner)),
    driverSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), cases: [],
  }
  if (summary.vitest !== manifest.vitest) throw new Error('Vitest version differs from manifest')
  const integrity = () => Object.fromEntries(manifest.integrityFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
  const save = () => fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2))
  let active
  let interrupted
  const stop = () => {
    if (active) try { process.kill(-active.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const interrupt = signal => { interrupted = signal; stop() }
  const onInterrupt = () => interrupt('SIGINT')
  const onTerminate = () => interrupt('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)

  async function execute(directory, name, filter, boundMs, bail = false) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`)
    const eventsPath = path.join(directory, `${name}.events.jsonl`)
    const reportPath = path.join(directory, `${name}.json`)
    const logPath = path.join(directory, `${name}.log`)
    fs.writeFileSync(eventsPath, '')
    fs.rmSync(reportPath, { force: true })
    const log = fs.openSync(logPath, 'w')
    const args = [bin, 'run', filter, `--config=${config}`, '--maxWorkers=1', '--reporter=json', `--outputFile=${reportPath}`, `--bail=${bail ? 1 : 0}`]
    const started = performance.now()
    let bounded = false
    let timer
    let exit
    try {
      active = spawn(process.execPath, args, { cwd: root, env: { ...process.env, YAML_BATCH_ROOT: root, YAML_BATCH_EVENTS: eventsPath }, stdio: ['ignore', log, log], detached: true })
      timer = setTimeout(() => { bounded = true; stop() }, boundMs)
      exit = await new Promise(resolve => {
        active.once('error', error => resolve({ code: null, signal: null, spawnError: String(error) }))
        active.once('close', (code, signal) => resolve({ code, signal }))
      })
    } finally {
      clearTimeout(timer)
      active = undefined
      fs.closeSync(log)
    }
    const parseErrors = []
    const events = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).flatMap((line, index) => {
      try { return [JSON.parse(line)] } catch (error) { parseErrors.push({ line: index + 1, error: String(error) }); return [] }
    })
    let report
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) } catch (error) { parseErrors.push({ report: String(error) }) }
    const result = { name, command: [process.execPath, ...args], cwd: root, ...exit, bounded, boundMs, bail, ms: performance.now() - started, interrupted, eventsPath, reportPath, logPath, parseErrors, events, report }
    const { events: captured, report: reported, ...metadata } = result
    fs.writeFileSync(path.join(directory, `${name}.result.json`), JSON.stringify({ ...metadata, eventCount: captured.length, success: reported?.success, totalTests: reported?.numTotalTests, failedTests: reported?.numFailedTests }, null, 2))
    return result
  }

  try {
    save()
    for (const { entry, index } of selected) {
      const directory = path.join(output, `${String(index).padStart(3, '0')}-${entry.mutant.id}`)
      fs.mkdirSync(directory, { recursive: true })
      const file = path.resolve(root, entry.mutant.file)
      const testFile = path.resolve(root, entry.file)
      if ([file, testFile].some(name => path.relative(root, name).startsWith('..'))) throw new Error('Manifest path escapes target root')
      const source = fs.readFileSync(file, 'utf8')
      const hashes = () => ({ source: hash(fs.readFileSync(file)), test: hash(fs.readFileSync(testFile)), config: hash(fs.readFileSync(configSource)), integrity: integrity() })
      const before = hashes()
      const record = { index, identity: entry.mutant, file: entry.file, expectedTestIds: entry.expectedTestIds, fileLevelFailure: entry.fileLevelFailure, before, directory, restored: false }
      summary.cases.push(record)
      save()
      let changedSource = false
      try {
        if (before.source !== manifest.sourceHashes[entry.mutant.file]) throw new Error('Source hash differs from manifest')
        if (entry.fileLevelFailure ? entry.expectedTestIds.length !== 0 : entry.expectedTestIds.length === 0) throw new Error('Invalid expected-test identity contract')
        const description = { file: entry.mutant.file, start: [entry.mutant.location.start.line, entry.mutant.location.start.column], end: [entry.mutant.location.end.line, entry.mutant.location.end.column], mutator: entry.mutant.mutator, replacement: entry.mutant.replacement }
        const mutated = written(file, source, description)
        record.mutatedSha256 = hash(mutated)
        fs.writeFileSync(path.join(directory, 'source.original.ts'), source)
        fs.writeFileSync(path.join(directory, 'source.mutated.ts'), mutated)
        const original = await execute(directory, 'original', entry.file, 120_000)
        const control = classifyCase(entry, original, { events: [] })
        if (control.status === 'control-failed') {
          record.assessment = control
          throw new Error('Original full-file control failed or expected test ID did not pass')
        }
        if (JSON.stringify(hashes()) !== JSON.stringify(before)) throw new Error('Original control changed source/test/config/setup/package')
        if (interrupted) throw new Error(`Interrupted by ${interrupted}`)
        changedSource = true
        fs.writeFileSync(file, mutated)
        const boundMs = Math.max(180_000, Math.ceil(original.ms * 5))
        const sourceRun = await execute(directory, 'source', entry.file, boundMs)
        record.assessment = classifyCase(entry, original, sourceRun)
        record.original = { ms: original.ms, code: original.code, boundMs: original.boundMs }
        record.source = { ms: sourceRun.ms, code: sourceRun.code, signal: sourceRun.signal, bounded: sourceRun.bounded, boundMs }
        if (hash(fs.readFileSync(file)) !== record.mutatedSha256) throw new Error('Mutant run changed the written source')
        if (sourceRun.bounded && process.env.BAIL_SUPPLEMENT !== '0' && !interrupted) {
          const supplement = await execute(directory, 'source-bail-supplement', entry.file, boundMs, true)
          record.bailSupplement = { ms: supplement.ms, code: supplement.code, signal: supplement.signal, bounded: supplement.bounded }
        }
        if (interrupted) throw new Error(`Interrupted by ${interrupted}`)
      } catch (error) {
        record.fatal = String(error)
      } finally {
        if (changedSource) fs.writeFileSync(file, source)
        record.after = hashes()
        record.restored = JSON.stringify(before) === JSON.stringify(record.after)
        if (!record.restored) record.fatal = 'Source/test/config/setup/package hashes were not restored'
        fs.writeFileSync(path.join(directory, 'case.json'), JSON.stringify(record, null, 2))
        save()
      }
      console.log(JSON.stringify({ index, id: entry.mutant.id, status: record.assessment?.status, restored: record.restored, fatal: record.fatal }))
      if (record.fatal) break
    }
  } catch (error) {
    summary.fatal = String(error)
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    summary.exitCode = summary.fatal || summary.cases.some(record => record.fatal) ? 2 : summary.cases.some(record => record.assessment?.status === 'manual-review') ? 1 : 0
    save()
  }
  process.exitCode = summary.exitCode
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
