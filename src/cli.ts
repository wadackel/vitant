#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { changedLines } from './changed.ts'
import { defaultExclude, defaultInclude } from './mutate/generate.ts'
import { type MutantStatus, run } from './run.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string', default: process.cwd() },
    mutate: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    changed: { type: 'string' },
    'no-related': { type: 'boolean', default: false },
    'timeout-factor': { type: 'string', default: '4' },
    'timeout-ms': { type: 'string', default: '3000' },
    'recycle-heap-mb': { type: 'string' },
    'loop-factor': { type: 'string', default: '50' },
    'loop-slack': { type: 'string', default: '1000000' },
    'budget-ms': { type: 'string', default: '30000' },
    'cheap-ms': { type: 'string', default: '20' },
    'max-rounds': { type: 'string', default: '50' },
    'max-workers': { type: 'string' },
    incremental: { type: 'boolean', default: false },
    'no-clone': { type: 'boolean', default: false },
    report: { type: 'string' },
  },
})

/**
 * Keeps all workers together within about half of the machine's memory, but
 * never below the point where every heavy test file would need a new worker.
 */
function recycleDefault(): number {
  const workers = Number(values['max-workers'] ?? Math.ceil((os.availableParallelism() * 4) / 3))
  return Math.max(512, Math.min(1536, Math.floor((os.totalmem() / 1024 / 1024) * 0.5 / workers / 1.5)))
}

const root = fs.realpathSync(path.resolve(values.root))
const result = await run({
  root,
  // A diff already names the files, so by default any of them may be mutated.
  include: values.mutate ?? (values.changed ? ['**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'] : defaultInclude),
  exclude: [...defaultExclude, ...(values.exclude ?? [])],
  lines: values.changed ? changedLines(root, values.changed) : undefined,
  filters: positionals,
  related: !values['no-related'],
  timeoutFactor: Number(values['timeout-factor']),
  timeoutMs: Number(values['timeout-ms']),
  recycleHeapMb: Number(values['recycle-heap-mb'] ?? recycleDefault()),
  loopFactor: Number(values['loop-factor']),
  loopSlack: Number(values['loop-slack']),
  budgetMs: Number(values['budget-ms']),
  cheapMs: Number(values['cheap-ms']),
  maxRounds: Number(values['max-rounds']),
  incremental: values.incremental,
  clone: !values['no-clone'],
  // Tests spend a third of their time waiting on timers, so a few more workers than cores keep the CPU busy.
  maxWorkers: Number(values['max-workers'] ?? Math.ceil((os.availableParallelism() * 4) / 3)),
  log: (message) => console.error(message),
})

const { counts } = result
const detected = counts.Killed + counts.Timeout
const covered = detected + counts.Survived
const percent = (part: number, whole: number) =>
  whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(2)}%`

for (const mutant of result.mutants) {
  if (mutant.status !== 'Survived') continue
  const { line, column } = mutant.location.start
  console.log(
    `Survived ${mutant.file}:${line}:${column + 1} ${mutant.mutator} -> ${mutant.replacement.split('\n')[0].slice(0, 60)}`,
  )
}

const order: MutantStatus[] = [
  'Killed',
  'Timeout',
  'Survived',
  'NoCoverage',
  'Static',
  'Pending',
]
console.log(order.map((status) => `${status} ${counts[status]}`).join('  '))
console.log(
  `score ${percent(detected, covered + counts.NoCoverage)} (covered ${percent(detected, covered)})  ` +
    `${result.tests} tests in ${result.testFiles} files, vitest ${result.vitestVersion}`,
)
console.log(
  `time ${(result.timings.totalMs / 1000).toFixed(1)}s ` +
    `(generate ${(result.timings.generateMs / 1000).toFixed(1)}s, run ${(result.timings.vitestMs / 1000).toFixed(1)}s, rounds ${result.rounds})`,
)
{
  const { started, lost, ...copied } = result.wholeRuns
  const copies = copied['copied before load'] + copied['copied after load']
  console.log(
    `whole-file runs ${started + copies}: ${copies} in copies of a worker ` +
      `(${copied['copied before load']} made before the file loaded, ${copied['copied after load']} after), ` +
      `${started} in workers started for them` +
      (lost > 0 ? `; ${lost} copies ended without a verdict and were run again` : ''),
  )
}
if (result.skippedFiles.length > 0) {
  console.log(`${result.skippedFiles.length} file(s) could not be mutated and were left out:`)
  for (const file of result.skippedFiles) console.log(`  ${file}`)
}
if (result.failedBaselines.length > 0) {
  console.log(`${result.failedBaselines.length} test(s) failed without any mutant and were ignored`)
}
if (result.nonRepeatableTests.length > 0) {
  console.log(`${result.nonRepeatableTests.length} test(s) do not pass when re-run in the same worker`)
}
if (result.suiteErrors.length > 0) {
  console.log(`${result.suiteErrors.length} error(s) outside tests:`)
  for (const error of result.suiteErrors.slice(0, 10)) console.log(`  ${error}`)
}
if (result.abandonedFiles.length > 0) {
  console.log(`gave up on ${result.abandonedFiles.length} test file(s):`)
  for (const file of result.abandonedFiles) console.log(`  ${path.relative(root, file)}`)
}

if (values.report) {
  fs.mkdirSync(path.dirname(path.resolve(values.report)), { recursive: true })
  fs.writeFileSync(path.resolve(values.report), JSON.stringify(result, null, 2))
}

// Vitest sets a failing exit code whenever a test fails, which killed mutants
// make routine. Exiting outright, because workers the pool keeps in reserve
// can outlive its shutdown and would hold the process open.
process.exit(result.abandonedFiles.length > 0 ? 1 : 0)
