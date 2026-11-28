// Ground truth for a report: what the project's own suite does with each
// mutant written into the source for real.
//
//   node bench/truth.ts make (--root <project> | --target <name>) [--report <report.json>] [--out <truth.json>]
//        [--related] [--jobs N] [--sample N] [--timeout seconds] [--statuses Killed,Survived,...] [--also-tool <arg>...]
//   node bench/truth.ts check --report <report.json> --truth <truth.json>
//   node bench/truth.ts probe (--root <project> | --target <name>) --report <report.json> --jobs N [--related]
//   node bench/truth.ts merge --report <report.json> --out <truth.json> <part.json>...
//   node bench/truth.ts diff <made.json> <stored.json>
//
// `make` runs the suite once per mutant and then checks the report against
// what it saw, running the tool over the whole project first where no
// report is given; `check` does only the latter, against what an earlier `make`
// wrote. Both exit with 1 when a verdict and the suite disagree. `probe`
// runs no mutant: it probes the copies `make` would run in, for every file
// of the report with or without `--related`, where `make` without either it
// or `--target` probes one a copy, and says which files they cannot stand for,
// exiting with 1 if any.
//
// `make --shard i/n` runs only the i-th of n shares of the report's mutants
// and writes what it checked beside them; `merge` makes of every share's part
// the file one `make` would have written, refusing a share missing, given
// twice or of another report, and then checks it as `check` does. `diff`
// says where two ground truths of one scope disagree on what the suite does,
// exiting with 1 where one detects a mutant the other does not or they hold
// different mutants.
//
// `make --also-tool` runs the tool a second time, with those arguments in
// place of `--tool`'s, and checks that report against the same truth: what
// the suite does with a mutant does not depend on how the tool ran, so
// `--static` and the default need the suite run once for each mutant, not
// twice. The truth is made for every mutant either report holds eligible.
//
// `--related` runs only the test files that import the mutated file
// (`vitest related`) in place of the whole suite.
//
// `--target` names a benchmark target of bench/targets.ts: the root is its
// project unless `--root` says otherwise, and its config, projects, filters,
// variables and arguments for ground truth go into every run of the suite
// and of the tool, as bench/run.ts gives them to the tool.
//
// With `--jobs` above 1 the runs are spread over copies of the project made
// next to it, which share its `node_modules`. That is only sound for a
// project that does not reach its own sources through `node_modules`: a
// workspace package or a link to itself resolves to the original, where
// the mutant is not. Nor through an alias to an absolute path, and the
// tests may need what a copy lacks, `.git` or a file Vite will not serve
// from outside the copy: `make` refuses copies that fail its probes.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { MutantResult, RunResult } from '../src/run.ts'
import { projectDir, targetEnv, targets, vitestArgs } from './targets.ts'
import { calibrated, compareTruths, keyOf, mergeParts, type Part, partitionKeys, type Partition } from './truth-shards.ts'
import { written } from './write-mutant.ts'

type Suite = 'pass' | 'fail' | 'timeout'

interface Truth {
  /** The Vitest arguments each run was made with, after the mutated file where `related`. */
  command: 'run' | 'related'
  mutants: TruthEntry[]
  partition?: Partition
}

interface TruthEntry {
  file: string
  start: [line: number, column: number]
  end: [line: number, column: number]
  mutator: string
  replacement: string
  suite: Suite
  /** Why a verdict that differs from `suite` is not a wrong one. Written by hand. */
  note?: string
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string' },
    target: { type: 'string' },
    report: { type: 'string' },
    out: { type: 'string' },
    truth: { type: 'string' },
    related: { type: 'boolean', default: false },
    jobs: { type: 'string', default: '1' },
    timeout: { type: 'string' },
    // Check this many mutants, spread evenly over the report, in place of all.
    sample: { type: 'string' },
    shard: { type: 'string' },
    // Further arguments for every Vitest run and for the tool: `--project` and test file filters.
    vitest: { type: 'string', multiple: true, default: [] },
    // Arguments for the tool alone, where it is run here.
    tool: { type: 'string', multiple: true, default: [] },
    'also-tool': { type: 'string', multiple: true, default: [] },
    statuses: { type: 'string', default: 'Killed,Timeout,Survived,NoCoverage,Static' },
  },
})
const [mode, ...files] = positionals
const invalid = mode === 'make' ? !values.root && !values.target
  : mode === 'probe' ? (!values.root && !values.target) || !values.report || Number(values.jobs) < 2
  : mode === 'merge' ? !values.report || !values.out || files.length === 0
  : mode === 'diff' ? files.length !== 2
  : mode !== 'check' || !values.report || !values.truth
