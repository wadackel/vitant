// Holds this tool at one commit against another over a fixed set of scopes,
// as the compare workflow runs it, and lists every mutant whose verdict moved.
//
//   node bench/moves.ts plan [--scopes 'target:scope[:shards] ...'] [--macos]
//   node bench/moves.ts check --plan <jobs.json> <dir>
//
// `plan` prints `jobs=<JSON>` for the workflow's matrix: the set below, or
// the scopes given, each on Linux with copies in as many shards as given.
// `check` reads what every job of the plan left under <dir>, one directory a
// job named as the job's `artifact`, merges each tool's shares, matches the
// base's mutants with the head's by file, start, end, mutator and replacement,
// and prints Markdown: every mutant that moved, and each merged report held
// against bench/truth/. It exits with 1 where a mutant moved between detected
// and undetected, unless the stored ground truth explains the mutant's verdict,
// a report disagrees with the suite, or a job left no report.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { mergeReports } from '../src/merge.ts'
import type { MutantResult, RunResult } from '../src/run.ts'
import { targets } from './targets.ts'

/** How the two commits are run: with copies, or with `--no-clone`, the path of platforms without the addon. */
export type Path = 'copies' | 'no-clone'

export interface Slot {
  target: string
  scope: string
  shards: number
  runner: string
  path: Path
  /**
   * Base and head in jobs of their own, for a scope one tool run of which
   * takes most of the time a job has: they then run on two processors, and a
   * move between Killed or Survived and Timeout may be the processor's.
   */
  apart?: boolean
}

export interface Job {
  name: string
  artifact: string
  target: string
  scope: string
  shard: string
  runner: string
  tools: string
}

const linux = 'ubuntu-24.04'
const macos = 'macos-15'

/**
 * The scopes a change to the runner, the planning, the addon or the
 * instrumentation is held to by default, chosen by what each one's runs go
 * through rather than by size; docs/development.md says what the rest of the
 * benchmark can show that these cannot. Each tool run of a shard is meant to
 * take ten minutes or less on a four-core Linux runner, so that a job with
 * both commits ends within about twenty-five. The longest come first, as the
 * runners take the matrix in order.
 */
export const defaultSet: Slot[] = [
  // Timeouts (174 of 737), in one file that cannot be split; macOS's three processors and its addon.
  { target: 'yaml', scope: 'lexer', shards: 1, runner: macos, path: 'copies' },
  // Many small files with timeouts and the copy made before a test; macOS again.
  { target: 'es-toolkit', scope: 'array', shards: 1, runner: macos, path: 'copies' },
  // Files run only in copies made before they load (child processes, native threads), Vitest projects;
  // two wrong verdicts of the last fixes showed here first. Its mutants are nearly all in one file.
  { target: 'n8n', scope: 'proxy', shards: 1, runner: linux, path: 'copies', apart: true },
  // An application suite: copies refused for native threads and open descriptors, many Static mutants.
  { target: 'formbricks', scope: 'utils', shards: 3, runner: linux, path: 'copies' },
  // Timeouts, Unconfirmed and explained mutants in 39 files; a wrong Survived of the last fixes showed here.
  { target: 'h3', scope: 'utils', shards: 3, runner: linux, path: 'copies' },
  // An application suite that reads Date, with the most Static mutants.
  { target: 'umami', scope: 'lib', shards: 3, runner: linux, path: 'copies' },
  // Copies made before load, timeouts, Unconfirmed and explained mutants, Vitest 5.
  { target: 'sveltekit', scope: 'server', shards: 2, runner: linux, path: 'copies' },
  // Vitest 3.2, workers started for whole-file runs, timeouts.
  { target: 'xstate', scope: 'core', shards: 1, runner: linux, path: 'copies' },
  // Files whose verdicts are unsure: most of the Unconfirmed mutants of the benchmark.
  { target: 'vue', scope: 'reactivity', shards: 1, runner: linux, path: 'copies' },
  // Vitest 3.2 and started workers again, many Static mutants.
  { target: 'immer', scope: 'all', shards: 1, runner: linux, path: 'copies' },
  // Lines a change touched (`--changed`) rather than globs.
  { target: 'es-toolkit', scope: 'pr', shards: 1, runner: linux, path: 'copies' },
  // Without copies: two wrong verdicts of the last fixes were on this path alone.
  { target: 'hono', scope: 'router', shards: 1, runner: linux, path: 'no-clone' },
  { target: 'immer', scope: 'all', shards: 1, runner: linux, path: 'no-clone' },
  { target: 'es-toolkit', scope: 'array', shards: 1, runner: linux, path: 'no-clone' },
]

