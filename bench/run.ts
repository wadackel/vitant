// Runs StrykerJS and this tool over the same files of a benchmark target and
// records wall-clock time, mutant counts and how often the verdicts agree.
//
//   node bench/run.ts <target> <scope> [--tool stryker,vitant,vitant-no-clone,vitant-base,vitant-confirm4,vitant-led] [--runs N] [--limit MINUTES]
//
// `--limit` ends a run of this tool that goes on for that long, having first
// written down what its processes were doing (`<tool>.hang.txt`).
// `vitant-no-clone` is this tool starting a worker for every whole-file run.
// `vitant-base` is the tool as another checkout has it, named by VITANT_BASE:
// two commits are compared on one machine, CI runners differing by a third
// from one job to the next.
// `vitant-confirm4` and `vitant-led` are it with `--confirm 4` and with `--led`, held against the scope's report of `vitant`.
// Results land in bench/results/<target>-<scope>/. Where bench/truth/ has
// what the suite does with the scope's mutants, each report of this tool is
// checked against it, and a verdict that disagrees fails the run.

import { spawn, spawnSync } from 'node:child_process'
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
    limit: { type: 'string' },
    records: { type: 'boolean', default: false },
  },
})
const [targetName, scopeName] = positionals
const scope = targets[targetName]?.scopes[scopeName]
if (!scope) {
  console.error('usage: node bench/run.ts <target> <scope> [--tool stryker,vitant,vitant-no-clone,vitant-base,vitant-confirm4,vitant-led] [--runs N] [--limit MINUTES] [--records]')
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
    const limitMs = values.limit && tool !== 'stryker' ? Number(values.limit) * 60_000 : undefined
    // A run that never ends says nothing of why once the job's own limit has
    // ended it: the processes are looked at while they are still there, by a
    // process of its own, this one being held by the run.
    const watcher = limitMs === undefined ? undefined : spawn('sh', ['-c', hangReport(limitMs / 1000, path.join(outDir, `${tool}.hang.txt`))], { detached: true, stdio: 'ignore' })
    watcher?.unref()
    const result = spawnSync(command, args, {
      cwd,
      stdio: ['ignore', log, log],
      timeout: limitMs === undefined ? undefined : limitMs + 120_000,
      killSignal: 'SIGKILL',
      // The log then says what each round was made of.
      env: { ...process.env, VITANT_DEBUG: '1' },
    })
    if (watcher?.pid) {
      try {
        process.kill(-watcher.pid, 'SIGKILL')
      } catch {}
    }
    // What the run had started outlives it where it was ended from outside.
    if (result.signal) spawnSync('pkill', ['-9', '-f', `${dir}/`])
    fs.closeSync(log)
    timing.seconds.push(Number(((performance.now() - startedAt) / 1000).toFixed(1)))
    timing.exitCodes.push(result.status)
    console.log(`${tool} run ${i + 1}: ${timing.seconds.at(-1)}s (exit ${result.status})`)
  }
  return timing
}