if (invalid || (mode !== 'make' && values['also-tool']!.length > 0)) {
  console.error(
    'usage: node bench/truth.ts make (--root <project> | --target <name>) --report <report.json> [--out <truth.json>] [--related] [--jobs N] [--also-tool <arg>...]\n' +
      '       node bench/truth.ts check --report <report.json> --truth <truth.json>\n' +
      '       node bench/truth.ts probe (--root <project> | --target <name>) --report <report.json> --jobs N [--related]\n' +
      '       node bench/truth.ts merge --report <report.json> --out <truth.json> <part.json>...\n' +
      '       node bench/truth.ts diff <made.json> <stored.json>',
  )
  process.exit(2)
}
if (mode === 'diff') {
  const [made, stored] = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as Part)
  const { commands, same, failOrTimeout, differ, onlyMade, onlyStored } = compareTruths(made, stored)
  const at = (entry: Part['mutants'][number]) => `${entry.file}:${entry.start.join(':')} ${entry.mutator} -> ${entry.replacement.slice(0, 60).replace(/\n/g, ' ')}`
  console.log(`${made.mutants.length} entries made with ${commands[0] ?? 'run'} against ${stored.mutants.length} stored with ${commands[1] ?? 'run'}: ` +
    `${same.length} the same, ${failOrTimeout.length} detected in both, one by failing and the other by running out of the limit, ` +
    `${differ.length} detected in one only, ${onlyMade.length} made and not stored, ${onlyStored.length} stored and not made`)
  for (const [entry, was] of [...differ, ...failOrTimeout]) console.log(`  ${at(entry)}: ${entry.suite} made, ${was.suite} stored${was.note ? ` (${was.note})` : ''}`)
  for (const entry of onlyMade) console.log(`  made only: ${at(entry)}`)
  for (const entry of onlyStored) console.log(`  stored only: ${at(entry)}`)
  process.exit(differ.length + onlyMade.length + onlyStored.length > 0 ? 1 : 0)
}
const target = values.target === undefined ? undefined : targets[values.target]
if (values.target !== undefined && !target) {
  console.error(`no target ${values.target} in bench/targets.ts`)
  process.exit(2)
}
if (target) values.root ??= projectDir(values.target!)
const targetArgs = target ? vitestArgs(target) : []
const suiteArgs = [...targetArgs, ...(target?.truthArgs ?? []), ...values.vitest!]
// `vitest related` takes every name after it for a source file, so filters would widen the suite, not narrow it.
if (values.related && target?.filters?.length) {
  console.error(`--related takes no test file filters, and ${values.target} has ${target.filters.join(' ')}`)
  process.exit(2)
}

// A share is of every eligible mutant and runs the suite as the whole would:
// the target's own arguments and `--related` are what `make` does with each
// mutant, and every share of a scope is given the same.
if (values.shard) {
  partitionKeys([], values.shard)
  if (mode !== 'make' || !values.out || values.sample || values.vitest!.length > 0 || values.statuses !== 'Killed,Timeout,Survived,NoCoverage,Static') {
    throw new Error('--shard requires make --out with every eligible mutant and the default statuses, without --sample or --vitest')
  }
}