const toolsOf = (path: Path) => (path === 'copies' ? { base: 'vitant-base', head: 'vitant' } : { base: 'vitant-no-clone-base', head: 'vitant-no-clone' })

const slotName = (slot: Slot) => `${slot.target} ${slot.scope} (${slot.runner}, ${slot.path})`

export function jobsOf(slots: Slot[]): Job[] {
  return slots.flatMap((slot) => {
    const { base, head } = toolsOf(slot.path)
    const sides = slot.apart ? [{ tools: base, side: 'base' }, { tools: head, side: 'head' }] : [{ tools: `${base},${head}`, side: '' }]
    return Array.from({ length: slot.shards }, (_, i) => i + 1).flatMap((index) =>
      sides.map(({ tools, side }) => ({
        name: `${slot.target} ${slot.scope} (${slot.runner}, ${slot.path}${side ? `, ${side}` : ''}, ${index}/${slot.shards})`,
        artifact: `compare-${slot.target}-${slot.scope}-${slot.runner}-${slot.path}${side ? `-${side}` : ''}-${index}of${slot.shards}`,
        target: slot.target,
        scope: slot.scope,
        shard: `${index}/${slot.shards}`,
        runner: slot.runner,
        tools,
      })),
    )
  })
}

/** The set, or the scopes given as `target:scope[:shards]`, each checked against bench/targets.ts. */
export function planSlots(scopes: string, withMacos: boolean): Slot[] {
  const given = scopes.split(/\s+/).filter(Boolean)
  const slots = given.length === 0
    ? defaultSet.filter((slot) => withMacos || slot.runner !== macos)
    : given.map((entry): Slot => {
        const [target, scope, shards = '1'] = entry.split(':')
        if (!/^[1-9]\d*$/.test(shards)) throw new Error(`${entry}: shards must be a whole number above 0`)
        return { target, scope, shards: Number(shards), runner: linux, path: 'copies' }
      })
  for (const slot of slots) {
    if (!targets[slot.target]?.scopes[slot.scope]) throw new Error(`no scope ${slot.target} ${slot.scope} in bench/targets.ts`)
  }
  return slots
}

/** The slots a plan's jobs came from, read back from the jobs. */
function slotsOf(jobs: Job[]): { slot: Slot; jobs: Job[] }[] {
  const groups = new Map<string, { slot: Slot; jobs: Job[] }>()
  for (const job of jobs) {
    const path: Path = job.tools.includes('no-clone') ? 'no-clone' : 'copies'
    const slot: Slot = { target: job.target, scope: job.scope, shards: Number(job.shard.split('/')[1]), runner: job.runner, path, apart: !job.tools.includes(',') }
    const key = slotName(slot)
    if (!groups.has(key)) groups.set(key, { slot, jobs: [] })
    groups.get(key)!.jobs.push(job)
  }
  return [...groups.values()]
}

const detected = (status: string) => status === 'Killed' || status === 'Timeout'
const undetected = (status: string) => status === 'Survived' || status === 'NoCoverage'

export type Move = 'detection' | 'explained' | 'without a verdict' | 'killed or timeout' | 'survived or no coverage'

/** What a change of status between the two commits says; undefined where it did not change. */
export function moveOf(was: string, now: string): Move | undefined {
  if (was === now) return undefined
  if ((detected(was) && undetected(now)) || (undetected(was) && detected(now))) return 'detection'
  if (detected(was) && detected(now)) return 'killed or timeout'
  if (undetected(was) && undetected(now)) return 'survived or no coverage'
  return 'without a verdict'
}

const keyOf = (mutant: Pick<MutantResult, 'file' | 'location' | 'mutator' | 'replacement'>) =>
  JSON.stringify([mutant.file, mutant.location.start.line, mutant.location.start.column, mutant.location.end.line, mutant.location.end.column, mutant.mutator, mutant.replacement])

export interface Moved {
  mutant: MutantResult
  was: string
  move: Move
}

