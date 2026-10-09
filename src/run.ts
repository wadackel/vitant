import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type Cache,
  type CachedFile,
  cachePath,
  fingerprint,
  hashFile,
  isFresh,
  hintKeys,
  loadCache,
  loadKillers,
  testKey,
  mutantKeys,
} from './cache.ts'
import { type Generated, generate, type GenerateOptions } from './mutate/generate.ts'
import { RUNTIME_GLOBAL } from './mutate/instrument.ts'
import { addonTarget } from './platform.ts'
import {
  createRuntime,
  MUTANT_KILLED,
  MUTANT_PENDING,
  MUTANT_STALLED,
  MUTANT_TIMEOUT,
  type RoundPlan,
  type SessionConfig,
  channelWatch,
  sessionPaths,
} from './session.ts'
import { sweep } from './runtime/turns.ts'

export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'Timeout'
  | 'NoCoverage'
  | 'Static'
  | 'Pending'

export interface MutantResult {
  id: number
  file: string
  mutator: string
  replacement: string
  location: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
  status: MutantStatus
  /** Evaluated while a module loaded or in `beforeAll`, where it cannot be switched per test. */
  static: boolean
  coveredBy: number
  killedBy: number
  /** For a timeout, what stopped the run: the loop limit, the timer, or a re-run in a fresh worker. */
  timeoutCause?: string
  /**
   * For a detected mutant, the runs of whole files that say so and the tests
   * that led to them: what to read when the suite disagrees with the verdict.
   */
  evidence?: Evidence[]
}

export interface Evidence {
  /** `lead` is a test that failed while trying the mutant, which alone decides nothing. */
  kind: 'failed' | 'timeout' | 'died' | 'lead'
  file: string
  test?: string
  by?: keyof WholeRuns
}

/**
 * How the processes that made the whole-file runs came to be. A run that
 * was to be made in a copy and is counted as `started` fell back.
 */
export interface WholeRuns {
  started: number
  'copied before load': number
  'copied after load': number
  /** Copies that ended without a verdict; each run was made again in a worker started for it. */
  lost: number
}

export interface RunResult {
  mutants: MutantResult[]
  counts: Record<MutantStatus, number>
  timings: { generateMs: number; vitestMs: number; totalMs: number }
  testFiles: number
  tests: number
  /** Tests that failed before any mutant was activated; what they cover is unknown. */
  failedBaselines: string[]
  /** Tests that failed a whole-file run with a mutant and not the next one with the same mutant; what they fail is not counted. */
  flakyTests: string[]
  /**
   * Test files of the suite that were not run, by what kept them out: a
   * Vitest project the runner could not be put into, or the type checker,
   * which is where type tests run. A mutant reported as survived survived
   * the rest of the suite, and these might have detected it.
   */
  leftOut: { projects: Record<string, number>; typeTests: number }
  /**
   * The runs made with nothing else running, by how they went. One that
   * passed is a mutant that had failed its file twice in a row and would
   * have been reported as killed without it.
   */
  quietRuns: { failed: number; passed: number }
  /** Test files whose runs failed each other and were made one at a time from then on. */
  exclusiveFiles: string[]
  /**
   * Files under version control that differ from before the run: tests wrote
   * them and did not put them back, a run ended early or two at once being
   * how that comes about. Every run after the first such write saw them.
   */
  changedFiles: string[]
  /** Tests that stopped passing unmutated once they were re-run in the same worker. */
  nonRepeatableTests: string[]
  /** Errors raised outside any test, such as a file that fails to import. */
  suiteErrors: string[]
  /** Test files whose worker kept dying; their mutants stay `Pending`. */
  abandonedFiles: string[]
  /** How many times Vitest was asked to run files. */
  rounds: number
  wholeRuns: WholeRuns
  unplaced: number
  skippedFiles: string[]
  vitestVersion: string
}

export interface RunOptions extends GenerateOptions {
  /** Passed to Vitest as test file filters. */
  filters: string[]
  /** The Vitest projects to run, by name; all of them when empty. */
  projects: string[]
  /** Run only test files that import a mutated file. */
  related: boolean
  timeoutFactor: number
  timeoutMs: number
  recycleHeapMb: number
  loopFactor: number
  loopSlack: number
  /** Work a file needs to have for each worker run it gets in a planned round. */
  budgetMs: number
  /** In the first round, tests faster than this try their mutants right away. */
  cheapMs: number
  maxRounds: number
  /** Worker processes Vitest may run at once. */
  maxWorkers: number
  /** Reuse the results of test files that loaded nothing that changed since the last run. */
  incremental: boolean
  /** Make whole-file runs in copies of a worker that has started up, where the platform can copy a process. */
  clone: boolean
  /** Run mutants in code that only runs while a module loads. */
  static: boolean
  log: (message: string) => void
}

interface TestRecord {
  type: 'test'
  file: string
  id: string
  name: string
  /** `probe` records come with an unmutated run and what it covered. */
  mode: 'probe' | 'planned'
  baseline?: 'pass' | 'fail' | 'skip'
  baselineMs: number
  baselineLoops: number
  baselineRetry: boolean
  /**
   * No other process ran the file at the time, as in the first round. What a
   * test fails next to other runs of its file may be their doing: tests that
   * listen on a port fail each other into leads, and the run of the file
   * that is to check the lead fails the same way.
   */
  sole?: boolean
  /** For an unmutated run: no mutant had been on in the worker before it. */
  pristine?: boolean
  nonRepeatable: boolean
  needsReplay: boolean
  /** Why the worker left the test before its mutants ran out. */
  stop?: "done" | "memory" | "tainted"
  /** Whether the tests before this one had run in the worker, as opposed to being skipped. */
  replayed: boolean
  ms: number
  /** CPU time of the worker process over the same span. */
  cpuMs: number
  attempts: number
  /** Sites whose original code the test evaluated. */
  sites: number[]
  /** Mutants at those sites that could change the test's behaviour. */
  covered: number[]
  /** Mutants that could only change what the hooks cleaning up after the test do. */
  cleanup: number[]
  killed: number[]
  timedOut: number[]
  /** Which limit each entry of `timedOut` tripped. */
  timeoutCauses?: string[]
  survived: number[]
  /** Mutants the test failed with and then failed without: a lead, like a failure the test did not repeat without the mutant. */
  suspected?: number[]
  /** Mutants the test passed with although their code never ran, the tests before it having been skipped. */
  unreached?: number[]
  unverified: number[]
}

interface FileRecord {
  type: 'file'
  file: string
  /** Ids of every runnable test in the file. */
  tests: string[]
  staticSites: number[]
  /** Mutants that would have changed a value outside any test. */
  staticMutants?: number[]
  /** Sites reached once the file had loaded, outside the tests that try mutants. */
  hookSites?: number[]
  /** Mutants that would have changed a value there. */
  hookMutants?: number[]
  /** The pass was made to measure the tests with no mutant tried. */
  pristine?: boolean
  /** Every test of the file ran in this worker, so each reported its coverage. */
  complete: boolean
  /** Project files the worker loaded, reported with a complete pass. */
  modules?: string[]
}

/** A worker was killed for blocking its event loop while a mutant was active. */
interface StallRecord {
  type: 'stall'
  id: string
  mutant: number
}

/** Outcome of running a whole file with a mutant always on, see `RoundPlan.whole`. */
interface WholeRecord {
  type: 'whole'
  file: string
  mutant: number
  verdict: 'failed' | 'timeout' | 'passed'
  /** The test that failed, where the failure was a test's. */
  test?: string
  /** Every test that failed; more than `test` where the run went on to a test that had given a lead. */
  tests?: string[]
  /** The run knew of a test that had given a lead, and so went on to it. */
  knew?: boolean
  /** No other run of the file was under way, see `WholeJob.exclusive`. */
  alone?: boolean
  /** Nothing else was running at all, see `WholeJob.quiet`. */
  quiet?: boolean
  /** The failure is the worker having gone without a word. */
  died?: boolean
  /** How long the run took. */
  ms?: number
  /** Absent on a verdict taken over from an earlier run of the tool. */
  by?: keyof WholeRuns
}

interface WholeState {
  /** Every run that left a record, counted or not. */
  runs: number
  /** Failures that repeat what a test had shown while trying the mutant. */
  repeated: number
  /** Failures of this run of the tool that were made while other runs of the file could be under way. */
  beside: number
  /** Failures in runs made with nothing else running. */
  quiet: number
  /** Runs that knew of a test that had given a lead, see `WholeRecord.knew`. */
  knowing: number
  /** Runs whose worker was gone without a word. */
  died: number
  failed: number
  timedOut: number
  passed: number
}

const wholeKey = (mutant: number, file: string) => `${mutant}\n${file}`

/**
 * A failure counts once it has been seen twice, as nothing can re-run a file
 * in place: in a second run of the file, or in the same test that failed with
 * the mutant while trying it. A lead from another test does not do: trying a
 * mutant in a worker can fail a test for good reasons that a whole run does
 * not share, and then one test of the file failing by chance would settle it.
 */
function wholeVerdict(state: WholeState | undefined): WholeRecord['verdict'] | undefined {
  if (!state) return undefined
  if (state.passed > 0) return 'passed'
  // A worker can die of something other than the mutant, and nothing a
  // test saw says otherwise: that counts when it has happened twice.
  const settled =
    state.repeated > 0 || state.failed + state.timedOut >= 2 || state.failed + state.timedOut + state.died >= 2
  if (!settled) return undefined
  // Two failures in a row are made within milliseconds of each other, and
  // on a machine that is busy at that moment both can be the machine's: a
  // test that sleeps a second and checks the time it logged failed twice
  // for a mutant in code it has nothing to do with. Where the test that
  // failed never failed with the mutant while trying it, the failures are
  // all there is, and one of them has to be made with nothing else running.
  // A lead from another test of the file does not vouch for this one.
  if (state.repeated === 0 && state.quiet === 0) return undefined
  return state.failed + state.died > 0 ? 'failed' : 'timeout'
}

/**
 * How a copy of a worker ran a file with no mutant on. On macOS a copy that
 * touches what a native module had set up in another thread is ended by the
 * system, hundreds of times over in a project that bundles as its tests
 * run, each ended copy a run to make again in a started worker. Where a
 * copy of a file was lost, one more is made with no mutant, and a file such
 * copies fail twice or do not get through is run in started workers. This
 * saves runs; it does not show that a copy that passes is what a started
 * worker would be with a mutant on.
 */
interface ControlRecord {
  type: 'control'
  file: string
  verdict: 'failed' | 'passed'
  by: keyof WholeRuns
  test?: string
}

/** How one of two unmutated runs of a file went that were made at the same moment, see `WholeJob.pair`. */
interface PairRecord {
  type: 'pair'
  file: string
  verdict: 'failed' | 'passed'
  /** The other run was there to start with; without it the run says nothing. */
  met: boolean
  test?: string
}

