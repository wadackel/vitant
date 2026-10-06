// Runs StrykerJS and this tool over the same files of a benchmark target and
// records wall-clock time, mutant counts and how often the verdicts agree.
//
//   node bench/run.ts <target> <scope> [--tool stryker|vitant|both] [--runs N]
//
// Results land in bench/results/<target>-<scope>/.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { changedLines } from '../src/changed.ts'
import { defaultExclude } from '../src/mutate/generate.ts'
import { projectDir, targets } from './targets.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tool: { type: 'string', default: 'both' },
    runs: { type: 'string', default: '1' },
  },
})
const [targetName, scopeName] = positionals
const scope = targets[targetName]?.scopes[scopeName]
if (!scope) {
  console.error('usage: node bench/run.ts <target> <scope> [--tool stryker|vitant|both] [--runs N]')
  process.exit(1)
}

const dir = fs.realpathSync(projectDir(targetName))
const outDir = path.join(import.meta.dirname, 'results', `${targetName}-${scopeName}`)
fs.mkdirSync(outDir, { recursive: true })
const repoRoot = path.dirname(import.meta.dirname)

interface Timing {
  tool: string
  seconds: number[]
  exitCodes: (number | null)[]
}

function time(tool: string, command: string, args: string[], cwd: string): Timing {
  const timing: Timing = { tool, seconds: [], exitCodes: [] }
  for (let i = 0; i < Number(values.runs); i++) {
    const startedAt = performance.now()
    const log = fs.openSync(path.join(outDir, `${tool}.log`), 'w')
    const result = spawnSync(command, args, { cwd, stdio: ['ignore', log, log] })
    fs.closeSync(log)
    timing.seconds.push(Number(((performance.now() - startedAt) / 1000).toFixed(1)))
    timing.exitCodes.push(result.status)
    console.log(`${tool} run ${i + 1}: ${timing.seconds.at(-1)}s (exit ${result.status})`)
  }
  return timing
}

/** The same mutants for StrykerJS: its `file:start-end` ranges keep a mutant only if it lies inside. */
function strykerMutate(): string[] {
  // StrykerJS mutates whatever the globs match, spec files next to the sources included.
  if (!('changed' in scope)) return [...scope.mutate, ...defaultExclude.map((glob) => `!${glob}`)]
  const patterns: string[] = []
  for (const [file, lines] of changedLines(dir, scope.changed)) {
    const relative = path.relative(dir, file)
    if (!/\.[cm]?[jt]sx?$/.test(relative)) continue
    if (defaultExclude.some((glob) => path.matchesGlob(relative, glob))) continue
    const sorted = [...lines].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; ) {
      let j = i
      while (sorted[j + 1] === sorted[j] + 1) j++
      patterns.push(`${relative}:${sorted[i]}-${sorted[j]}`)
      i = j + 1
    }
  }
  return patterns
}

const timings: Timing[] = []
const strykerReport = path.join(outDir, 'stryker.json')
const vitantReport = path.join(outDir, 'vitant.json')

if (values.tool !== 'vitant') {
  const config = path.join(dir, `stryker.${scopeName}.json`)
  fs.writeFileSync(
    config,
    JSON.stringify(
      {
        testRunner: 'vitest',
        plugins: ['@stryker-mutator/vitest-runner'],
        mutate: strykerMutate(),
        coverageAnalysis: 'perTest',
        // Matches this tool, which does not run mutants that are only
        // evaluated while a module loads.
        ignoreStatic: true,
        reporters: ['json', 'clear-text'],
        clearTextReporter: { reportMutants: false, reportTests: false, logTests: false },
        jsonReporter: { fileName: strykerReport },
        tempDirName: '.stryker-tmp',
      },
      null,
      2,
    ),
  )
  timings.push(time('stryker', 'npx', ['stryker', 'run', config], dir))
}

if (values.tool !== 'stryker') {
  const args = [path.join(repoRoot, 'src/cli.ts'), '--root', dir, '--report', vitantReport]
  if ('changed' in scope) args.push('--changed', scope.changed)
  else for (const glob of scope.mutate) args.push('--mutate', glob)
  // From the project, as its own scripts run: configs resolve paths against the working directory.
  timings.push(time('vitant', process.execPath, args, dir))
}

const summaryPath = path.join(outDir, 'summary.json')
const previous = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : {}
const summary = {
  ...previous,
  target: targetName,
  scope: scopeName,
  commit: targets[targetName].commit,
  machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, node: process.version },
  timings: { ...previous.timings, ...Object.fromEntries(timings.map((t) => [t.tool, t])) },
}
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

if (fs.existsSync(strykerReport) && fs.existsSync(vitantReport)) {
  const compare = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'compare.ts'), strykerReport, vitantReport, '--list'],
    { encoding: 'utf8' },
  )
  fs.writeFileSync(path.join(outDir, 'compare.txt'), compare.stdout)
  console.log(compare.stdout.split('\n').filter((line) => !line.startsWith('packages')).join('\n'))
}