/** Runs the tool over the project with `args`, its report written to `file`. */
function runTool(file: string, args: string[]) {
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts')
  const root = path.resolve(values.root!)
  // From the project, as bench/run.ts runs it: configs resolve paths against the working directory.
  const run = spawnSync(process.execPath, [cli, '--root', root, '--report', path.resolve(file), ...targetArgs, ...values.vitest!, ...args], {
    cwd: root,
    stdio: 'ignore',
    env: targetEnv(target ?? {}, { dir: root }),
  })
  if (run.status !== 0) {
    console.error(`the tool exited with ${run.status} on ${values.root}${args.length > 0 ? ` with ${args.join(' ')}` : ''}`)
    process.exit(1)
  }
}
const readReport = (file: string): RunResult => JSON.parse(fs.readFileSync(file, 'utf8'))
const build = path.join(import.meta.dirname, '..', 'build')
const also = values['also-tool']!.length > 0 ? path.join(build, `${path.basename(values.root!)}-also.json`) : undefined
// Before the run `--tool` makes, so that where there is one the session the project keeps is its own.
if (also) runTool(also, values['also-tool']!)
if (!values.report) {
  values.report = path.join(build, `${path.basename(values.root!)}.json`)
  runTool(values.report, values.tool!)
}
const report = readReport(values.report)
/** Every report checked against the truth: the first is the one `--report` names or `--tool` made. */
const reports = [{ file: values.report, report }, ...(also ? [{ file: also, report: readReport(also) }] : [])]

const describe = (mutant: MutantResult): Omit<TruthEntry, 'suite'> => ({
  file: mutant.file,
  start: [mutant.location.start.line, mutant.location.start.column],
  end: [mutant.location.end.line, mutant.location.end.column],
  mutator: mutant.mutator,
  replacement: mutant.replacement,
})

/** Vitest as the project resolves it. */
function vitestBin(root: string): string {
  const manifest = createRequire(path.join(root, 'package.json')).resolve('vitest/package.json')
  return path.join(path.dirname(manifest), 'vitest.mjs')
}

/** Tests that fail the suite now and then with no mutant; a run that fails by these alone says nothing. */
const flaky = new Set<string>()
let runs = 0

/** Stands for the test files failed by a run that wrote no report. */
const noReport = '(no report)'
/** Stands for an error no test handled, which the report puts under no file. */
const unhandledError = '(an error no test handled)'

/** A run of the suite; `marked` is what failed with an error that says `marker`: test files, `unhandledError`, or `noReport`. */
function runSuite(
  root: string,
  args: string[],
  limitMs: number,
  marker?: string,
): Promise<{ suite: Suite; ms: number; failed: string[]; marked: Set<string> }> {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    const results = path.join(root, 'node_modules', `.truth-${process.pid}-${runs++}.json`)
    // Its own process group: a mutant can leave workers the suite never ends.
    const unhandled = `${results}.errors`
    const reporter = path.join(import.meta.dirname, 'truth-reporter.mjs')
    const child = spawn(process.execPath, [vitestBin(root), ...args, '--reporter=json', `--reporter=${reporter}`, `--outputFile=${results}`], {
      cwd: root,
      stdio: 'ignore',
      detached: true,
      // The target's variables come after `CI`, so that a target can remove it.
      env: { ...targetEnv(target ?? {}, { dir: root, base: { ...process.env, CI: 'true' } }), VITANT_TRUTH_ERRORS: unhandled },
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // Windows has no process groups to signal; its own tool ends a process with all it started.
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {}
      }
    }, limitMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const failed: string[] = []
      const marked = new Set<string>()
      let known = false
      try {
        const report = JSON.parse(fs.readFileSync(results, 'utf8'))
        known = true
        for (const file of report.testResults) {
          const name = path.relative(root, file.name).split(path.sep).join('/')
          const tests = file.assertionResults.filter((test: { status: string }) => test.status === 'failed')
          for (const test of tests) failed.push(`${name} > ${test.fullName}`)
          // A file that fails without a failing test: an error while it loads, in a hook, or one nothing handled.
          if (file.status === 'failed' && tests.length === 0) known = false
          const messages = [file.message ?? '', ...tests.flatMap((test: { failureMessages: string[] }) => test.failureMessages)]
          if (marker && file.status === 'failed' && messages.some((message) => message.includes(marker))) marked.add(name)
        }
        if (report.numFailedTestSuites > 0 && failed.length === 0) known = false
      } catch {
        if (marker) marked.add(noReport)
      }
      // Tests that fail by themselves excuse a run only where nothing else
      // failed it: an error nothing handled ends Vitest the same way with
      // every test passing, and is not in the report.
      let clean = false
      try {
        const errors: string[] = JSON.parse(fs.readFileSync(unhandled, 'utf8'))
        clean = errors.length === 0
        if (marker && errors.some((message) => message.includes(marker))) marked.add(unhandledError)
      } catch {}
      fs.rmSync(results, { force: true })
      fs.rmSync(unhandled, { force: true })
      // What failed is known to be only tests that fail by themselves: not a failure of the mutant's.
      const onlyFlaky = known && clean && failed.length > 0 && failed.every((test) => flaky.has(test))
      const suite = timedOut ? 'timeout' : code === 0 || onlyFlaky ? 'pass' : 'fail'
      resolve({ suite, ms: performance.now() - startedAt, failed, marked })
    })
  })
}