/** A copy of a worker ended without a verdict for the run. */
interface PlainRecord {
  type: 'plain'
  file: string
  mutant: number
}

/** A site's code ran while the file loaded, where a whole-file run had taken it not to; -1 for the file as a whole. */
interface EarlyRecord {
  type: 'early'
  file: string
  site: number
}

export type SessionRecord = (
  | TestRecord
  | FileRecord
  | WholeRecord
  | StallRecord
  | EarlyRecord
  | PlainRecord
  | ControlRecord
  | PairRecord
  | { type: 'pairing'; file: string }
  | { type: 'worker' }
) & {
  at: number
}

interface TestState {
  file: string
  name: string
  /** From the last passing unmutated run. */
  coverage?: { sites: number; covered: number[]; cleanup: number[]; baselineMs: number; baselineLoops: number }
  /** No mutant had been on in the worker when that run was made. */
  pristine: boolean
  /** Mutants this test already ran to a verdict. */
  judged: Set<number>
  /** Mutants the test did not pass under, or never ran them, so it cannot be said to have survived them. */
  unverified: Set<number>
  /** Whether the test still needs an unmutated run to be planned. */
  retry: boolean
  /** The test cannot judge any more mutants. */
  done: boolean
  /** Its unmutated run failed for good. */
  failed: boolean
}

/** Works out from what the workers wrote what each test still has to do. */
export function inspect(records: SessionRecord[], siteOf?: ArrayLike<number>) {
  const tests = new Map<string, TestState>()
  const replay = new Set<string>()
  const retried = new Set<string>()
  const finished = new Map<string, string[][]>()
  /** Per file, how often a worker gave up while going through it for coverage. */
  const taints = new Map<string, number>()
  /** Per test file, the mutants that would have changed a value while it loaded. */
  const staticMutants = new Map<string, Set<number>>()
  /** Test files that open something while they load which copies made afterwards would share. */
  const sharing = new Set<string>()
  /** Whole-file runs that a copy of a worker did not get through. */
  const plain = new Set<string>()
  /** Per test file, the sites whose code ran outside its tests in an unmutated run. */
  const staticSites = new Map<string, Set<number>>()
  const whole = new Map<string, WholeState>()
  /** Sites some test reaches. */
  const reached = new Set<number>()
  /** Files that had their pass with no mutant tried. */
  const measured = new Set<string>()
  /** What whole-file runs have shown to be detected. */
  const detected = new Map<number, number>()
  /**
   * Per mutant, the files with a test that failed with it while trying it.
   * That is a lead, not a verdict: the mutant was on for that test alone,
   * after a start without it, which is not a state the suite ever runs in.
   */
  const suspects = new Map<number, Set<string>>()
  /**
   * Mutants that blocked a worker while a test tried them. Blocking once
   * more, in a run of a whole file, is what a timeout is.
   */
  const blocked = new Map<number, Set<string>>()
  const stalls: { mutant: number; test: string }[] = []
  /** Per test file, how long its whole-file runs have taken and how many there were. */
  const wholeTook = new Map<string, { ms: number; runs: number }>()
  const leads: { mutant: number; file: string; test: string; passedAgain: boolean }[] = []
  /** Per mutant, the tests that failed with it and passed without it next to other runs of their file. */
  const beside = new Map<number, Set<string>>()
  /** Per mutant, the tests that tried it with their file to themselves. */
  const triedSole = new Map<number, Set<string>>()
  const wholeRecords: (WholeRecord & { at: number })[] = []
  /** Per file, the pairs of unmutated runs asked for, the runs that met their other half, and those of them that failed. */
  const pairs = new Map<string, { asked: number; met: number; failed: number }>()
  const pairFailures: PairRecord[] = []
  const pairOf = (file: string) => {
    const entry = pairs.get(file) ?? { asked: 0, met: 0, failed: 0 }
    pairs.set(file, entry)
    return entry
  }
  /** Files a copy of a worker did not get through, which is where copies are checked. */
  const lost = new Set<string>()
  /**
   * Per kind of copy and file, how the file went in such a copy unmutated.
   * One failure may be a test failing by chance, and running a file in
   * started workers for good is a high price for that: it takes two.
   */
  const controls = new Map<string, ControlRecord['verdict']>()
  const controlFailures = new Map<string, number>()
  for (const record of records) {
    if (record.type === 'file' && record.complete) {
      finished.set(record.file, [...(finished.get(record.file) ?? []), record.tests])
    }
    if (record.type === 'file' && record.pristine) measured.add(record.file)
    if (record.type === 'file' && record.staticSites) {
      const set = staticSites.get(record.file) ?? new Set()
      for (const site of record.staticSites) set.add(site)
      staticSites.set(record.file, set)
    }
    if (record.type === 'plain') {
      plain.add(wholeKey(record.mutant, record.file))
      lost.add(record.file)
    }
    if (record.type === 'pairing') pairOf(record.file).asked++
    if (record.type === 'pair' && record.met) {
      pairOf(record.file).met++
      if (record.verdict === 'failed') {
        pairOf(record.file).failed++
        pairFailures.push(record)
      }
    }
    if (record.type === 'control') {
      const key = `${record.by}\n${record.file}`
      if (record.verdict === 'passed') controls.set(key, 'passed')
      else {
        controlFailures.set(key, (controlFailures.get(key) ?? 0) + 1)
        if (controlFailures.get(key)! >= 2 && !controls.has(key)) controls.set(key, 'failed')
      }
    }
    // In a run of a whole file the record names no test, and the run's own record follows.
    if (record.type === 'stall' && record.id !== '') stalls.push({ mutant: record.mutant, test: record.id })
    if (record.type === 'early') {
      if (record.site === -1) sharing.add(record.file)
      const set = staticSites.get(record.file) ?? new Set()
      set.add(record.site)
      staticSites.set(record.file, set)
    }
    if (record.type === 'file') {
      for (const site of record.hookSites ?? []) reached.add(site)
      const set = staticMutants.get(record.file) ?? new Set()
      for (const mutant of [...(record.staticMutants ?? []), ...(record.hookMutants ?? [])]) set.add(mutant)
      staticMutants.set(record.file, set)
    }
    if (record.type === 'whole') {
      wholeRecords.push(record)
      if (record.ms !== undefined) {
        const took = wholeTook.get(record.file) ?? { ms: 0, runs: 0 }
        took.ms += record.ms
        took.runs++
        wholeTook.set(record.file, took)
      }
      continue
    }
    if (record.type !== 'test') continue
    let test = tests.get(record.id)
    if (!test) {
      test = {
        file: record.file,
        name: record.name,
        judged: new Set(),
        unverified: new Set(),
        retry: false,
        done: false,
        failed: false,
        pristine: false,
      }
      tests.set(record.id, test)
    }
    for (const mutant of record.survived) test.judged.add(mutant)
    for (const mutant of [...record.killed, ...record.timedOut]) {
      test.judged.add(mutant)
      leads.push({ mutant, file: record.file, test: record.id, passedAgain: record.sole === true })
      if (!record.sole) beside.set(mutant, (beside.get(mutant) ?? new Set()).add(record.id))
    }
    if (record.sole) {
      for (const mutant of [...record.survived, ...record.killed, ...record.timedOut, ...(record.suspected ?? [])]) {
        triedSole.set(mutant, (triedSole.get(mutant) ?? new Set()).add(record.id))
      }
    }
    for (const mutant of record.suspected ?? []) {
      leads.push({ mutant, file: record.file, test: record.id, passedAgain: false })
    }
    for (const mutant of record.unverified) {
      test.judged.add(mutant)
      test.unverified.add(mutant)
    }
    if (record.nonRepeatable) test.done = true
    for (const mutant of record.unreached ?? []) test.judged.add(mutant)
    if (record.needsReplay) replay.add(record.file)
    if (record.stop === 'tainted') taints.set(record.file, (taints.get(record.file) ?? 0) + 1)
    if (record.mode !== 'probe') continue
    if (record.baseline === 'pass') {
      for (const site of record.sites) reached.add(site)
      test.retry = false
      test.pristine = record.pristine ?? false
      test.coverage = {
        sites: record.sites.length,
        covered: record.covered,
        cleanup: record.cleanup,
        baselineMs: record.baselineMs,
        baselineLoops: record.baselineLoops,
      }
    } else if (record.baseline === 'fail') {
      test.retry = record.baselineRetry
      if (!record.baselineRetry) {
        test.done = true
        test.failed = true
      }
      if (record.replayed) retried.add(record.id)
      replay.add(record.file)
    } else {
      test.done = true
    }
  }
  for (const { mutant, test } of stalls) {
    const file = tests.get(test)?.file
    if (file) blocked.set(mutant, (blocked.get(mutant) ?? new Set()).add(file))
  }
  const uncopied = new Set<string>()
  for (const [key, verdict] of controls) if (verdict === 'failed') uncopied.add(key.split('\n')[1])
  const counted = wholeRecords.filter((record) => !record.by || record.by === 'started' || !uncopied.has(record.file))
  // A test that failed a file's run with a mutant and did not fail another
  // run of the same file with the same mutant fails for reasons of its own.
  // The first suspect is the tool: it runs one test file in many processes
  // at once, which a plain run never does, and tests that listen on a port
  // or write files next to themselves then fail each other. From then on
  // the file's runs are made one at a time, and what failed while they were
  // not is run again. A test that still fails and passes with the same
  // mutant waits on the clock or the like: two such failures in a row are
  // only a matter of running often enough, so what it fails says nothing,
  // here or as a lead, and it is left out of the runs that follow like a
  // test that fails without any mutant.
  const flaky = new Set<string>()
  const exclusive = new Set<string>()
  const passedOnce = new Set<string>()
  const passedAlone = new Set<string>()
  for (const record of counted) {
    if (record.verdict !== 'passed') continue
    passedOnce.add(wholeKey(record.mutant, record.file))
    if (record.alone) passedAlone.add(wholeKey(record.mutant, record.file))
  }
  /** Per file, the tests whose failing made it one to run alone; undefined for a failure that was no test's. */
  const gaveAway = new Map<string, Set<string | undefined>>()
  const suspect = (file: string, test: string | undefined) => gaveAway.set(file, (gaveAway.get(file) ?? new Set()).add(test))
  /** Per test, the sites of the mutants it failed and passed with while nothing else of its file was under way. */
  const unsteady = new Map<string, Set<number>>()
  /** Per file, when the last run of it was made that had the file to itself. */
  const lastAlone = new Map<string, number>()
  for (const record of counted) {
    if (record.alone) lastAlone.set(record.file, Math.max(lastAlone.get(record.file) ?? 0, record.at))
    const key = wholeKey(record.mutant, record.file)
    if (record.verdict === 'passed' || !passedOnce.has(key)) continue
    if (!record.alone || !passedAlone.has(key)) suspect(record.file, record.test)
    else if (record.test) {
      unsteady.set(record.test, (unsteady.get(record.test) ?? new Set()).add(siteOf?.[record.mutant] ?? record.mutant))
    }
  }
  for (const record of pairFailures) suspect(record.file, record.test)
  // A test that fails and passes with one mutant, nothing else of its file
  // under way, may wait on the clock, or the mutant may have made it a
  // matter of chance: a mutant in what seeds a test's input does. Either
  // way it is not runs getting in each other's way, and a file that nothing
  // but such tests gave away goes back to running side by side; kept to
  // one process at a time it would cost a second a run for a test that
  // sleeps one. What the test fails for other mutants still counts until
  // it has done the same with a mutant somewhere else in the code: one
  // mutant's doing must not cost another the test that detects it.
  for (const [test, sites] of unsteady) if (sites.size >= 2) flaky.add(test)
  for (const [file, tests] of gaveAway) {
    if ([...tests].some((test) => test === undefined || !unsteady.has(test))) exclusive.add(file)
  }
  // Getting in each other's way can make a run pass as well as fail, a file
  // one run wrote and another reads for one, so what ran side by side in a
  // file that was given away is dropped whatever it said, and stays dropped
  // when the file is let go again: only runs made after that count.
  const settled = new Set(
    counted.filter(
      (record) =>
        record.alone ||
        (!exclusive.has(record.file) && (!gaveAway.has(record.file) || record.at > (lastAlone.get(record.file) ?? 0))),
    ),
  )
  const evidence = new Map<number, Evidence[]>()
  const note = (mutant: number, entry: Evidence) => evidence.set(mutant, [...(evidence.get(mutant) ?? []), entry])
  /** Per mutant, the tests that failed with it and passed again without it, with no other run of their file about. */
  const witnesses = new Map<number, Set<string>>()
  for (const { mutant, file, test, passedAgain } of leads) {
    if (flaky.has(test)) continue
    note(mutant, { kind: 'lead', file, test })
    const files = suspects.get(mutant) ?? new Set()
    files.add(file)
    suspects.set(mutant, files)
    if (passedAgain) witnesses.set(mutant, (witnesses.get(mutant) ?? new Set()).add(test))
  }
  for (const record of wholeRecords) {
    const key = wholeKey(record.mutant, record.file)
    const entry = whole.get(key) ?? { runs: 0, repeated: 0, beside: 0, quiet: 0, knowing: 0, died: 0, failed: 0, timedOut: 0, passed: 0 }
    whole.set(key, entry)
    entry.runs++
    if (uncopied.has(record.file) && record.by && record.by !== 'started') plain.add(key)
    if (!settled.has(record)) continue
    if (record.verdict === 'passed') entry.passed++
    else if (record.test && flaky.has(record.test)) continue
    else if (record.died) entry.died++
    else if (record.verdict === 'failed') entry.failed++
    else entry.timedOut++
    if (record.verdict === 'passed') continue
    if (record.quiet) entry.quiet++
    if (record.knew) entry.knowing++
    note(record.mutant, { kind: record.died ? 'died' : record.verdict, file: record.file, test: record.test, by: record.by })
    if (record.died) continue
    if (record.by && !record.alone) entry.beside++
    // A worker the mutant had blocked under a test and a run of the file a limit ended say the same thing.
    if (
      (record.tests ?? (record.test === undefined ? [] : [record.test])).some((test) => witnesses.get(record.mutant)?.has(test)) ||
      (record.verdict === 'timeout' && blocked.get(record.mutant)?.has(record.file) === true)
    ) {
      entry.repeated++
    }
  }
  // Several workers may share a file, and one that reached its end says
  // nothing about a test another had taken and died on.
  const completeFiles = new Set<string>()
  for (const [key, entry] of whole) {
    const [id, file] = key.split('\n')
    const mutant = Number(id)
    const verdict = wholeVerdict(entry)
    if (verdict === 'failed') detected.set(mutant, MUTANT_KILLED)
    else if (verdict === 'timeout' && !detected.has(mutant)) detected.set(mutant, MUTANT_TIMEOUT)
  }
  for (const [file, runs] of finished) {
    if (runs.some((ids) => ids.every((id) => tests.has(id)))) completeFiles.add(file)
  }
  const pairWanted = new Set<string>()
  for (const [key, entry] of whole) {
    const file = key.split('\n')[1]
    if (entry.repeated > 0 || entry.passed > 0 || entry.beside < 2 || exclusive.has(file)) continue
    const pair = pairs.get(file)
    // Two tries at getting two runs to start together; a file that cannot be asked is left as it is.
    if (!pair || (pair.met < 2 && pair.asked < 2)) pairWanted.add(file)
  }
  return { tests, replay, retried, completeFiles, detected, taints, staticMutants, staticSites, sharing, plain, whole, reached, measured, suspects, blocked, flaky, wholeTook, evidence, witnesses, controls, uncopied, exclusive, lost, pairWanted, pairs, beside, triedSole }
}