/**
 * Every mutant of both reports whose status differs, and the mutants only one
 * of them has. A move between detected and undetected of a mutant that
 * `explained` names, the stored ground truth's entries with a note, is
 * listed apart without failing: the suite was run by hand for it, and the
 * note says why this tool's verdict differs from the suite's in some runs.
 */
export function movesBetween(base: RunResult, head: RunResult, explained = new Set<string>()): { moved: Moved[]; onlyBase: number; onlyHead: number } {
  const before = new Map(base.mutants.map((mutant) => [keyOf(mutant), mutant]))
  const moved: Moved[] = []
  let onlyHead = 0
  for (const mutant of head.mutants) {
    const was = before.get(keyOf(mutant))
    if (!was) {
      onlyHead++
      continue
    }
    before.delete(keyOf(mutant))
    const move = moveOf(was.status, mutant.status)
    if (move) moved.push({ mutant, was: was.status, move: move === 'detection' && explained.has(keyOf(mutant)) ? 'explained' : move })
  }
  return { moved, onlyBase: before.size, onlyHead }
}

interface StoredEntry {
  file: string
  start: [number, number]
  end: [number, number]
  mutator: string
  replacement: string
  note?: string
}

interface Summary {
  machine: { cpu: string }
  timings: Record<string, { seconds: number[]; exitCodes: (number | null)[] }>
}

const read = <T>(file: string): T | undefined => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : undefined)

const order: Move[] = ['detection', 'explained', 'without a verdict', 'killed or timeout', 'survived or no coverage']
const heading: Record<Move, string> = {
  detection: 'Between detected and undetected',
  explained: 'Between detected and undetected, of a mutant whose verdict bench/truth/ explains',
  'without a verdict': 'To or from a status without a verdict (Static, Unconfirmed, Led, Pending)',
  'killed or timeout': 'Between Killed and Timeout, benign',
  'survived or no coverage': 'Between Survived and NoCoverage, which the suite passes alike',
}

const where = (mutant: MutantResult) =>
  `${mutant.file}:${mutant.location.start.line}:${mutant.location.start.column + 1} ${mutant.mutator} \`${mutant.replacement.slice(0, 40).replace(/\s+/g, ' ').replace(/`/g, "'")}\``