/** Copies of the project next to it, each with links in place of the `node_modules` directories. */
function copies(root: string, count: number): string[] {
  if (count <= 1) return [root]
  return Array.from({ length: count }, (_, index) => {
    const copy = path.join(path.dirname(root), `.tmp-truth-${process.pid}-${index}`)
    const links: string[] = []
    fs.cpSync(root, copy, {
      recursive: true,
      filter: (source) => {
        const name = path.basename(source)
        if (name === 'node_modules') links.push(path.relative(root, source))
        return name !== 'node_modules' && name !== '.git'
      },
    })
    // A junction where Windows would want a privilege for a link; the word means nothing elsewhere.
    for (const link of links) fs.symlinkSync(path.join(root, link), path.join(copy, link), 'junction')
    return copy
  })
}

/**
 * Says where a copy cannot stand for the checkout. A copy whose tests
 * cannot run there fails every run, and each mutant the report has killed
 * agrees with it whatever the mutant does; a test file of a copy that
 * loads the checkout's sources, or does not load the copy's file where the
 * checkout's loads it, passes with every mutant, and each survivor agrees.
 * So in a copy the run for a file has to pass with no mutant; with a throw
 * at the top of the copy's file, it has to fail the very test files that
 * the throw fails at the top of the checkout's; and with the throw in the
 * checkout's file, none. With `--related` the runs differ by file, and
 * every mutated file is probed, as for a `--target`, whose tests need not
 * reach its files alike; otherwise each is the whole suite of a fixture,
 * and each copy takes one file in turn, which holds for the rest only where
 * the tests reach every file alike: the throw's runs of every file would
 * be a whole suite each, in every shard on CI. With `all` every file is
 * probed, and each comes back with why it is refused, or undefined;
 * without it the first refusal throws. Under `--shard` the files are the
 * share's, and with `--related` the slowest file of the report as well,
 * so that each job's copies are probed for what they run.
 */