/** The list rotated by an offset derived from `key`, so that lists are walked from different points. */
function rotate<T>(list: T[], key: string): T[] {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  const offset = Math.abs(hash) % list.length
  return [...list.slice(offset), ...list.slice(0, offset)]
}


/**
 * Mutants per claim: about a quarter second of a test's runs. A failing run
 * can take many times the unmutated one, when what fails is a wait that times
 * out, so a larger share would leave one worker with seconds of work that
 * idle ones could have taken.
 */
function chunkSize(baselineMs: number): number {
  return Math.max(1, Math.ceil(250 / Math.max(baselineMs, 1)))
}

/**
 * Plans the next round. Every pending mutant first goes to one test only: the
 * one that reached the most sites, which in measurements found a killer first
 * far more often than cheaper or narrower tests. Once each mutant has had
 * that try, every test gets to run whatever is still pending.
 */
/**
 * Whether mutants in code that only runs while a module loads are run too.
 * Each takes a run of every test file that loads the module, where one
 * that is detected stops at the first failure and one that is not goes
 * through them all: next to nothing where such code is rare, twice the
 * time in a library that builds tables as it loads and has many test files.
 */
let judgeStatic = false

type Planned = {
  plan: RoundPlan
  workByFile: Map<string, { workMs: number; chunks: number; wholeRuns: number; wholeMs: number }>
}

/**
 * The work of the next round. What settles a failure that settled nothing
 * comes last and in rounds of its own, one kind at a time: first the tests
 * that failed try the mutant, each file with one worker to itself, which is
 * what makes what they find count; then, for what is still open, a run of
 * the file with nothing else running.
 */
function planRound(...given: [ReturnType<typeof inspect>, Uint8Array, string[], Map<number, Set<string>>, ArrayLike<number>]): Planned {
  const usual = planPhase(...given, false)
  return usual.workByFile.size > 0 ? usual : planPhase(...given, true)
}