function check(jobs: Job[], dir: string): boolean {
  const lines: string[] = []
  let problems = 0
  let detections = 0
  let explainedMoves = 0
  const groups = slotsOf(jobs)
  for (const { slot, jobs: slotJobs } of groups) {
    const { base: baseTool, head: headTool } = toolsOf(slot.path)
    lines.push(`### ${slotName(slot)}, ${slot.shards} shard${slot.shards === 1 ? '' : 's'}${slot.apart ? ', base and head on two runners' : ''}`, '')
    const shares: Record<string, RunResult[]> = { [baseTool]: [], [headTool]: [] }
    const cpus: Record<string, string[]> = { [baseTool]: [], [headTool]: [] }
    const seconds: Record<string, number> = { [baseTool]: 0, [headTool]: 0 }
    const missing: string[] = []
    for (const job of slotJobs) {
      const at = path.join(dir, job.artifact)
      const summary = read<Summary>(path.join(at, 'summary.json'))
      for (const tool of job.tools.split(',')) {
        const report = read<RunResult>(path.join(at, `${tool}.json`))
        const timing = summary?.timings[tool]
        if (!report || !timing) {
          missing.push(`${job.name}: no ${!summary ? 'results' : `report of ${tool}`}`)
          continue
        }
        if (timing.exitCodes.some((code) => code !== 0)) missing.push(`${job.name}: ${tool} exited with ${timing.exitCodes.join(', ')}`)
        if (report.counts.Pending > 0) missing.push(`${job.name}: ${tool} left ${report.counts.Pending} mutant(s) pending`)
        shares[tool].push(report)
        cpus[tool].push(summary.machine.cpu)
        seconds[tool] = Math.max(seconds[tool], ...timing.seconds)
      }
    }
    if (missing.length > 0) {
      problems += missing.length
      lines.push(...missing.map((line) => `- **${line}**`), '')
    }
    if (shares[baseTool].length < slot.shards || shares[headTool].length < slot.shards) {
      lines.push('Not compared: a share of one commit is missing.', '')
      continue
    }
    const merged = { [baseTool]: mergeReports(shares[baseTool]), [headTool]: mergeReports(shares[headTool]) }
    const truthFile = path.join(import.meta.dirname, 'truth', `${slot.target}-${slot.scope}.json`)
    const truth: Record<string, string> = {}
    for (const tool of [baseTool, headTool]) {
      const file = path.join(dir, 'merged', `${slot.target}-${slot.scope}-${slot.runner}-${slot.path}`, `${tool}.json`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(merged[tool]))
      if (!fs.existsSync(truthFile)) {
        truth[tool] = 'no ground truth stored'
        continue
      }
      const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'truth.ts'), 'check', '--report', file, '--truth', truthFile], { encoding: 'utf8' })
      truth[tool] = run.stdout.trim().split('\n').map((line) => line.trimEnd()).join('<br>')
      if (run.status !== 0) {
        problems++
        truth[tool] = `**${truth[tool] || run.stderr.trim()}**`
      }
    }
    const counts = (report: RunResult) => Object.entries(report.counts).filter(([, count]) => count > 0).map(([status, count]) => `${status} ${count}`).join(', ')
    const work = (report: RunResult) => `${Object.entries(report.wholeRuns).filter(([kind]) => kind !== 'lost').reduce((sum, [, count]) => sum + count, 0)} whole-file runs, ${report.work.trials} trials`
    lines.push('| | Verdicts | Work | Longest shard | Processors | Against the suite |', '|---|---|---|---|---|---|')
    for (const tool of [baseTool, headTool]) {
      lines.push(`| ${tool} | ${counts(merged[tool])} | ${work(merged[tool])} | ${seconds[tool]} s | ${[...new Set(cpus[tool])].join(', ')} | ${truth[tool]} |`)
    }
    lines.push('')
    const stored = read<{ mutants: StoredEntry[] }>(truthFile)
    const explained = new Set((stored?.mutants ?? []).filter((entry) => entry.note).map((entry) =>
      keyOf({ file: entry.file, location: { start: { line: entry.start[0], column: entry.start[1] }, end: { line: entry.end[0], column: entry.end[1] } }, mutator: entry.mutator, replacement: entry.replacement })))
    const { moved, onlyBase, onlyHead } = movesBetween(merged[baseTool], merged[headTool], explained)
    if (onlyBase + onlyHead > 0) lines.push(`Mutants of one commit only: ${onlyBase} of the base, ${onlyHead} of the head.`, '')
    if (moved.length === 0) lines.push('No mutant moved.', '')
    for (const move of order) {
      const these = moved.filter((entry) => entry.move === move)
      if (these.length === 0) continue
      if (move === 'detection') detections += these.length
      if (move === 'explained') explainedMoves += these.length
      lines.push(`${move === 'detection' ? '**' : ''}${heading[move]}: ${these.length}${move === 'detection' ? '**' : ''}`, '')
      for (const { mutant, was } of these) lines.push(`- ${where(mutant)}: ${was} → ${mutant.status}`)
      lines.push('')
    }
  }
  const verdict = detections === 0 && problems === 0
    ? `No mutant moved between detected and undetected in ${groups.length} scope runs${explainedMoves > 0 ? ` but ${explainedMoves} whose verdict bench/truth/ explains` : ''}, and every report holds against the suite.`
    : `**${detections} mutant(s) moved between detected and undetected; ${problems} other problem(s).**`
  console.log(['## Verdicts at two commits', '', verdict, '', ...lines].join('\n'))
  return detections === 0 && problems === 0
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { scopes: { type: 'string', default: '' }, macos: { type: 'boolean', default: false }, plan: { type: 'string' } },
  })
  const [mode, dir] = positionals
  if (mode === 'plan') {
    console.log(`jobs=${JSON.stringify(jobsOf(planSlots(values.scopes, values.macos)))}`)
  } else if (mode === 'check' && values.plan && dir) {
    process.exit(check(JSON.parse(fs.readFileSync(values.plan, 'utf8')) as Job[], dir) ? 0 : 1)
  } else {
    console.error("usage: node bench/moves.ts plan [--scopes 'target:scope[:shards] ...'] [--macos]\n       node bench/moves.ts check --plan <jobs.json> <dir>")
    process.exit(2)
  }
}