async function probeCopies({ root, copies, files, argsFor, originals, all = false }: {
  root: string
  copies: string[]
  files: string[]
  argsFor: (file: string) => string[]
  originals: Map<string, string>
  all?: boolean
}): Promise<Map<string, string | undefined>> {
  const outcome = new Map<string, string | undefined>()
  if (files.length === 0) return outcome
  // Each copy takes its first file before any run ends, so that each is probed.
  const queue = Array.from({ length: values.related || target || all ? Math.max(files.length, copies.length) : copies.length }, (_, at) => files[at % files.length])
  const failing: { copy: string; file: string }[] = []
  const probed: { copy: string; file: string; marked: Set<string> }[] = []
  // A copy is refused for a run with no mutant only once it fails with
  // nothing else running, and the copies start no more runs until then: in
  // a copy that runs nothing, every file fails.
  while (queue.length > 0) {
    await Promise.all(
      copies.map(async (copy) => {
        while (queue.length > 0 && failing.length === 0) {
          const file = queue.shift()!
          let passed = false
          for (let attempt = 0; attempt < 3 && !passed; attempt++) passed = (await runSuite(copy, argsFor(file), 600_000)).suite === 'pass'
          if (!passed) failing.push({ copy, file })
          else probed.push({ copy, file, marked: (await withThrow(copy, file, [copy]))[0].marked })
        }
      }),
    )
    for (const { copy, file } of failing.splice(0)) {
      if ((await runSuite(copy, argsFor(file), 600_000)).suite === 'pass') probed.push({ copy, file, marked: (await withThrow(copy, file, [copy]))[0].marked })
      else refuse(copy, file, `the probe with no mutant failed in the copy ${copy}: \`vitest ${argsFor(file).join(' ')}\` for ${file} fails there and passes in the checkout`)
    }
  }
  // Only a test file that fails with the throw's own message counts, so that
  // one failing by itself, as a test that waits on the clock does beside
  // other runs, cannot stand in for it. The checkout's file is changed only
  // here, with no other copy running, since a copy's tests may load it.
  // Where the copy and the checkout differ, both are run again one at a time
  // before the copy is refused. A file none of the tests loads, as
  // lint-staged's `lib/config.js`, fails nothing in either.
  for (const { copy, file, marked } of probed) {
    let reason = difference(copy, file, marked, await withThrow(root, file, [root, copy]))
    if (reason) {
      const [again] = await withThrow(copy, file, [copy])
      const [checkout] = await withThrow(root, file, [root])
      const [beside] = await withThrow(root, file, [copy])
      reason = difference(copy, file, again.marked, [checkout, beside])
    }
    if (reason) refuse(copy, file, reason)
    else if (!outcome.has(file)) outcome.set(file, undefined)
  }
  return outcome

  function difference(copy: string, file: string, inCopy: Set<string>, [checkout, beside]: { marked: Set<string> }[]): string | undefined {
    const args = `\`vitest ${argsFor(file).join(' ')}\``
    const list = (names: Iterable<string>) => {
      const sorted = [...names].sort()
      return sorted.length > 5 ? `${sorted.slice(0, 5).join(', ')} and ${sorted.length - 5} more` : sorted.join(', ')
    }
    if (beside.marked.size > 0) {
      return `the probe with a throw failed in the copy ${copy}: with a throw at the top of the checkout's ${file}, ${args} fails ${list(beside.marked)} there: the copy's tests load the checkout's file`
    }
    const missing = [...checkout.marked].filter((name) => !inCopy.has(name))
    const extra = [...inCopy].filter((name) => !checkout.marked.has(name))
    if (missing.length === 0 && extra.length === 0) return undefined
    const parts = [...(missing.length > 0 ? [`${list(missing)} in the checkout and not there`] : []), ...(extra.length > 0 ? [`${list(extra)} there and not in the checkout`] : [])]
    return `the probe with a throw failed in the copy ${copy}: with a throw at the top of its ${file}, ${args} fails ${parts.join(', and ')}`
  }

  function refuse(copy: string, file: string, reason: string) {
    if (!all) throw new Error(`${reason}. Copies cannot stand for this project: make ground truth with --jobs 1`)
    if (outcome.get(file) === undefined) outcome.set(file, reason)
  }

  /** Runs the suite for `file` in each of `dirs` at once, with a throw at the top of the file in `dir`. */
  async function withThrow(dir: string, file: string, dirs: string[]) {
    const target = path.join(dir, file)
    const source = fs.readFileSync(target, 'utf8')
    const marker = `vitant truth: ${file} is loaded`
    // After a first line that starts with `#!`, which has to stay first.
    const head = source.startsWith('#!') ? source.indexOf('\n') + 1 || source.length : 0
    originals.set(target, source)
    fs.writeFileSync(target, `${source.slice(0, head)}throw new Error(${JSON.stringify(marker)})\n${source.slice(head)}`)
    try {
      return await Promise.all(dirs.map((at) => runSuite(at, argsFor(file), 600_000, marker)))
    } finally {
      fs.writeFileSync(target, source)
      originals.delete(target)
    }
  }
}