function planPhase(
  status: ReturnType<typeof inspect>,
  state: Uint8Array,
  files: string[],
  /** Per mutant, the tests that detected it in an earlier run. */
  killers: Map<number, Set<string>>,
  /** Per mutant, its site. */
  siteOf: ArrayLike<number>,
  /** Nothing else is left to do: the round is for what settles failures that settled nothing. */
  settling: boolean,
): Planned {
  // A mutant whose runs of a file failed without settling anything is back
  // among the pending ones for one purpose: the tests that failed are to
  // try it. Given to every test that reaches it, one test a round, it would
  // take as many rounds as there are tests.
  const only = new Map<number, Set<string>>()
  // One file settles a mutant, so the tests of one file try it: the file
  // whose tests take least. The others' turn comes if that one's run, made
  // with nothing else running, passes.
  const testsMs = new Map<string, number>()
  for (const test of status.tests.values()) {
    testsMs.set(test.file, (testsMs.get(test.file) ?? 0) + (test.coverage?.baselineMs ?? 0))
  }
  const unsettled = [...status.whole]
    .filter(([, entry]) => entry.passed === 0 && entry.repeated === 0 && entry.quiet === 0 && entry.failed + entry.timedOut + entry.died >= 2)
    .map(([key]) => ({ mutant: Number(key.split('\n')[0]), file: key.split('\n')[1] }))
    .sort((a, b) => (testsMs.get(a.file) ?? 0) - (testsMs.get(b.file) ?? 0))
  const settledIn = new Map<number, string>()
  for (const { mutant, file } of unsettled) {
    if (only.has(mutant)) continue
    settledIn.set(mutant, file)
    const failed = new Set<string>()
    for (const entry of status.evidence.get(mutant) ?? []) {
      if (entry.kind !== 'lead' && entry.test && entry.file === file) failed.add(entry.test)
    }
    only.set(mutant, failed)
  }
  // And a test that failed with the mutant next to other runs of its file
  // tries it once more with the file to itself: what it finds then counts.
  const again = (id: string, mutant: number) =>
    settling &&
    status.tests.get(id)?.file === settledIn.get(mutant) &&
    status.beside.get(mutant)?.has(id) === true &&
    !status.triedSole.get(mutant)?.has(id)
  const tries = (id: string, mutant: number) =>
    only.has(mutant) ? settling && (only.get(mutant)!.has(id) || again(id, mutant)) : !settling
  const remaining = new Map<string, number[]>()
  for (const [id, test] of status.tests) {
    if (test.done || !test.coverage) continue
    const left = test.coverage.covered.filter(
      (mutant) => state[mutant] === MUTANT_PENDING && (!test.judged.has(mutant) || again(id, mutant)) && tries(id, mutant),
    )
    if (left.length > 0) remaining.set(id, left)
  }

  // The test to try each pending mutant first, among all that reach it: one
  // that detected it in an earlier run if there is one, else the one that
  // reaches the most code.
  const candidates = new Map<number, string[]>()
  for (const [id, test] of status.tests) {
    if (test.done || !test.coverage) continue
    for (const mutant of test.coverage.covered) {
      if (state[mutant] !== MUTANT_PENDING || !tries(id, mutant)) continue
      const list = candidates.get(mutant)
      if (list) list.push(id)
      else candidates.set(mutant, [id])
    }
  }
  // While any of those first tries is still open, only they are planned.
  const picks = new Map<string, number[]>()
  for (const [mutant, ids] of candidates) {
    const known = killers.get(mutant)
    const coverage = (id: string) => status.tests.get(id)!.coverage!
    ids.sort(
      (a, b) =>
        Number(known?.has(b) ?? false) - Number(known?.has(a) ?? false) ||
        coverage(b).sites - coverage(a).sites ||
        coverage(a).baselineMs - coverage(b).baselineMs,
    )
    const first = ids[0]
    if (!status.tests.get(first)!.judged.has(mutant)) picks.set(first, [...(picks.get(first) ?? []), mutant])
  }
  const lists = picks.size > 0 ? picks : remaining

  let jobs = 0
  const plan: RoundPlan = {
    replay: [...status.replay],
    retried: [...status.retried],
    tests: {},
    probe: {},
    pristine: [],
    exclusive: [...status.exclusive],
    sole: [],
    settling: false,
    quiet: false,
    whole: {},
  }
  const workByFile = new Map<string, { workMs: number; chunks: number; wholeRuns: number; wholeMs: number }>()
  const addWork = (file: string, workMs: number, chunks: number, wholeRuns = 0) => {
    const entry = workByFile.get(file) ?? { workMs: 0, chunks: 0, wholeRuns: 0, wholeMs: 0 }
    entry.workMs += workMs
    entry.chunks += chunks
    entry.wholeRuns += wholeRuns
    workByFile.set(file, entry)
  }
  // A test whose unmutated run failed gets another, after the tests before
  // it have run as in a plain run. They have not if a test before it tried
  // mutants in the same worker: what a mutant leaves in a module or in the
  // document is there for the tests that follow. So in a file with such a
  // test nothing tries a mutant in that round.
  const retrying = new Set<string>()
  for (const test of status.tests.values()) if (test.retry && !test.done) retrying.add(test.file)
  for (const [id, list] of lists) {
    // Tests that run at the same time would otherwise all start on the same
    // mutants, and a kill by one comes too late to spare the others.
    const mutants = rotate(list, id)
    const { coverage, file } = status.tests.get(id)!
    if (retrying.has(file)) continue
    const chunk = chunkSize(coverage!.baselineMs)
    plan.tests[id] = { mutants, chunk, baselineMs: coverage!.baselineMs, baselineLoops: coverage!.baselineLoops }
    addWork(file, mutants.length * coverage!.baselineMs, Math.ceil(mutants.length / chunk))
  }
  for (const [id, test] of status.tests) {
    if (!test.retry || test.done) continue
    plan.tests[id] = { chunk: 1, baselineMs: 0, baselineLoops: 0 }
    addWork(test.file, 1000, 1)
  }
  plan.pristine.push(...retrying)
  // A worker that died during the first round left the rest of its file
  // without coverage; those tests are probed again, in order.
  for (const file of files) {
    if (status.completeFiles.has(file)) continue
    plan.probe[file] = [...status.tests].filter(([, test]) => test.file === file && test.coverage).map(([id]) => id)
    addWork(file, 5000, 1)
  }
  // What is still pending once nothing else is left to try has survived
  // every test with the mutant on for that test only, in a worker that had
  // run the test before and other mutants with it. That is not how the
  // mutant would meet the suite: it says nothing about what the mutant does
  // while a file loads, where tests may only compare what was computed
  // then, about code that only acts the first time it runs in a process, or
  // about a test passing on what an earlier mutant left in shared data. So a
  // mutant only counts as survived once every file it can change has passed
  // with it on from the start.
  // Which files a mutant can change is read from what the tests' unmutated
  // runs saw. A run made after mutants had been tried in the same worker may
  // have seen what one of them left behind, so such a file is measured again
  // first, with no mutant tried.
  if (workByFile.size === 0) {
    for (const test of status.tests.values()) {
      if (!test.coverage || test.pristine || status.measured.has(test.file) || test.file in plan.probe) continue
      plan.probe[test.file] = []
      plan.pristine.push(test.file)
      addWork(test.file, 5000, 1)
    }
  }
  const failing = new Map<string, string[]>()
  const fileMs = new Map<string, number>()
  const fileLoops = new Map<string, number>()
  for (const [id, test] of status.tests) {
    fileMs.set(test.file, (fileMs.get(test.file) ?? 0) + (test.coverage?.baselineMs ?? 0))
    fileLoops.set(test.file, (fileLoops.get(test.file) ?? 0) + (test.coverage?.baselineLoops ?? 0))
    if (test.failed || status.flaky.has(id)) failing.set(test.file, [...(failing.get(test.file) ?? []), id])
  }
  const controlled = new Set<string>()
  /** Runs that are to be made with nothing else running, which is a round of their own. */
  const quietJobs: [number, string][] = []
  const wholeJob = (mutant: number, file: string, confirm: boolean, quiet = false) => {
    const entry = status.whole.get(wholeKey(mutant, file))
    // Unless a test of the file has given a lead that no run so far knew of: a run that goes on to it comes first.
    const unknown =
      entry?.knowing === 0 && [...(status.witnesses.get(mutant) ?? [])].some((id) => status.tests.get(id)?.file === file)
    if (!quiet && !unknown && entry && entry.passed === 0 && entry.repeated === 0 && entry.failed + entry.timedOut + entry.died >= 2) {
      quietJobs.push([mutant, file])
      return
    }
    const hung = entry !== undefined && entry.timedOut + entry.died > 0
    const early =
      status.sharing.has(file) ||
      !status.staticSites.has(file) ||
      status.staticSites.get(file)!.has(siteOf[mutant])
    ;(plan.whole[file] ??= []).push({
      id: jobs++,
      mutant,
      ignore: failing.get(file) ?? [],
      fileMs: fileMs.get(file) ?? 0,
      fileLoops: fileLoops.get(file) ?? 0,
      // Timing out under a test counts like having blocked a worker, and so
      // does a run of this file that a limit ended or that took its worker with it.
      stalled: state[mutant] === MUTANT_STALLED || state[mutant] === MUTANT_TIMEOUT || hung,
      confirm,
      quiet,
      exclusive: status.exclusive.has(file),
      witnesses: [...(status.witnesses.get(mutant) ?? [])].filter((id) => status.tests.get(id)?.file === file),
      site: siteOf[mutant],
      // Until an unmutated run of the file has said what runs while it loads, anything may.
      early,
      // A copy that runs into a limit holds up the copies due after it for
      // as long as that takes, a second or more where a loop does not end;
      // started for the run, the workers of such mutants wait side by side.
      plain:
        status.plain.has(wholeKey(mutant, file)) ||
        status.uncopied.has(file) ||
        hung ||
        state[mutant] === MUTANT_STALLED ||
        state[mutant] === MUTANT_TIMEOUT,
    })
    const job = plan.whole[file].at(-1)!
    const by = early ? 'copied before load' : 'copied after load'
    if (cloning && !job.plain && status.lost.has(file) && !status.controls.has(`${by}\n${file}`) && !controlled.has(`${by}\n${file}`)) {
      controlled.add(`${by}\n${file}`)
      // First in the list, so that the worker that takes the file's jobs makes this run before theirs.
      plan.whole[file].unshift({ ...job, id: jobs++, mutant: -1, control: true, confirm: true, witnesses: [], site: -1, stalled: false })
    }
    addWork(file, 0, 0, 1)
    // What a run of the file takes with a mutant on is not what its tests
    // took without one: a mutant can leave a test waiting out its time
    // limit, five seconds where the file takes five milliseconds, and a
    // file planned by the latter gets one worker to make such runs one
    // after another. Where runs have been made, what they took counts.
    const took = status.wholeTook.get(file)
    workByFile.get(file)!.wholeMs = Math.max(fileMs.get(file) ?? 0, took ? took.ms / took.runs : 0)
  }
  if (workByFile.size === 0) {
    const covering = new Map<number, Set<string>>()
    for (const test of status.tests.values()) {
      // What only the hooks after a test meet no test tried, and the file's run is all there is.
      for (const mutant of [...(test.coverage?.covered ?? []), ...(test.coverage?.cleanup ?? [])]) {
        if (state[mutant] !== MUTANT_PENDING && state[mutant] !== MUTANT_STALLED) continue
        const set = covering.get(mutant) ?? new Set()
        set.add(test.file)
        covering.set(mutant, set)
      }
    }
    let wholeRuns = 0
    let wholeFailures = 0
    for (const [key, entry] of status.whole) {
      // A run made to check a failure a test already had is expected to fail.
      const [mutant, file] = key.split('\n')
      if (status.suspects.get(Number(mutant))?.has(file)) continue
      wholeRuns += entry.died + entry.failed + entry.timedOut + entry.passed
      wholeFailures += entry.died + entry.failed + entry.timedOut
    }
    const rarelyFails = wholeRuns >= 50 && wholeFailures < wholeRuns / 20
    for (let mutant = 0; mutant < state.length; mutant++) {
      // Code no test reaches is reported as such and not run.
      if (state[mutant] !== MUTANT_PENDING && state[mutant] !== MUTANT_STALLED) continue
      if (!status.reached.has(siteOf[mutant]) && !judgeStatic) continue
      const targets = new Set(covering.get(mutant))
      for (const [file, mutants] of status.staticMutants) if (mutants.has(mutant)) targets.add(file)
      const open = [...targets].filter(
        (file) => !wholeVerdict(status.whole.get(wholeKey(mutant, file))),
      )
      // A failure seen once is run again before anything else: repeated, it
      // ends the search. Otherwise the cheapest files go first, a few at a
      // time and twice as many each round, so that a mutant some file
      // detects costs little and one that survives few rounds. Where these
      // runs have rarely failed so far there is little to stop early for,
      // and every round ends on its slowest run, so the rest goes at once.
      const suspect = open.filter((file) => status.whole.has(wholeKey(mutant, file)))
      open.sort((a, b) => (fileMs.get(a) ?? 0) - (fileMs.get(b) ?? 0))
      // Where a run is a copy of a worker, a round costs more than the runs
      // it saves: a few files first, then all that is left.
      const done = targets.size - open.length
      const wave = cloning ? (done > 0 ? open.length : 4) : Math.max(1, done)
      const batch = suspect.length > 0 ? suspect : rarelyFails ? open : open.slice(0, wave)
      for (const file of batch) wholeJob(mutant, file, false)
    }
  }
  // A test that failed with a mutant while trying it names the file to run
  // whole with the mutant on; these go out as they come, next to whatever
  // else the round does. One file at a time, the cheapest first: the file
  // failing settles it.
  for (const [mutant, files] of status.suspects) {
    if (status.detected.has(mutant)) continue
    const open = [...files].filter((file) => !wholeVerdict(status.whole.get(wholeKey(mutant, file))))
    if (open.length === 0) continue
    open.sort((a, b) => (fileMs.get(a) ?? 0) - (fileMs.get(b) ?? 0))
    wholeJob(mutant, open[0], true)
  }
  // The two runs of a pair wait for each other, each holding a worker, which takes two.
  // Every file of such a round has one worker, see the main loop.
  plan.settling = settling && workByFile.size > 0
  if (settling && workByFile.size === 0 && Object.keys(plan.whole).length === 0) {
    // One failure made this way settles a mutant, so one file each, the
    // cheapest, and another only once that one has passed.
    quietJobs.sort((a, b) => (fileMs.get(a[1]) ?? 0) - (fileMs.get(b[1]) ?? 0))
    const asked = new Set<number>()
    for (const [mutant, file] of quietJobs) {
      if (asked.has(mutant)) continue
      asked.add(mutant)
      wholeJob(mutant, file, false, true)
    }
    plan.quiet = quietJobs.length > 0
    if (plan.quiet) return { plan, workByFile }
  }
  for (const file of workers < 2 ? [] : status.pairWanted) {
    for (let i = 0; i < 2; i++) {
      // First in the list: the first workers the file gets take what stands first.
      ;(plan.whole[file] ??= []).unshift({
        id: jobs++,
        mutant: -1,
        ignore: failing.get(file) ?? [],
        fileMs: fileMs.get(file) ?? 0,
        fileLoops: fileLoops.get(file) ?? 0,
        stalled: false,
        control: true,
        pair: true,
        site: -1,
        early: true,
        // Each in a worker of its own, so that the two can be under way together.
        plain: true,
      })
    }
    addWork(file, 0, 0, 2)
    workByFile.get(file)!.wholeMs ||= fileMs.get(file) ?? 0
  }
  return { plan, workByFile }
}