/** A shell script that waits and then writes down what every Node process is doing. */
function hangReport(seconds: number, out: string): string {
  const each =
    process.platform === 'darwin'
      ? 'sample "$pid" 1 2>&1 | head -n 120; lsof -p "$pid" 2>/dev/null | awk \'{print $4, $5, $9}\' | grep -vE "dylib|/usr/lib|/System" | head -n 40'
      : 'cat "/proc/$pid/wchan" 2>/dev/null; echo; grep -E "^(State|Threads|VmRSS)" "/proc/$pid/status"; ls -l "/proc/$pid/fd" 2>/dev/null | tail -n +2 | awk \'{print $NF}\' | sort | uniq -c | sort -rn | head -n 15'
  return [
    `sleep ${seconds}`,
    `exec > '${out}' 2>&1`,
    'date',
    'ps -axo pid,ppid,stat,etime,command | grep -E "PID|node" | grep -v grep | cut -c1-260',
    `for pid in $(pgrep node); do echo "== $pid"; ${each}; done`,
  ].join('\n')
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

interface Reported {
  file: string
  mutator: string
  replacement: string
  status: string
  location: { start: { line: number; column: number }; end: { line: number; column: number } }
}
const keyOf = (mutant: Reported) =>
  [mutant.file, mutant.location.start.line, mutant.location.start.column, mutant.location.end.line, mutant.location.end.column, mutant.mutator, mutant.replacement].join('|')
// A mutant that both fails a test and loops is Killed in one run and Timeout in another.
const kind = (status: string) => (status === 'Killed' || status === 'Timeout' ? 'detected' : status)

for (const tool of ['vitant-no-clone', 'vitant-base', 'vitant', 'vitant-confirm4', 'vitant-led']) {
  if (!tools.has(tool)) continue
  const report = path.join(outDir, `${tool}.json`)
  const toolRoot = tool === 'vitant-base' ? process.env.VITANT_BASE : repoRoot
  if (!toolRoot) {
    console.error('vitant-base: VITANT_BASE is to name the checkout of the tool to compare with')
    process.exit(1)
  }
  const args = [path.join(toolRoot, 'src/cli.ts'), '--root', dir, '--report', report, ...vitestArgs(targets[targetName])]
  if (tool === 'vitant-no-clone') args.push('--no-clone')
  if (tool === 'vitant-confirm4') args.push('--confirm', '4')
  if (tool === 'vitant-led') args.push('--led')
  if ('changed' in scope) args.push('--changed', scope.changed)
  else for (const glob of scope.mutate) args.push('--mutate', glob)
  // What the last run of the scope said, to hold this one against. Two runs
  // of one mutant that differ are one of them wrong, whatever changed in
  // between and also where nothing did: the wrong Survived in vue that the
  // stored ground truth had no entry for showed as such a difference first.
  const before = fs.existsSync(report) ? (JSON.parse(fs.readFileSync(report, 'utf8')) as { mutants: Reported[] }).mutants : undefined
  fs.rmSync(report, { force: true })
  // From the project, as its own scripts run: configs resolve paths against the working directory.
  const timing = time(tool, process.execPath, args, dir)
  timings.push(timing)
  // What the workers wrote down goes with a run that went wrong: the report
  // says what came of it, and only this says how. The next run of the
  // project writes over it, and on a CI runner it is gone with the job.
  const records = path.join(outDir, `${tool}-records`)
  fs.rmSync(records, { recursive: true, force: true })
  const copy = () => {
    const made = path.join(dir, 'node_modules/.vitant/session/results')
    if (fs.existsSync(made) && !fs.existsSync(records)) fs.cpSync(made, records, { recursive: true })
  }
  const keep = () => {
    wrong = true
    copy()
  }
  // A run that is only slow went right by every check here, and why it was slow is in the same place.
  if (values.records && tool !== 'stryker') copy()
  // The tool exits with 1 when it gave up on a test file.
  if (timing.exitCodes.some((code) => code !== 0)) keep()
  if (!fs.existsSync(report)) continue
  const { counts, wholeRuns, work, quietRuns, rounds, abandonedFiles, mutants } = JSON.parse(fs.readFileSync(report, 'utf8')) as {
    counts: unknown
    wholeRuns: unknown
    work: unknown
    quietRuns: { failed: number; passed: number }
    rounds: number
    abandonedFiles: string[]
    mutants: Reported[]
  }
  reports[tool] = { counts, wholeRuns, work, quiet: quietRuns.failed + quietRuns.passed, rounds, abandonedFiles: abandonedFiles.length }
  if (tool === 'vitant-confirm4' || tool === 'vitant-led') {
    // A limit leaves runs out and guesses nothing: a mutant is unconfirmed or as the run without the limit has it.
    // A led mutant is held against the same run, by what that run has it as.
    if (!fs.existsSync(vitantReport)) {
      console.log(`${tool}: no report of a run without the limit to compare with`)
      continue
    }
    const full = new Map((JSON.parse(fs.readFileSync(vitantReport, 'utf8')) as { mutants: Reported[] }).mutants.map((mutant) => [keyOf(mutant), mutant.status]))
    const open: Record<string, number> = {}
    const differing = mutants.filter((mutant) => {
      const was = full.get(keyOf(mutant))
      if (was === undefined) return false
      if (mutant.status === 'Unconfirmed' || mutant.status === 'Led') {
        open[kind(was)] = (open[kind(was)] ?? 0) + 1
        return kind(was) !== 'detected' && was !== 'Survived'
      }
      return kind(was) !== kind(mutant.status)
    })
    console.log(`${tool}: ${tool === 'vitant-led' ? 'led' : 'unconfirmed'}, by what the run without the limit has: ${JSON.stringify(open)}; ${differing.length} mutant(s) differ otherwise`)
    for (const mutant of differing.slice(0, 20)) {
      console.log(`  ${mutant.file}:${mutant.location.start.line}:${mutant.location.start.column} ${mutant.mutator}: ${full.get(keyOf(mutant))} without the limit, ${mutant.status} with it`)
    }
    ;(reports[tool] as { unconfirmed?: unknown }).unconfirmed = open
    if (differing.length > 0) keep()
    continue
  }
  if (before) {
    const was = new Map(before.map((mutant) => [keyOf(mutant), mutant.status]))
    const changed = mutants.filter((mutant) => was.has(keyOf(mutant)) && kind(was.get(keyOf(mutant))!) !== kind(mutant.status))
    ;(reports[tool] as { changed?: number }).changed = changed.length
    if (changed.length > 0) {
      console.log(`${tool}: ${changed.length} mutant(s) are not as the last run of this scope had them`)
      for (const mutant of changed.slice(0, 20)) {
        console.log(`  ${mutant.file}:${mutant.location.start.line}:${mutant.location.start.column} ${mutant.mutator} -> ${mutant.replacement.slice(0, 40).replace(/\n/g, ' ')}: ${was.get(keyOf(mutant))} then, ${mutant.status} now`)
      }
    }
  }
  if (!fs.existsSync(truth)) continue
  const check = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'truth.ts'), 'check', '--report', report, '--truth', truth],
    { encoding: 'utf8' },
  )
  console.log(`${tool}: ${check.stdout.trim()}`)
  ;(reports[tool] as { truth?: string }).truth = check.stdout.split('\n')[0]
  if (check.status !== 0) keep()
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