async function make(): Promise<Truth> {
  const root = fs.realpathSync(values.root!)
  const command = values.related ? 'related' : 'run'
  const argsFor = (file: string) => [...(values.related ? ['related', '--run', file] : ['run']), ...suiteArgs]
  const wanted = new Set(values.statuses!.split(','))
  const eligible = report.mutants.filter((mutant) => wanted.has(mutant.status))
  // A mutant eligible in only one report, as one Unconfirmed in the other, is made too.
  const keys = new Set(eligible.map((mutant) => keyOf(describe(mutant))))
  for (const { report: other } of reports.slice(1)) {
    for (const mutant of other.mutants) {
      const key = keyOf(describe(mutant))
      if (!wanted.has(mutant.status) || keys.has(key)) continue
      eligible.push(mutant)
      keys.add(key)
    }
  }
  const step = values.sample ? Math.max(1, eligible.length / Number(values.sample)) : 1
  const partition = values.shard ? partitionKeys(eligible.map((mutant) => keyOf(describe(mutant))), values.shard) : undefined
  const selected = new Set(partition?.selected)
  const mutants = partition ? eligible.filter((mutant) => selected.has(keyOf(describe(mutant)))) : values.sample
    ? Array.from({ length: Math.min(eligible.length, Number(values.sample)) }, (_, index) => eligible[Math.floor(index * step)])
    : eligible

  const roots = copies(root, Number(values.jobs))
  const originals = new Map<string, string>()
  const restore = () => {
    for (const [file, source] of originals) fs.writeFileSync(file, source)
    // Windows keeps a directory from going while a process that was just ended still has it open.
    if (roots.length > 1) for (const copy of roots) fs.rmSync(copy, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
  process.on('exit', restore)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      restore()
      process.exit(130)
    })
  }

  // What every run is held against: the same command with no mutant, which has to pass.
  let slowest = 0
  let slowestFile = ''
  for (const file of calibrated({ related: values.related!, shard: partition !== undefined, eligible, mutants })) {
    // More than once only where it fails: with a file per function there
    // are hundreds of these. What fails by itself in the runs below is
    // looked for where a run and the report disagree.
    let passed = false
    for (let attempt = 0; attempt < 5 && !passed; attempt++) {
      const baseline = await runSuite(root, argsFor(file), 600_000)
      for (const test of baseline.failed) flaky.add(test)
      if (baseline.suite === 'pass') passed = true
      if (baseline.ms > slowest) slowestFile = file
      slowest = Math.max(slowest, baseline.ms)
    }
    if (!passed) throw new Error(`vitest ${argsFor(file).join(' ')} does not pass without a mutant`)
  }
  // A share probes the slowest file too, which the loaded runs below make in
  // every copy and need not be its own: in a copy that cannot run it, they
  // fail at once and give a limit too short for the copies beside each other.
  const probeFiles = [...mutants.map((mutant) => mutant.file), ...(partition && values.related && slowestFile ? [slowestFile] : [])]
  const probed = roots.length > 1
    ? await probeCopies({ root, copies: roots, files: [...new Set(probeFiles)], argsFor, originals, all: mode === 'probe' })
    : new Map()
  if (mode === 'probe') {
    for (const [file, reason] of [...probed].sort(([a], [b]) => a.localeCompare(b))) console.log(reason ? `refused: ${file}: ${reason}` : `accepted: ${file}`)
    process.exit([...probed.values()].some(Boolean) ? 1 : 0)
  }
  if (roots.length > 1) console.error(`${roots.length} copies passed the probes of ${probed.size} of ${new Set(probeFiles).size} files`)
  // The limit is for runs that have others beside them: on a machine with
  // one processor for each, a suite among four takes five times what it
  // takes alone, and a limit from the one alone ends every run. Only the
  // time is taken from these: a test that fails here for the load would
  // count as one that fails by itself, and a mutant only it detects as
  // passing.
  if (roots.length > 1) {
    for (const loaded of await Promise.all(roots.map((dir) => runSuite(dir, argsFor(slowestFile), 600_000)))) slowest = Math.max(slowest, loaded.ms)
  }
  const limitMs = values.timeout ? Number(values.timeout) * 1000 : Math.max(20_000, slowest * 5)
  console.error(`suite ${(slowest / 1000).toFixed(1)}s unmutated, ${mutants.length} mutants, limit ${Math.round(limitMs / 1000)}s a run`)
  if (flaky.size > 0) console.error(`fail without a mutant now and then, and are not counted:\n  ${[...flaky].join('\n  ')}`)

  const entries: TruthEntry[] = new Array(mutants.length)
  let next = 0
  let done = 0
  try {
    await Promise.all(
      roots.map(async (dir) => {
        while (next < mutants.length) {
          const index = next++
          const entry = describe(mutants[index])
          const file = path.join(dir, entry.file)
          const source = fs.readFileSync(file, 'utf8')
          originals.set(file, source)
          fs.writeFileSync(file, written(file, source, entry))
          const { suite } = await runSuite(dir, argsFor(entry.file), limitMs)
          fs.writeFileSync(file, source)
          originals.delete(file)
          entries[index] = { ...entry, suite }
          if (++done % 25 === 0) console.error(`${done}/${mutants.length}`)
        }
      }),
    )
    // Several suites at once make a busy machine, on which a test that
    // waits on the clock can fail by itself. Where the suite and the report
    // disagree the suite is run once more, with nothing beside it.
    const reported = reports.map(({ report: run }) => new Map(run.mutants.map((mutant) => [keyOf(describe(mutant)), mutant.status])))
    const disagrees = (status: string | undefined, suite: Suite) =>
      status !== undefined && status !== 'Static' && (status === 'Killed' || status === 'Timeout') !== (suite !== 'pass')
    const learned = new Set<string>()
    for (const entry of entries) {
      if (!reported.some((statuses) => disagrees(statuses.get(keyOf(entry)), entry.suite))) continue
      const file = path.join(root, entry.file)
      const source = fs.readFileSync(file, 'utf8')
      // A test that fails one run in four with no mutant passes for a
      // mutant's doing as often: the suite is run a few times as it is,
      // and what fails there does not count in the run that follows.
      if (entry.suite === 'fail' && !learned.has(entry.file)) {
        learned.add(entry.file)
        for (let attempt = 0; attempt < 4; attempt++) {
          for (const test of (await runSuite(root, argsFor(entry.file), limitMs)).failed) {
            if (!flaky.has(test)) console.error(`fails without a mutant now and then, and is not counted: ${test}`)
            flaky.add(test)
          }
        }
      }
      originals.set(file, source)
      fs.writeFileSync(file, written(file, source, entry))
      // A test that fails one run in three by itself is easily missed by
      // the runs above and as easily fails here: a failure the mutant
      // causes is there in every run, so one that passes settles it. The
      // same goes for a run the limit ended: on a Windows runner the suite
      // ran out of it once with a mutant in code no test reaches.
      let suite: Suite = entry.suite
      for (let attempt = 0; attempt < (entry.suite === 'pass' ? 1 : 3) && (attempt === 0 || suite !== 'pass'); attempt++) {
        suite = (await runSuite(root, argsFor(entry.file), limitMs)).suite
      }
      fs.writeFileSync(file, source)
      originals.delete(file)
      if (suite !== entry.suite) console.error(`${entry.file}:${entry.start.join(':')} ${entry.suite} at first, ${suite} alone`)
      entry.suite = suite
    }
  } finally {
    restore()
  }
  return { command, mutants: entries, ...(partition ? { partition: {
    index: partition.index, total: partition.total, universe: partition.universe, checked: entries.map(keyOf),
  } } : {}) }
}