/**
 * The addon that copies a worker process, for this platform: built here by
 * `pnpm build:native`, or installed as the package made for the platform.
 */
function cloneAddon(): string | undefined {
  const target = addonTarget()
  if (!target) return undefined
  const built = path.join(import.meta.dirname, `../build/fork.${target.name}.node`)
  if (fs.existsSync(built)) return built
  try {
    return createRequire(import.meta.url).resolve(`vitant-${target.name}`)
  } catch {
    return undefined
  }
}
/** Whether whole-file runs are made in copies of a worker. */
let cloning = false
/** How many workers a round may have at once. */
let workers = 1
// A copy of a process has none of its other threads, so a worker that is
// going to be copied must not leave work to any.
const workerArgv: string[] = []

/** Runs files in the order given; Vitest's default reorders them by size and past duration. */
class PlannedOrder {
  async sort<T>(files: T[]): Promise<T[]> {
    return files
  }

  async shard<T>(files: T[]): Promise<T[]> {
    return files
  }
}

/**
 * Writes a cached run's results for the test files that are still fresh, as
 * if the first round had just produced them. Returns those files.
 */
function restore(
  cache: Cache,
  files: string[],
  generated: Generated,
  keys: string[],
  root: string,
  paths: ReturnType<typeof sessionPaths>,
): Set<string> {
  const idByKey = new Map(keys.map((key, id) => [key, id]))
  const bySource = new Map<string, string[]>()
  generated.mutants.forEach((mutant, id) => {
    const source = path.relative(root, mutant.file)
    bySource.set(source, [...(bySource.get(source) ?? []), keys[id]])
  })
  const ids = (list: string[]) => list.flatMap((key) => idByKey.get(key) ?? [])
  const sites = (list: string[]) => [...new Set(ids(list).map((id) => generated.mutants[id].site))]
  const reused = new Set<string>()
  const lines: string[] = []
  const verdicts = new Map<number, number>()
  for (const file of files) {
    const cached = cache.files[path.relative(root, file)]
    if (!cached || !isFresh(cached, root, cache, bySource)) continue
    reused.add(file)
    lines.push(
      JSON.stringify({
        type: 'file',
        file,
        tests: Object.keys(cached.tests),
        staticSites: sites(cached.staticSites),
        hookSites: sites(cached.hookSites),
        staticMutants: ids(cached.staticMutants ?? []),
        complete: true,
        modules: Object.keys(cached.deps).map((dep) => path.join(root, dep)),
        at: 0,
      }),
    )
    for (const [key, verdict] of Object.entries(cached.whole ?? {})) {
      const mutant = idByKey.get(key)
      if (mutant === undefined) continue
      if (verdict === 'failed') verdicts.set(mutant, MUTANT_KILLED)
      else if (verdict === 'timeout' && !verdicts.has(mutant)) verdicts.set(mutant, MUTANT_TIMEOUT)
      // A failure only counts when seen twice.
      for (let i = 0; i < (verdict === 'passed' ? 1 : 2); i++) {
        // What an earlier run of the tool settled it settled by these rules.
        lines.push(JSON.stringify({ type: 'whole', file, mutant, verdict, quiet: true, at: 0 }))
      }
    }
    for (const [id, test] of Object.entries(cached.tests)) {
      const killed = ids(test.killed)
      const timedOut = ids(test.timedOut)
      for (const mutant of killed) verdicts.set(mutant, MUTANT_KILLED)
      // A mutant one test kills and another times out on counts as killed.
      for (const mutant of timedOut) if (!verdicts.has(mutant)) verdicts.set(mutant, MUTANT_TIMEOUT)
      const record: TestRecord & { at: number } = {
        type: 'test',
        file,
        id,
        name: test.name,
        mode: 'probe',
        baseline: test.baseline,
        pristine: true,
        baselineMs: test.baselineMs,
        baselineLoops: test.baselineLoops,
        baselineRetry: false,
        nonRepeatable: test.nonRepeatable,
        needsReplay: false,
        replayed: true,
        ms: 0,
        cpuMs: 0,
        attempts: 0,
        sites: sites(test.sites),
        covered: ids(test.covered),
        cleanup: ids(test.cleanup),
        killed,
        timedOut,
        survived: ids(test.survived),
        unverified: [],
        at: 0,
      }
      lines.push(JSON.stringify(record))
    }
  }
  for (const [mutant, verdict] of verdicts) writeStateByte(paths.state, mutant, verdict)
  if (lines.length > 0) fs.writeFileSync(path.join(paths.results, 'cache.jsonl'), `${lines.join('\n')}\n`)
  return reused
}

function writeStateByte(file: string, mutant: number, value: number): void {
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, new Uint8Array([value]), 0, 1, mutant)
  fs.closeSync(fd)
}

/** Reads what the workers wrote, parsing only what was appended since the last call. */
function recordReader(dir: string): () => SessionRecord[] {
  const read = new Map<string, number>()
  const records: SessionRecord[] = []
  return () => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      const from = read.get(name) ?? 0
      const size = fs.statSync(file).size
      if (size === from) continue
      const fd = fs.openSync(file, 'r')
      const chunk = Buffer.alloc(size - from)
      fs.readSync(fd, chunk, 0, chunk.length, from)
      fs.closeSync(fd)
      // A worker killed mid-write leaves a line without its end; it is not counted as read.
      const end = chunk.lastIndexOf(10) + 1
      for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
        if (line) records.push(JSON.parse(line))
      }
      read.set(name, from + end)
    }
    // Later records about the same test supersede earlier ones.
    return records.sort((a, b) => a.at - b.at)
  }
}

function writeSession(
  dir: string,
  generated: Generated,
  options: RunOptions,
  major: number,
  vitestPackage: string,
): SessionConfig {
  const paths = sessionPaths(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(paths.results, { recursive: true })
  fs.mkdirSync(paths.trying)
  fs.mkdirSync(paths.again)
  fs.mkdirSync(paths.locks)
  const config: SessionConfig = {
    runtimeGlobal: RUNTIME_GLOBAL,
    siteCount: generated.siteMutants.length - 1,
    mutantCount: generated.mutants.length,
    timeoutFactor: options.timeoutFactor,
    timeoutMs: options.timeoutMs,
    recycleHeapBytes: options.recycleHeapMb * 1024 * 1024,
    cheapMs: options.cheapMs,
    loopFactor: options.loopFactor,
    loopSlack: options.loopSlack,
  }
  fs.writeFileSync(paths.config, JSON.stringify(config))
  fs.writeFileSync(paths.preload, channelWatch)
  fs.writeFileSync(paths.sites, new Uint8Array(generated.siteMutants.buffer))
  fs.writeFileSync(paths.tracked, generated.tracked)
  fs.writeFileSync(paths.state, new Uint8Array(generated.mutants.length))
  const runtime = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime/runner.ts'),
  ).href
  // Vitest 5 does not have `@vitest/spy` among its own dependencies everywhere, and nothing here needs it there.
  const spy = () => pathToFileURL(createRequire(vitestPackage).resolve('@vitest/spy')).href
  const imports =
    major >= 5
      ? `import { TestRunner as Base, vi } from 'vitest'\nconst getFn = Base.getTestFn\nconst mocks = undefined`
      : `import { vi } from 'vitest'\nimport { VitestTestRunner as Base } from 'vitest/runners'\n` +
        `import { getFn } from 'vitest/suite'\nimport * as spy from ${JSON.stringify(spy())}\nconst mocks = spy.mocks`
  fs.writeFileSync(
    paths.runner,
    `${imports}\nimport { withMutationTesting } from ${JSON.stringify(runtime)}\n` +
      `export default withMutationTesting(Base, { major: ${major}, vi, getFn, mocks })\n`,
  )
  return config
}

interface SuiteTask {
  type: string
  name: string
  filepath?: string
  result?: { errors?: { message: string }[] }
  tasks?: SuiteTask[]
}

function collectSuiteErrors(task: SuiteTask, root: string, into: string[]): void {
  if (task.type === 'test') return
  for (const error of task.result?.errors ?? []) {
    const where = task.filepath ? path.relative(root, task.filepath) : task.name
    into.push(`${where}: ${error.message.split('\n')[0]}`)
  }
  for (const child of task.tasks ?? []) collectSuiteErrors(child, root, into)
}

/**
 * Instrumentation only inserts text within a line, so mapping every line to
 * itself keeps stack traces on the right line without tracking columns.
 */
function lineMap(file: string, source: string) {
  const lines = source.split('\n').length
  return {
    version: 3,
    sources: [file],
    sourcesContent: [source],
    names: [],
    mappings: `AAAA${';AACA'.repeat(lines - 1)}`,
  }
}

/**
 * Workers here end themselves on purpose, and die of mutants. The pool
 * Vitest uses up to version 3 answers a worker's unexpected exit by
 * sending it a teardown task. The send fails, the failure counts as another
 * error of that worker, and it is answered the same way: a loop that keeps
 * this process busy until the run ends, while every worker waits on it for
 * its modules. Workers here end themselves on purpose, for their memory or
 * because a mutant blocks them, so what is sent to one that is gone is dropped.
 */
function dropSendsToDeadWorkers(): void {
  const fork = childProcess.fork
  childProcess.fork = ((...args: Parameters<typeof fork>) => {
    const child = fork(...args)
    const send = child.send
    child.send = ((...sendArgs: unknown[]) => {
      if (!child.connected) return false
      // A worker can be gone before its channel is known to be closed. The
      // send then fails later; without someone to tell, that is an error
      // event on the child, which Vitest 4 passes on to nobody and which
      // ends this process.
      if (typeof sendArgs.at(-1) !== 'function') sendArgs.push(() => {})
      return (send as (...args: unknown[]) => boolean).apply(child, sendArgs)
    }) as typeof send
    return child
  }) as typeof fork
  syncBuiltinESMExports()
}

/**
 * The files under version control that differ from the last commit, each
 * with what it holds; nothing where there is no repository. By what they
 * hold and not by git's word alone: a file someone was already working on
 * reads as changed before the run and after it, whatever a test did to it
 * in between.
 */
