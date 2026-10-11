// Runs this tool over a few scopes that each take a minute or two and prints
// what every run spent next to whether its verdicts held: a first answer to
// "does this change do less work, and is every verdict as it was" that does
// not wait for the scopes that take an hour or for a quiet machine.
//
//   node bench/tier.ts [<target>:<scope> ...]
//
// The counts say how much there was to do and the seconds how long this
// machine took over it, whatever else it was doing. Exits with 1 when a
// verdict differs from the scope's last run or from bench/truth/.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Each is here for a way of running tests the others do not have, see bench/targets.ts.
const quick = ['ufo:all', 'pinia:pinia', 'zustand:all', 'es-toolkit:array', 'hono:router', 'immer:all']

const scopes = process.argv.length > 2 ? process.argv.slice(2) : quick
const rows: string[][] = [['scope', 's', 'whole runs', 'whole s pass/det', 'trials', 'trial cpu s', 'workers', 'quiet', 'rounds', 'changed', 'truth']]
let wrong = false
for (const name of scopes) {
  const [target, scope] = name.split(':')
  const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'run.ts'), target, scope, '--tool', 'vitant'], { encoding: 'utf8' })
  if (run.status !== 0) wrong = true
  const file = path.join(import.meta.dirname, 'results', `${target}-${scope}`, 'summary.json')
  const summary = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
  const report = summary?.reports?.vitant
  if (run.status === null || !report?.work) {
    wrong = true
    rows.push([name, 'no report'])
    process.stderr.write(run.stdout + run.stderr)
    continue
  }
  if (report.changed) wrong = true
  const seconds = (ms: number) => (ms / 1000).toFixed(0)
  rows.push([
    name,
    String(summary.timings.vitant.seconds.at(-1)),
    String(Object.values<number>(report.wholeRuns).reduce((sum, count) => sum + count, 0)),
    `${seconds(report.work.wholeMs.passed)}/${seconds(report.work.wholeMs.detected)}`,
    String(report.work.trials),
    seconds(report.work.trialCpuMs),
    String(report.work.workers),
    String(report.quiet),
    String(report.rounds),
    String(report.changed ?? ''),
    report.truth?.replace(/^\d+ mutants checked against the suite: /, '') ?? '',
  ])
}
const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)))
for (const row of rows) console.log(row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  '))
process.exit(wrong ? 1 : 0)