function check(truth: Truth, report: RunResult, label?: string): boolean {
  const byKey = new Map(report.mutants.map((mutant) => [keyOf(describe(mutant)), mutant]))
  const tally = { agree: 0, explained: 0, 'not judged': 0, 'not judged that fail the suite': 0, led: 0, 'led that pass the suite': 0, 'not in the report': 0 }
  const wrong: string[] = []
  for (const entry of truth.mutants) {
    const mutant = byKey.get(keyOf(entry))
    if (!mutant) {
      tally['not in the report']++
      continue
    }
    // A mutant that only runs while a file loads is reported as such, without
    // a verdict, and so is one that a test left out of the runs reaches.
    if (mutant.status === 'Static' || mutant.status === 'Unconfirmed') {
      tally[entry.suite === 'pass' ? 'not judged' : 'not judged that fail the suite']++
      continue
    }
    // With `--led`, a lead taken at its word; one the suite passes with is what the option costs.
    if (mutant.status === 'Led') {
      tally[entry.suite === 'pass' ? 'led that pass the suite' : 'led']++
      continue
    }
    if (mutant.status === 'Pending') {
      wrong.push(`${entry.file}:${entry.start.join(':')} ${entry.mutator}: left pending`)
      continue
    }
    const detected = mutant.status === 'Killed' || mutant.status === 'Timeout'
    if (detected === (entry.suite !== 'pass')) tally.agree++
    else if (entry.note) tally.explained++
    else {
      wrong.push(`${entry.file}:${entry.start.join(':')} ${entry.mutator} -> ${entry.replacement.slice(0, 60)}: suite ${entry.suite}, reported ${mutant.status}`)
      for (const { kind, file, test, by, quiet } of mutant.evidence ?? []) {
        wrong.push(`  ${kind}${by ? ` (${quiet ? 'nothing else running, ' : ''}${by})` : ''}: ${file}${test ? ` > ${test}` : ''}`)
      }
    }
  }
  console.log(
    `${label ? `${label}: ` : ''}${truth.mutants.length} mutants checked against the suite: ` +
      Object.entries({ ...tally, wrong: wrong.filter((line) => !line.startsWith('  ')).length })
        .filter(([, count]) => count > 0)
        .map(([name, count]) => `${count} ${name}`)
        .join(', '),
  )
  for (const line of wrong) console.log(`  ${line}`)
  return wrong.length === 0
}

let truth: Truth
if (mode === 'merge') {
  const wanted = new Set(values.statuses!.split(','))
  const order = report.mutants.filter((mutant) => wanted.has(mutant.status)).map((mutant) => keyOf(describe(mutant)))
  const merged = mergeParts(order, files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as Part))
  if ('errors' in merged) {
    for (const error of merged.errors) console.error(error)
    process.exit(1)
  }
  truth = merged as Truth
} else if (mode === 'make' || mode === 'probe') {
  truth = await make()
} else {
  truth = JSON.parse(fs.readFileSync(values.truth!, 'utf8'))
}
if (mode !== 'check' && values.out) {
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
  const lines = truth.mutants.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')
  const partition = truth.partition ? `,\n  "partition": ${JSON.stringify(truth.partition)}` : ''
  fs.writeFileSync(values.out, `{\n  "command": "${truth.command}",\n  "mutants": [\n${lines}\n  ]${partition}\n}\n`)
}
// Every report is checked, so that one wrong verdict does not hide another report's.
const passed = reports.map(({ file, report: run }) => check(truth, run, reports.length > 1 ? path.relative(process.cwd(), file) : undefined))
process.exit(passed.every(Boolean) ? 0 : 1)