function workingTree(root: string): Map<string, string> {
  const git = (args: string[]) => childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  const top = git(['rev-parse', '--show-toplevel'])
  const status = git(['status', '--porcelain', '-z', '--untracked-files=no'])
  const tree = new Map<string, string>()
  if (top.status !== 0 || status.status !== 0) return tree
  const entries = status.stdout.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    // A rename is followed by the name the file had.
    if (entry[0] === 'R' || entry[0] === 'C') i++
    const file = path.join(top.stdout.trim(), entry.slice(3))
    let held = 'gone'
    try {
      held = createHash('sha1').update(fs.readFileSync(file)).digest('hex')
    } catch {}
    tree.set(file, `${entry.slice(0, 2)} ${held}`)
  }
  return tree
}

/** The files of `workingTree` that are not as they were, relative to the project. */
function changedSince(before: Map<string, string>, root: string): string[] {
  return [...workingTree(root)].filter(([file, held]) => before.get(file) !== held).map(([file]) => path.relative(root, file))
}

export async function run(options: RunOptions): Promise<RunResult> {
  const startedAt = performance.now()
  const treeBefore = workingTree(options.root)
  let treeWarned = false
  const leftOut: RunResult['leftOut'] = { projects: {}, typeTests: 0 }
  judgeStatic = options.static
  const generated = generate(options)
  const generateMs = performance.now() - startedAt
  options.log(
    `${generated.mutants.length} mutants in ${generated.files.size} files (${Math.round(generateMs)} ms)`,
  )

  const projectRequire = createRequire(path.join(options.root, 'package.json'))
  const vitestPackage = projectRequire.resolve('vitest/package.json')
  const vitestVersion: string = JSON.parse(fs.readFileSync(vitestPackage, 'utf8')).version
  const { createVitest } = await import(
    pathToFileURL(path.join(path.dirname(vitestPackage), 'dist/node.js')).href
  )

  // The runner shim imports `vitest` by bare specifier, so it has to live
  // where Node resolves that to the project's own copy.
  const sessionDir = path.join(options.root, 'node_modules/.vitant/session')
  const paths = sessionPaths(sessionDir)
  const major = Number(vitestVersion.split('.')[0])
  if (major < 3) throw new Error(`Vitest ${vitestVersion} is not supported; 3.0 or later is needed`)
  const config = writeSession(sessionDir, generated, options, major, vitestPackage)
  process.env.VITANT_SESSION = sessionDir
  // `globalSetup` files load in this process and may import instrumented code.
  ;(globalThis as Record<string, unknown>)[RUNTIME_GLOBAL] = createRuntime(
    generated.siteMutants.length,
    generated.mutants.length,
  )

  // Limits decide what counts as a timeout, so results from other limits do not carry over.
  const limits = [options.timeoutFactor, options.timeoutMs, options.loopFactor, options.loopSlack]
  const print = fingerprint(options.root, vitestVersion, limits)
  const keys = options.incremental ? mutantKeys(generated, options.root) : []
  const cache = options.incremental ? loadCache(options.root, print) : undefined
  const hints = options.incremental ? hintKeys(generated, options.root) : []
  const earlierKillers = options.incremental ? loadKillers(options.root) : {}

  dropSendsToDeadWorkers()
  // Every run of a file starts a process that compiles Vitest, the test
  // environment and the dependencies again; where files are small that is
  // most of what a run costs.
  process.env.NODE_COMPILE_CACHE ??= path.join(options.root, 'node_modules/.vitant/compile-cache')
  const instrumentPlugin = {
    name: 'vitant:instrument',
    enforce: 'pre' as const,
    // Projects declared in the config get their own servers, which take
    // neither the plugins nor the runner given to the root.
    config(config: { test?: Record<string, unknown> & { projects?: unknown[] } }) {
      // What the project starts its workers with stays: tests can depend
      // on it, `--expose-gc` for one.
      const withArgv = (test: Record<string, unknown> = {}): Record<string, unknown> => {
        if (major >= 4) return { ...test, execArgv: [...((test.execArgv as string[]) ?? []), ...workerArgv] }
        const pools = (test.poolOptions ?? {}) as { forks?: { execArgv?: string[] } }
        const forks = { ...pools.forks, isolate: true, execArgv: [...(pools.forks?.execArgv ?? []), ...workerArgv] }
        return { ...test, poolOptions: { ...pools, forks } }
      }
      for (const project of config.test?.projects ?? []) {
        if (typeof project !== 'object' || project === null) continue
        const inline = project as { plugins?: unknown[]; test?: Record<string, unknown> }
        inline.plugins = [...(inline.plugins ?? []), instrumentPlugin]
        inline.test = { ...withArgv(inline.test), runner: paths.runner }
      }
      config.test = withArgv(config.test)
    },
    // As the file is loaded rather than as a transform of what was
    // loaded: other plugins rewrite the source first, `import.meta.env`
    // for one, and what they hand on no longer has the offsets the
    // mutants were placed at.
    load(id: string) {
      // An alias can leave a doubled slash in the id.
      const entry = generated.files.get(path.normalize(id.split('?')[0]))
      return entry && { code: entry.code, map: lineMap(id, entry.source) }
    },
  }
  const vitestStartedAt = performance.now()
  const addon = options.clone ? cloneAddon() : undefined
  cloning = addon !== undefined
  workers = options.maxWorkers
  workerArgv.length = 0
  if (addon) {
    workerArgv.push('--single-threaded', `--require=${paths.preload}`)
    process.env.VITANT_FORK = addon
  } else {
    delete process.env.VITANT_FORK
    if (options.clone) options.log('whole-file runs start a worker each: no addon for this platform (pnpm build:native)')
  }
  const vitest = await createVitest(
    'test',
    {
      root: options.root,
      ...(options.projects.length > 0 ? { project: options.projects } : {}),
      watch: false,
      runner: paths.runner,
      pool: 'forks',
      // A fresh worker has to mean fresh modules.
      ...(major < 4 ? {} : { isolate: true }),
      sequence: { sequencer: PlannedOrder },
      maxWorkers: options.maxWorkers,
      // The pool only starts a worker while it has fewer workers than queued
      // files, so with a few long runs in flight the last, short ones wait for
      // those to end although most of the workers allowed are not in use.
      // Keeping the full number alive lets them start at once.
      minWorkers: options.maxWorkers,
      reporters: [{}],
      coverage: { enabled: false },
      typecheck: { enabled: false },
      // One run failing must not call off the others of its round.
      bail: 0,
      passWithNoTests: true,
      ...(options.related ? { related: [...generated.files.keys()] } : {}),
    },
    {
      plugins: [instrumentPlugin],
    },
  )

  // Outside CI Vitest writes any snapshot it has not seen before and passes,
  // which would let a mutant that reaches a new snapshot survive and leave
  // the file on disk.
  for (const project of vitest.projects ?? [vitest]) {
    project.config.snapshotOptions.updateSnapshot = 'none'
  }
  vitest.config.snapshotOptions.updateSnapshot = 'none'

  // A worker that stops itself, for its memory or because a mutant blocks it,
  // can die while the pool is sending it a message. The send then rejects
  // with nobody to catch it, and Vitest ends the whole process on that.
  const fatal = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (error, promise) => {
    const { code, message } = (error ?? {}) as { code?: string; message?: string }
    if (code === 'ERR_IPC_CHANNEL_CLOSED' || code === 'EPIPE') return
    if (message === 'Worker exited unexpectedly') return
    for (const listener of fatal) listener(error, promise)
  })

  // Vitest keeps every console message a test prints, and mutant runs print
  // far more than the suite normally does: thousands of repeats of the same
  // warning would otherwise stay in this process until it exits.
  let consoleMessages = 0
  vitest.state.updateUserLog = () => {
    consoleMessages++
  }

  const readRecords = recordReader(paths.results)
  const abandonedFiles: string[] = []
  const suiteErrors: string[] = []
  let rounds = 0
  try {
    await (vitest.standalone ?? vitest.init).call(vitest)
    type Spec = { moduleId: string; pool?: string; project: { name: string; config: { runner?: string; related?: unknown } } }
    let found: Spec[]
    try {
      found = await vitest.getRelevantTestSpecifications(options.filters)
    } catch (error) {
      if (!options.related) throw error
      // Finding the test files that import a mutated file means transforming
      // every test file, and one that cannot be transformed fails the search
      // where in a plain run it would only fail itself.
      options.log(`could not tell which test files import the mutated files, so all of them run: ${String((error as Error).message).split('\n')[0]}`)
      vitest.config.related = undefined
      for (const project of vitest.projects ?? []) project.config.related = undefined
      found = await vitest.getRelevantTestSpecifications(options.filters)
    }
    // A project that came from a config file of its own is given the runner
    // with everything else on the command line, and not the plugin that puts
    // the mutants into the sources: its tests would run, reach nothing that
    // can change, and every mutant would be reported as one no test covers.
    // A file two projects share would need its results kept per project.
    const instrumented = (project: unknown): boolean => {
      const { vite, server } = project as Record<'vite' | 'server', { config: { plugins: readonly { name: string }[] } } | undefined>
      return (vite ?? server)?.config.plugins.some((plugin) => plugin.name === instrumentPlugin.name) === true
    }
    const taken = new Set<string>()
    const specs = found.filter((spec) => {
      // Type tests run in the type checker, not in a worker.
      if (spec.pool === 'typescript') {
        leftOut.typeTests++
        return false
      }
      const usable = spec.project.config.runner === paths.runner && instrumented(spec.project) && !taken.has(spec.moduleId)
      if (usable) taken.add(spec.moduleId)
      else leftOut.projects[spec.project.name] = (leftOut.projects[spec.project.name] ?? 0) + 1
      return usable
    })
    const left = Object.keys(leftOut.projects)
    if (left.length > 0) options.log(`not run for project(s): ${left.join(', ')}`)
    const files = specs.map((spec) => spec.moduleId)
    const reused = cache ? restore(cache, files, generated, keys, options.root, paths) : new Set<string>()
    if (options.incremental) options.log(`${reused.size} of ${files.length} test file(s) reused from the last run`)
    // Biggest files first, so the longest ones do not start last.
    const size = (spec: { moduleId: string }) => fs.statSync(spec.moduleId).size
    let plan = specs.filter((spec) => !reused.has(spec.moduleId)).sort((a, b) => size(b) - size(a))
    const siteOf = generated.mutants.map((mutant) => mutant.site)
    let progress = -1
    /** Whether the round in flight has whole-file runs. */
    let copying = false
    /** The whole-file runs of the round in flight, with how many records each pair had before it. */
    let planned: { id: number; mutant: number; file: string; had: number; plain: boolean; alone: boolean; quiet: boolean; knew: boolean }[] = []
    let stalled = 0
    // Round one runs every test once, unmutated, and lets only fast tests try
    // their mutants. Later rounds follow a plan: first each mutant in the one
    // test most likely to kill it, then in every test that may still see it.
    for (;;) {
      if (plan.length > 0) {
        fs.rmSync(paths.claims, { recursive: true, force: true })
        fs.mkdirSync(paths.claims)
        const roundStartedAt = performance.now()
        // Only workers that are to be copied need V8 to keep to one thread,
        // which slows down the tests they run themselves. Before Vitest 4
        // the pool takes its arguments once, for all rounds.
        if (cloning && major >= 4) {
          for (const project of new Set(plan.map((spec) => spec.project))) {
            const config = project.config as { execArgv?: string[] }
            const own = (config.execArgv ?? []).filter((argument) => !workerArgv.includes(argument))
            config.execArgv = copying ? [...own, ...workerArgv] : own
          }
        }
        // A worker stopped while it held a lock would keep the others waiting for good.
        const sweeping = setInterval(() => sweep(paths.locks), 100)
        try {
          await vitest.runTestSpecifications(plan, true)
        } finally {
          clearInterval(sweeping)
        }
        rounds++
        const seconds = ((performance.now() - roundStartedAt) / 1000).toFixed(1)
        const detected = fs.readFileSync(paths.state).filter((value) => value !== MUTANT_PENDING).length
        options.log(`round ${rounds} took ${seconds}s, ${detected} mutants detected so far`)
        // Said at once, while it is one round's worth of runs that saw the file and not all of them.
        if (!treeWarned) {
          const changed = changedSince(treeBefore, options.root)
          if (changed.length > 0) {
            treeWarned = true
            options.log(`tests left ${changed.length} file(s) under version control changed, ${changed[0]} for one: runs from here on see them`)
          }
        }
      }

      const state = fs.readFileSync(paths.state)
      let status = inspect(readRecords(), siteOf)
      // A whole-file run that blocks is stopped by the watchdog, which marks
      // the mutant and kills the worker before it can write its verdict.
      const total = (entry?: WholeState) => entry?.runs ?? 0
      const stopped = planned.filter(
        (job) =>
          state[job.mutant] === MUTANT_TIMEOUT &&
          total(status.whole.get(wholeKey(job.mutant, job.file))) === job.had &&
          fs.existsSync(path.join(paths.claims, `whole.${job.id}`)),
      )
      // A run that was taken on and left no word otherwise ended with its
      // process. In a worker started for it, that is how the suite would go
      // with the mutant: a worker that dies fails the run. Anywhere else the
      // process may have died of something a worker started for the run
      // would not meet, so that is where the run is made next.
      const silent = planned.filter(
        (job) =>
          !stopped.includes(job) &&
          total(status.whole.get(wholeKey(job.mutant, job.file))) === job.had &&
          (job.plain || !status.plain.has(wholeKey(job.mutant, job.file))) &&
          fs.existsSync(path.join(paths.claims, `whole.${job.id}`)),
      )
      const lines = [
        ...stopped.map(({ mutant, file, alone, quiet, knew }) => ({ type: 'whole', file, mutant, verdict: 'timeout', alone, quiet, knew, by: 'started' })),
        ...silent.map(({ mutant, file, plain, alone, quiet, knew }) =>
          plain
            ? { type: 'whole', file, mutant, verdict: 'failed', died: true, alone, quiet, knew, by: 'started' }
            : { type: 'plain', file, mutant },
        ),
      ].map((record) => JSON.stringify({ ...record, at: Date.now() }))
      if (lines.length > 0) {
        fs.appendFileSync(path.join(paths.results, 'main.jsonl'), `${lines.join('\n')}\n`)
        status = inspect(readRecords(), siteOf)
      }
      // A worker that died with a mutant on for a test is taken to have died
      // of it, which a test cannot be asked about again; like a mutant that
      // blocked its worker, it is left to the runs of whole files.
      for (const name of fs.readdirSync(paths.trying)) {
        const file = path.join(paths.trying, name)
        const mutant = new Int32Array(new Uint8Array(fs.readFileSync(file)).buffer)[0]
        fs.rmSync(file)
        if (mutant === undefined || mutant < 0 || state[mutant] !== MUTANT_PENDING) continue
        state[mutant] = MUTANT_STALLED
        writeStateByte(paths.state, mutant, MUTANT_STALLED)
      }
      // A worker stopped for stalling may have written over what another had
      // just found out.
      for (const [mutant, verdict] of status.detected) {
        if (state[mutant] === MUTANT_KILLED || state[mutant] === verdict) continue
        state[mutant] = verdict
        writeStateByte(paths.state, mutant, verdict)
      }
      // What a test found is a lead and no more, and a mutant is left as
      // found only while a run of a whole file is still to say so. Otherwise
      // it goes back to what tests and whole runs can try: the worker died
      // before saying which file to run, the file run whole did not repeat
      // the failure, or the test that failed turned out to fail by chance,
      // in which case the run it ended never got to the tests after it.
      for (let mutant = 0; mutant < state.length; mutant++) {
        if ((state[mutant] !== MUTANT_KILLED && state[mutant] !== MUTANT_TIMEOUT) || status.detected.has(mutant)) continue
        // Two failures that settle nothing are not waited on: the test that
        // failed is given the mutant to try, which is what could settle them.
        const waiting = (entry?: WholeState) =>
          !wholeVerdict(entry) && (entry === undefined || entry.failed + entry.timedOut + entry.died < 2)
        const files = status.suspects.get(mutant)
        if (files && [...files].some((file) => waiting(status.whole.get(wholeKey(mutant, file))))) continue
        state[mutant] = MUTANT_PENDING
        writeStateByte(paths.state, mutant, MUTANT_PENDING)
      }
      // Test ids change when tests move; the file and name a killer was
      // recorded under are matched against the tests as they are now.
      const byKey = new Map<string, string>()
      for (const [id, test] of status.tests) byKey.set(testKey(options.root, test.file, test.name), id)
      const killers = new Map<number, Set<string>>()
      hints.forEach((hint, mutant) => {
        const ids = (earlierKillers[hint] ?? []).flatMap((key) => byKey.get(key) ?? [])
        if (ids.length > 0) killers.set(mutant, new Set(ids))
      })
      // A test that failed a run of its file with a mutant on is the one to
      // try that mutant: failing with it and passing without is what makes
      // the failure already seen count.
      for (const [mutant, entries] of status.evidence) {
        if (status.detected.has(mutant)) continue
        for (const entry of entries) {
          if (entry.kind !== 'lead' && entry.test) killers.set(mutant, (killers.get(mutant) ?? new Set()).add(entry.test))
        }
      }
      const next = planRound(status, state, files, killers, siteOf)
      const pairing = Object.entries(next.plan.whole).filter(([, jobs]) => jobs.some((job) => job.pair))
      if (pairing.length > 0) {
        const lines = pairing.map(([file]) => JSON.stringify({ type: 'pairing', file, at: Date.now() }))
        fs.appendFileSync(path.join(paths.results, 'main.jsonl'), `${lines.join('\n')}\n`)
      }
      planned = Object.entries(next.plan.whole).flatMap(([file, jobs]) =>
        jobs.filter((job) => !job.control).map(({ id, mutant, plain, exclusive, quiet, witnesses }) => ({
          id,
          mutant,
          file,
          plain,
          alone: exclusive === true || quiet === true,
          quiet: quiet === true,
          knew: (witnesses?.length ?? 0) > 0,
          had: total(status.whole.get(wholeKey(mutant, file))),
        })),
      )
      let judged = 0
      for (const test of status.tests.values()) judged += test.judged.size + Number(test.done)
      for (const value of state) if (value !== MUTANT_PENDING) judged++
      for (const entry of status.whole.values()) judged += total(entry)
      for (const pair of status.pairs.values()) judged += pair.asked + pair.met
      if (next.workByFile.size === 0) break
      stalled = judged === progress ? stalled + 1 : 0
      progress = judged
      if (stalled >= 3 || rounds >= options.maxRounds) {
        abandonedFiles.push(...next.workByFile.keys())
        break
      }
      copying = Object.keys(next.plan.whole).length > 0
      // Workers claim a test's mutants a few at a time and
      // keep claiming until none are left, so a round ends within one chunk of
      // its work running out. A file gets a worker run per `budgetMs` of work,
      // or per worker's share of a small round: a worker rarely lasts longer
      // before it is replaced for its memory, and a run that finds nothing
      // left to claim ends at once.
      let roundWork = 0
      for (const work of next.workByFile.values()) roundWork += work.workMs
      const unitMs = Math.min(options.budgetMs, Math.max(2000, roundWork / options.maxWorkers))
      const units: { spec: (typeof specs)[number]; workMs: number }[] = []
      let wholeWork = 0
      for (const work of next.workByFile.values()) wholeWork += work.wholeRuns * work.wholeMs
      for (const spec of specs) {
        const work = next.workByFile.get(spec.moduleId)
        if (!work) continue
        // A whole-file run takes a worker's whole run of the file, so each gets its own.
        // A worker that can copy itself goes through the jobs of a file one
        // after another; more than there are workers would find nothing left.
        // Each file gets workers by its share of the work, and as many again:
        // a worker cannot move to another file, and one that finds nothing
        // left costs little.
        const share = wholeWork > 0 ? (work.wholeRuns * work.wholeMs) / wholeWork : 0
        // Starting one costs about as much as a second of such runs.
        const worth = Math.ceil((work.wholeRuns * (work.wholeMs / 2 + 10)) / 1000)
        // The runs of a file that is run one process at a time stand in one
        // line whatever is done; more workers for it would hold a place each
        // while they wait their turn.
        const serial = status.exclusive.has(spec.moduleId)
        const wholeUnits =
          !cloning || work.wholeRuns === 0
            ? work.wholeRuns
            : serial
              ? 1
              : Math.max(1, Math.min(work.wholeRuns, worth, Math.ceil(3 * options.maxWorkers * share)))
        for (let i = 0; i < wholeUnits; i++) {
          units.push({ spec, workMs: (work.wholeMs * work.wholeRuns) / wholeUnits / (i + 1) })
        }
        // A run that a copy did not get through takes a worker of its own.
        const alone = cloning ? (next.plan.whole[spec.moduleId] ?? []).filter((job) => job.plain).length : 0
        for (let i = 0; i < alone; i++) units.push({ spec, workMs: work.wholeMs })
        if (work.chunks === 0 && !(spec.moduleId in next.plan.probe)) continue
        // A worker stops at the first test a mutant leaves broken, and what
        // it had taken goes to whichever worker is still on the file. Where
        // that happened before, more of them start together.
        const taints = status.taints.get(spec.moduleId) ?? 0
        const count =
          next.plan.pristine.includes(spec.moduleId)
            ? 1
            : spec.moduleId in next.plan.probe
              ? Math.min(options.maxWorkers, 1 + taints)
              : serial || next.plan.settling
                ? 1
                : Math.max(1, Math.min(work.chunks, Math.ceil(work.workMs / unitMs))) + Math.min(taints, 2)
        for (let i = 0; i < count; i++) units.push({ spec, workMs: work.workMs / count })
      }
      units.sort((a, b) => b.workMs - a.workMs)
      // Longest first keeps a round from ending on a long run. In a round
      // that gives every worker several runs that matters little, and a fixed
      // order costs more: the tests of the files that come last get their
      // turn only once every other test has tried the same mutants, so a
      // mutant only they can kill is run by all of them.
      if (roundWork / options.maxWorkers > options.budgetMs) {
        const seed = (index: number) => Math.sin((index + 1) * 12.9898 + rounds * 78.233) * 43758.5453
        const keyed = units.map((unit, index) => ({ unit, key: seed(index) - Math.floor(seed(index)) }))
        keyed.sort((a, b) => a.key - b.key)
        units.splice(0, units.length, ...keyed.map((entry) => entry.unit))
      }
      // The two runs of a pair go first and next to each other: with the
      // first halves of several pairs holding every worker, each would wait
      // for a second half that has none to start in.
      const paired = specs.filter((spec) => next.plan.whole[spec.moduleId]?.some((job) => job.pair))
      for (const spec of paired) {
        for (let i = 0; i < 2; i++) {
          const at = units.findIndex((unit) => unit.spec === spec)
          if (at !== -1) units.splice(at, 1)
        }
      }
      units.unshift(...paired.flatMap((spec) => [{ spec, workMs: 0 }, { spec, workMs: 0 }]))
      plan = units.map((unit) => unit.spec)
      const unitsOf = new Map<string, number>()
      for (const spec of plan) unitsOf.set(spec.moduleId, (unitsOf.get(spec.moduleId) ?? 0) + 1)
      next.plan.sole = [...unitsOf].flatMap(([file, count]) => (count === 1 ? [file] : []))
      fs.writeFileSync(paths.plan, JSON.stringify(next.plan))
      const totalWork = units.reduce((sum, unit) => sum + unit.workMs, 0)
      options.log(
        `round ${rounds + 1}: ${next.workByFile.size} file(s), ${plan.length} worker run(s), ` +
          `~${Math.round(totalWork / 1000)}s of test time on ${options.maxWorkers} workers`,
      )
    }
    for (const file of vitest.state.getFiles()) collectSuiteErrors(file, options.root, suiteErrors)
  } finally {
    // A worker that does not end when asked keeps Vitest waiting, and once
    // nothing else is left to wait for, Node ends the process there, with
    // no word and no report. The wait gets a limit of its own, which is
    // also what keeps the process alive until it is over.
    let limit: NodeJS.Timeout | undefined
    await Promise.race([vitest.close(), new Promise((resolve) => (limit = setTimeout(resolve, 15_000)))])
    clearTimeout(limit)
  }
  const vitestMs = performance.now() - vitestStartedAt
  if (process.env.VITANT_DEBUG) options.log(`console messages from tests: ${consoleMessages}`)

  const records = readRecords()
  const state = fs.readFileSync(paths.state)
  const status = inspect(records, generated.mutants.map((mutant) => mutant.site))
  const coveredBy = new Uint32Array(generated.mutants.length)
  const killedBy = new Uint32Array(generated.mutants.length)
  const staticSites = new Set<number>()
  const hookSites = new Set<number>()
  const finishedFiles = new Set<string>()
  const coveringSites = new Map<string, number[]>()
  /** Per test, the mutants it detected, split by verdict. */
  const detections = new Map<string, { killed: Set<number>; timedOut: Set<number> }>()
  const detectionsOf = (id: string) => {
    let entry = detections.get(id)
    if (!entry) detections.set(id, (entry = { killed: new Set(), timedOut: new Set() }))
    return entry
  }
  const timeoutCauses = new Map<number, string>()
  /** Per test file, what its last complete pass loaded and reached while loading. */
  const passes = new Map<string, FileRecord>()
  for (const record of records) {
    if (record.type === 'file') {
      finishedFiles.add(record.file)
      for (const site of record.staticSites) staticSites.add(site)
      for (const site of record.hookSites ?? []) hookSites.add(site)
      if (record.complete && record.modules) passes.set(record.file, record)
    } else if (record.type === 'test') {
      if (record.mode === 'probe' && record.baseline === 'pass') coveringSites.set(record.id, record.sites)
      for (const mutant of record.killed) {
        killedBy[mutant]++
        detectionsOf(record.id).killed.add(mutant)
      }
      record.timedOut.forEach((mutant, index) => {
        detectionsOf(record.id).timedOut.add(mutant)
        timeoutCauses.set(mutant, record.timeoutCauses?.[index] ?? 'loop')
      })
    }
  }
  for (const sites of [...coveringSites.values(), hookSites]) {
    for (const site of sites) {
      for (let mutant = generated.siteMutants[site]; mutant < generated.siteMutants[site + 1]; mutant++) {
        coveredBy[mutant]++
      }
    }
  }
  const label = (test: TestState) => `${path.relative(options.root, test.file)} > ${test.name}`
  const tests = status.tests.size
  const failedBaselines = [...status.tests.values()].filter((t) => t.failed).map(label)
  const nonRepeatableTests = [...status.tests.values()].filter((t) => t.done && t.coverage && !t.failed).map(label)

  if (options.incremental && abandonedFiles.length === 0) {
    const siteKey = (site: number) => keys[generated.siteMutants[site]]
    const toKeys = (mutants: Iterable<number>) => [...mutants].map((mutant) => keys[mutant])
    const next: Cache = { fingerprint: print, mutants: {}, files: {} }
    generated.mutants.forEach((mutant, id) => {
      ;(next.mutants[path.relative(options.root, mutant.file)] ??= []).push(keys[id])
    })
    for (const [file, pass] of passes) {
      const snapshot = path.join(path.dirname(file), '__snapshots__', `${path.basename(file)}.snap`)
      const entry: CachedFile = {
        deps: {},
        staticSites: pass.staticSites.map(siteKey),
        hookSites: (pass.hookSites ?? []).map(siteKey),
        staticMutants: toKeys(status.staticMutants.get(file) ?? []),
        whole: {},
        tests: {},
      }
      for (const [key, entryState] of status.whole) {
        const [mutant, wholeFile] = key.split('\n')
        const verdict = wholeVerdict(entryState)
        if (wholeFile === file && verdict) entry.whole[keys[Number(mutant)]] = verdict
      }
      for (const dep of [file, snapshot, ...pass.modules!]) {
        entry.deps[path.relative(options.root, dep)] = hashFile(dep)
      }
      next.files[path.relative(options.root, file)] = entry
    }
    for (const [id, test] of status.tests) {
      const entry = next.files[path.relative(options.root, test.file)]
      if (!entry) continue
      const { killed, timedOut } = detectionsOf(id)
      entry.tests[id] = {
        name: test.name,
        baseline: test.failed ? 'fail' : test.coverage ? 'pass' : 'skip',
        baselineMs: test.coverage?.baselineMs ?? 0,
        baselineLoops: test.coverage?.baselineLoops ?? 0,
        nonRepeatable: test.done && !test.failed && test.coverage !== undefined,
        sites: (coveringSites.get(id) ?? []).map(siteKey),
        covered: toKeys(test.coverage?.covered ?? []),
        cleanup: toKeys(test.coverage?.cleanup ?? []),
        killed: toKeys(killed),
        timedOut: toKeys(timedOut),
        survived: toKeys(
          [...test.judged].filter(
            (mutant) => !killed.has(mutant) && !timedOut.has(mutant) && !test.unverified.has(mutant),
          ),
        ),
      }
    }
    const killers: Record<string, string[]> = {}
    for (const [id, test] of status.tests) {
      const { killed, timedOut } = detectionsOf(id)
      for (const mutant of [...killed, ...timedOut]) {
        ;(killers[hints[mutant]] ??= []).push(testKey(options.root, test.file, test.name))
      }
    }
    next.killers = killers
    fs.writeFileSync(cachePath(options.root), JSON.stringify(next))
  }

  const counts: Record<MutantStatus, number> = {
    Killed: 0,
    Survived: 0,
    Timeout: 0,
    NoCoverage: 0,
    Static: 0,
    Pending: 0,
  }
  const wholeRuns: WholeRuns = { started: 0, 'copied before load': 0, 'copied after load': 0, lost: 0 }
  for (const record of records) {
    if (record.type === 'whole' && record.by) wholeRuns[record.by]++
    else if (record.type === 'plain') wholeRuns.lost++
  }
  const pending = abandonedFiles.length > 0
  const { detected } = status
  const proof = (mutant: number): Evidence[] =>
    (status.evidence.get(mutant) ?? []).map((entry) => ({
      ...entry,
      file: path.relative(options.root, entry.file),
      test: entry.test === undefined ? undefined : (status.tests.get(entry.test)?.name ?? entry.test),
    }))
  const mutants = generated.mutants.map((mutant): MutantResult => {
    const isStatic = staticSites.has(mutant.site)
    let status: MutantStatus
    // Only what runs of whole files found counts; what a test found while trying a mutant led to them.
    if (detected.get(mutant.id) === MUTANT_KILLED) status = 'Killed'
    else if (detected.has(mutant.id)) status = 'Timeout'
    else if (pending) status = 'Pending'
    else if (coveredBy[mutant.id] > 0 || (isStatic && judgeStatic)) status = 'Survived'
    else status = isStatic ? 'Static' : 'NoCoverage'
    counts[status]++
    return {
      id: mutant.id,
      file: path.relative(options.root, mutant.file),
      mutator: mutant.mutator,
      replacement: mutant.replacement,
      location: mutant.loc,
      status,
      static: isStatic,
      coveredBy: coveredBy[mutant.id],
      killedBy: killedBy[mutant.id],
      timeoutCause: status === 'Timeout' ? (timeoutCauses.get(mutant.id) ?? 'fresh worker') : undefined,
      evidence: detected.has(mutant.id) ? proof(mutant.id) : undefined,
    }
  })

  return {
    mutants,
    counts,
    timings: { generateMs, vitestMs, totalMs: performance.now() - startedAt },
    testFiles: finishedFiles.size,
    tests,
    failedBaselines,
    leftOut,
    quietRuns: {
      failed: records.filter((record) => record.type === 'whole' && record.quiet && record.by && record.verdict !== 'passed').length,
      passed: records.filter((record) => record.type === 'whole' && record.quiet && record.by && record.verdict === 'passed').length,
    },
    exclusiveFiles: [...status.exclusive].map((file) => path.relative(options.root, file)),
    changedFiles: changedSince(treeBefore, options.root),
    flakyTests: [...status.flaky].flatMap((id) => {
      const test = status.tests.get(id)
      return test ? [label(test)] : []
    }),
    nonRepeatableTests,
    suiteErrors,
    abandonedFiles,
    rounds,
    wholeRuns,
    unplaced: generated.unplaced,
    skippedFiles: generated.skipped,
    vitestVersion,
  }
}
