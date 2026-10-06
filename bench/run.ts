// Runs StrykerJS and this tool over the same files of a benchmark target and
// records wall-clock time, mutant counts and how often the verdicts agree.
//
//   node bench/run.ts <target> <scope> [--tool stryker,vitant,vitant-no-clone] [--runs N]
//
// `vitant-no-clone` is this tool starting a worker for every whole-file run.
// Results land in bench/results/<target>-<scope>/. Where bench/truth/ has
// what the suite does with the scope's mutants, each report of this tool is
// checked against it, and a verdict that disagrees fails the run.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { changedLines } from '../src/changed.ts'
import { defaultExclude } from '../src/mutate/generate.ts'
import { projectDir, targets, vitestArgs } from './targets.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tool: { type: 'string', default: 'stryker,vitant' },
    runs: { type: 'string', default: '1' },
  },
})
const [targetName, scopeName] = positionals
const scope = targets[targetName]?.scopes[scopeName]
if (!scope) {
  console.error('usage: node bench/run.ts <target> <scope> [--tool stryker,vitant,vitant-no-clone] [--runs N]')
  process.exit(1)
}

const dir = fs.realpathSync(projectDir(targetName))
const outDir = path.join(import.meta.dirname, 'results', `${targetName}-${scopeName}`)
fs.mkdirSync(outDir, { recursive: true })
const repoRoot = path.dirname(import.meta.dirname)
const tools = new Set(values.tool === 'both' ? ['stryker', 'vitant'] : values.tool.split(','))

interface Timing {
  tool: string
  seconds: number[]
  exitCodes: (number | null)[]
}

function time(tool: string, command: string, args: string[], cwd: string): Timing {
  const timing: Timing = { tool, seconds: [], exitCodes: [] }
  for (let i = 0; i < Number(values.runs); i++) {
    // A run of StrykerJS that failed leaves its copy of the project, tests and all, where the next run finds them.
    fs.rmSync(path.join(dir, '.stryker-tmp'), { recursive: true, force: true })
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
const truth = path.join(import.meta.dirname, 'truth', `${targetName}-${scopeName}.json`)
/** What this tool's reports say besides the verdicts, and whether those hold. */
const reports: Record<string, unknown> = {}
let wrong = false

if (tools.has('stryker')) {
  const config = path.join(dir, `stryker.${scopeName}.json`)
  // StrykerJS has no way to name the Vitest projects to run; it gets a config that holds only those.
  const { projects } = targets[targetName]
  const vitestConfig = path.join(dir, 'vitest.stryker.config.mjs')
  if (projects) {
    const own = ['ts', 'mts', 'js', 'mjs'].map((ext) => `vitest.config.${ext}`).find((name) => fs.existsSync(path.join(dir, name)))
    fs.writeFileSync(
      vitestConfig,
      `import base from './${own}'\n` +
        `const config = await (typeof base === 'function' ? base({ mode: 'test', command: 'serve' }) : base)\n` +
        `const names = ${JSON.stringify(projects)}\n` +
        `export default { ...config, test: { ...config.test, projects: config.test.projects.filter((project) => names.includes(project.test?.name)) } }\n`,
    )
  }
  fs.writeFileSync(
    config,
    JSON.stringify(
      {
        testRunner: 'vitest',
        plugins: ['@stryker-mutator/vitest-runner'],
        ...(projects ? { vitest: { configFile: vitestConfig } } : {}),
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

for (const tool of ['vitant-no-clone', 'vitant']) {
  if (!tools.has(tool)) continue
  const report = path.join(outDir, `${tool}.json`)
  const args = [path.join(repoRoot, 'src/cli.ts'), '--root', dir, '--report', report, ...vitestArgs(targets[targetName])]
  if (tool === 'vitant-no-clone') args.push('--no-clone')
  if ('changed' in scope) args.push('--changed', scope.changed)
  else for (const glob of scope.mutate) args.push('--mutate', glob)
  fs.rmSync(report, { force: true })
  // From the project, as its own scripts run: configs resolve paths against the working directory.
  const timing = time(tool, process.execPath, args, dir)
  timings.push(timing)
  // The tool exits with 1 when it gave up on a test file.
  if (timing.exitCodes.some((code) => code !== 0)) wrong = true
  if (!fs.existsSync(report)) continue
  const { counts, wholeRuns, rounds, abandonedFiles } = JSON.parse(fs.readFileSync(report, 'utf8'))
  reports[tool] = { counts, wholeRuns, rounds, abandonedFiles: abandonedFiles.length }
  if (!fs.existsSync(truth)) continue
  const check = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'truth.ts'), 'check', '--report', report, '--truth', truth],
    { encoding: 'utf8' },
  )
  console.log(`${tool}: ${check.stdout.trim()}`)
  ;(reports[tool] as { truth?: string }).truth = check.stdout.split('\n')[0]
  if (check.status !== 0) wrong = true
}

const summaryPath = path.join(outDir, 'summary.json')
const machine = { platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0].model, cores: os.cpus().length, node: process.version }
// Times taken on another machine do not belong next to these.
const earlier = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : {}
const previous = JSON.stringify(earlier.machine) === JSON.stringify(machine) ? earlier : {}
const summary = {
  ...previous,
  target: targetName,
  scope: scopeName,
  commit: targets[targetName].commit,
  machine,
  timings: { ...previous.timings, ...Object.fromEntries(timings.map((t) => [t.tool, t])) },
  reports: { ...previous.reports, ...reports },
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
process.exit(wrong ? 1 : 0)
