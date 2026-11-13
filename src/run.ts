import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type Cache,
  type CachedFile,
  bindingKeys,
  cachePath,
  fingerprint,
  hashFile,
  isFresh,
  alignedKeys,
  hintKeys,
  loadCache,
  loadKillers,
  testKey,
  mutantKeys,
} from './cache.ts'
import { type Generated, generate, type GenerateOptions } from './mutate/generate.ts'
import { RUNTIME_GLOBAL } from './mutate/instrument.ts'
import { placeReads, reexports, type WatchedModule } from './mutate/reads.ts'
import { addonTarget } from './platform.ts'
import { mendPool } from './pool.ts'
import { writeHookObserver } from './hooks.ts'
import {
  createRuntime,
  MUTANT_KILLED,
  MUTANT_PENDING,
  MUTANT_STALLED,
  MUTANT_TIMEOUT,
  type RoundPlan,
  type WholeJob,
  type SessionConfig,
  channelWatch,
  relative,
  sessionPaths,
} from './session.ts'
import { sweep } from './runtime/turns.ts'

export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'Unconfirmed'
  | 'Led'
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
  /** For an unconfirmed mutant, how many of the test files that reach it were run, all passing, and how many were not. */
  confirmed?: { passed: number; open: number }
  /** For an unconfirmed mutant, the tests that reach it and were left out of every run for failing by themselves. */
  leftOut?: string[]
  /** For an unconfirmed mutant, the tests that reach it and failed in a run of their file with it, which another run of the file passed. */
  wavered?: string[]
  /** For an unconfirmed mutant, the tests and test files that failed with it and fail by chance: with another mutant, or with none, they failed one run and passed another. */
  doubted?: string[]
  /**
   * For a led mutant, the tests that failed with it while trying it in a
   * worker and passed again without it, and whether one of them did so with
   * no other run of its file under way, and whether every one of them ran
   * out of the time Vitest gives a test, the failure a busy machine hands out
   * most freely, which without the option settles nothing by itself.
   */
  led?: { tests: string[]; sole: boolean }
  /** With `--led`, for an unconfirmed mutant: the test file a run failed with it next to other runs, which no run made with nothing else running was made to confirm. */
  besideOnly?: string
  /**
   * For a detected mutant, the runs of whole files that say so and the tests
   * that led to them: what to read when the suite disagrees with the verdict.
   */
  evidence?: Evidence[]
}

export interface Evidence {
  /** `lead` is a test that failed while trying the mutant, which alone decides nothing. */
  kind: 'failed' | 'timeout' | 'died' | 'lead'
  /** The run was made with nothing else running. */
  quiet?: boolean
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
  /** Made as a mutant's module began its own code, see `WholeJob.loading`. */
  'copied while loading': number
  'copied after load': number
  'copied before a test': number
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
   * Vitest project the runner could not be put into, the type checker,
   * which is where type tests run, or a browser, where this runner is not. A mutant reported as survived survived
   * the rest of the suite, and these might have detected it.
   */
  leftOut: { projects: Record<string, number>; typeTests: number; browserTests: number; typeCheck?: boolean }
  /**
   * The runs made with nothing else running, by how they went. One that
   * passed is a mutant that had failed its file twice in a row and would
   * have been reported as killed without it.
   */
  quietRuns: { failed: number; passed: number }
  /** Test files whose runs failed each other and were made one at a time from then on. */
  exclusiveFiles: string[]
  /**
   * Test files that every mutant was run with: what some test of theirs
   * reaches could only be seen in a worker that mutants had been tried in,
   * or after a test that failed there.
   */
  unsureFiles: string[]
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
  /**
   * What the run spent, in counts and in time added up over the processes
   * that spent it. Wall-clock time says how long the machine took, other
   * work on it included; these say how much there was to do.
   */
  work: {
    /** Times a test was run with a mutant on in a worker, to find a lead. */
    trials: number
    /** CPU time of the workers over the tests they ran to measure them and to make those trials. */
    trialCpuMs: number
    /** Time the whole-file runs took, by whether the file passed. */
    wholeMs: { passed: number; detected: number }
    /** Worker processes Vitest started. */
    workers: number
  }
  /**
   * Without a limit on the files a mutant is run against, what `--confirm`
   * would have left out, by place on each mutant's list of nearest files,
   * the first at 0: how many mutants a file there detected, and how long the
   * runs there took. Files a test failed or stopped in with the mutant are
   * not counted, as a limit runs them all the same. A mutant counts where it
   * was detected, though a nearer file that was not run might have done so.
   */
  nearest?: { detected: number[]; ms: number[] }
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
  /** How many of the test files that reach a mutant it has to pass to be let go, the nearest first; all of them when infinite. */
  confirm: number
  /** Leave a mutant a test failed with while trying it at that, reported as led, with no run of a whole file to confirm it. */
  led: boolean
  /**
   * With `led`: only a lead whose test failed with its file to itself counts,
   * and a failure next to other runs that no lead vouches for is still made
   * again with nothing else running.
   */
  fast: boolean
  /** Make the runs that are to be made with nothing else running one at a time on the machine, not only one per test file. */
  strict: boolean
  log: (message: string) => void
}

interface TestRecord {
  type: 'test'
  file: string
  id: string
  name: string
  /** `probe` records come with an unmutated run and what it covered. */
  mode: 'probe' | 'planned'
  /** The test tried the mutant on its one run in a copy of a worker, not on a second run in the worker itself. */
  copied?: boolean
  baseline?: 'pass' | 'fail' | 'skip'
  baselineMs: number
  baselineLoops: number
  /** Resident memory of the worker when the test ended. */
  rss?: number
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
  /** The one run a copy gave the test ended at Vitest's limit for a test. */
  overran?: boolean
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
  /** The pass was made to measure the tests with no mutant tried, and gave every test its run. */
  pristine?: boolean
  /** How many tests that pass left out for failing with no mutant on. */
  ignored?: number
  /** A suite hook failed before a test could request the preceding tests to be replayed. */
  needsReplay?: boolean
  /** Every test of the file ran in this worker, so each reported its coverage. */
  complete: boolean
  /** From taking the file on to the end of its run, loading it and its hooks included. */
  wallMs?: number
  /** Project files the worker loaded, reported with a complete pass. */
  modules?: string[]
}

/** A worker was killed for blocking its event loop while a mutant was active. */
interface StallRecord {
  type: 'stall'
  id: string
  mutant: number
  /** The test's first try in a worker that had skipped the tests before it: says nothing of the mutant. */
  cold?: boolean
  /** In a run of a whole file, which the main process writes the run's own record for. */
  whole?: boolean
  /** What ran out: time on the processor, memory, or time by the clock. */
  by?: 'cpu' | 'memory' | 'clock'
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
  /** Failures that are not counted: of a test, or of a kind in a file, that fails by chance. */
  doubted: number
  /** Of those, the ones in runs made with nothing else running. */
  quietDoubted: number
}

const wholeKey = (mutant: number, file: string) => `${mutant}\n${file}`

/**
 * A failure counts once it has been seen twice: in the same test that failed
 * with the mutant while trying it, or in a second run of the file made with
 * nothing else running. A lead from another test does not do: trying a
 * mutant in a worker can fail a test for good reasons that a whole run does
 * not share, and then one test of the file failing by chance would settle it.
 * Nor does a second run made at once next to the first: of 3,184 such runs
 * over twenty projects 8 passed, and those that failed settled nothing, the
 * test that had failed trying the mutant or the run with nothing else
 * running being what did.
 */
function wholeVerdict(state: WholeState | undefined): WholeRecord['verdict'] | 'doubted' | undefined {
  if (!state) return undefined
  if (state.passed > 0) return 'passed'
  // Nothing but failures that say nothing: another run would add one more
  // of them or pass by the same chance, so the file is left at that.
  if (state.doubted > 0 && state.failed + state.timedOut + state.died === 0) return 'doubted'
  // So is a failure whose run made with nothing else running failed only in
  // such a test: one more such run would say the same, and the run that is
  // wanted would be planned for ever.
  if (state.repeated === 0 && state.quiet === 0 && state.quietDoubted > 0) return 'doubted'
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
/**
 * What a test did in a copy of a worker made to give it its one run, with
 * no mutant on. Its failing there with a mutant counts only once this passed.
 */
interface ApartRecord {
  type: 'apart'
  file: string
  test: string
  verdict: 'failed' | 'passed'
}

/** How a run of a file went with no mutant on and nothing else running, see `WholeJob.calm`. */
interface CalmRecord {
  type: 'calm'
  file: string
  verdict: 'failed' | 'passed'
  /** The tests that failed in it. */
  tests?: string[]
}

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
  /** It was stopped for the memory it held, which says nothing of the suite. */
  memory?: boolean
}

/** A copy of a worker that had been handed a test file ended with no mutant on and without getting through it. */
interface UnhandedRecord {
  type: 'unhanded'
  file: string
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
  | UnhandedRecord
  | ControlRecord
  | PairRecord
  | { type: 'pairing'; file: string }
  | { type: 'alternative'; mutant: number; test: string }
  /** A copy could not be made as a mutant's module began its own code while the file loaded. */
  | { type: 'loading'; file: string }
  /** A worker given the file's runs made none of them. */
  | { type: 'idle'; file: string }
  /**
   * A process that ran the file's tests to copy itself before one of them
   * made no copy there: the mutant's code had run (`mutant`), or something
   * would have been shared with the copies (no `mutant`, for every run of the file).
   */
  | { type: 'walk'; file: string; mutant?: number; why: string }
  | ApartRecord
  | CalmRecord
  | { type: 'worker' }
  | { type: 'hookObserver'; module: string; hash: string }
  /** A process loaded a test file, for reading where a run's time went: `bench/spent.ts`. */
  | { type: 'loaded'; file: string; ms: number; template: boolean; whole: boolean }
  /**
   * What ran while a file loaded in the first round, said as soon as it has
   * loaded: a worker replaced before the file's end leaves no `file` record.
   */
  | { type: 'statics'; file: string; sites: number[] }
  /** A round ended, for reading where a run's time went: `bench/spent.ts`. */
  | { type: 'round'; round: number; startedAt: number; workers: number }
) & {
  at: number
}

interface TestState {
  file: string
  name: string
  /** From the last passing unmutated run. */
  coverage?: {
    sites: number
    covered: number[]
    cleanup: number[]
    /** The sites the test's runs reached, whether or not the value there would have differed under a mutant. */
    reached: number[]
    baselineMs: number
    baselineLoops: number
    rss: number
  }
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
  /** Per test file, the shortest complete run of it, from taking it on to its end. */
  const fileWall = new Map<string, number>()
  /** Per file, how often a worker gave up while going through it for coverage. */
  const taints = new Map<string, number>()
  /** Per test file, the mutants that would have changed a value while it loaded. */
  const staticMutants = new Map<string, Set<number>>()
  /** Test files that open something while they load which copies made afterwards would share. */
  const sharing = new Set<string>()
  /** Test files in which a copy could not be made while they loaded. */
  const unpaused = new Set<string>()
  /** Whole-file runs that a copy of a worker did not get through. */
  const plain = new Set<string>()
  /** Whole-file runs that a copy was stopped in for the memory it held. */
  const roomy = new Set<string>()
  /** Per test file, the sites whose code ran outside its tests in an unmutated run. */
  const staticSites = new Map<string, Set<number>>()
  /** Per test file, the sites the hooks that run once it has loaded reached. */
  const hookSites = new Map<string, Set<number>>()
  const whole = new Map<string, WholeState>()
  /** Sites some test reaches. */
  const reached = new Set<number>()
  /** Per test file, the sites its tests reach while they run. */
  const exercised = new Map<string, Set<number>>()
  /** Per file, the passes that went through all of it with no mutant tried. */
  const measured = new Map<string, number>()
  /** Per file, the most tests such a pass left out for failing with no mutant on. */
  const leftOut = new Map<string, number>()
  /** What whole-file runs have shown to be detected. */
  const detected = new Map<number, number>()
  /**
   * Per mutant, the files with a test that failed with it while trying it.
   * That is a lead, not a verdict: the mutant was on for that test alone,
   * after a start without it, which is not a state the suite ever runs in.
   */
  const suspects = new Map<number, Set<string>>()
  const alternatives = new Map<number, Set<string>>()
  /**
   * Mutants that blocked a worker while a test tried them. Blocking once
   * more, in a run of a whole file, is what a timeout is.
   */
  const blocked = new Map<number, Set<string>>()
  const stalls: { mutant: number; test: string }[] = []
  /** Tests a worker stalled in where that says nothing of the mutant, see `StallRecord.cold`. */
  const cold = new Set<string>()
  /** Per test file, how long its whole-file runs have taken and how many there were. */
  const wholeTook = new Map<string, { ms: number; runs: number }>()
  const leads: { mutant: number; file: string; test: string; passedAgain: boolean; copied?: boolean; failedAgain?: boolean; slow?: boolean }[] = []
  /** Tests that failed in a run with no mutant on and nothing else running. */
  const restive = new Set<string>()
  /** Files such a run failed in with no test to name. */
  const restless = new Set<string>()
  /** Per file, how many such runs have been made. */
  const calms = new Map<string, number>()
  /** Per test given its one run in a copy with no mutant on, whether every such run passed. */
  const apart = new Map<string, boolean>()
  /** Per mutant, the tests that failed with it and passed without it next to other runs of their file. */
  const beside = new Map<number, Set<string>>()
  /** Mutants whose test ran out of its loop's or the clock's limit while trying them next to other runs of its file. */
  const besideLoops = new Set<number>()
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
  /** Files that workers are started for: a copy made to go through one ended over something no mutant did. */
  const unhanded = new Set<string>()
  /**
   * Per kind of copy and file, how the file went in such a copy unmutated.
   * One failure may be a test failing by chance, and running a file in
   * started workers for good is a high price for that: it takes two.
   */
  const controls = new Map<string, ControlRecord['verdict']>()
  const controlFailures = new Map<string, number>()
  /** The tests of each file in the order of its last complete run. */
  const order = new Map<string, string[]>()
  /** Files whose runs are not made before a test, and runs of mutants whose code ran before the test: see `WholeJob.before`. */
  const unwalked = new Set<string>()
  for (const record of records) {
    if (record.type === 'walk') unwalked.add(record.mutant === undefined ? record.file : wholeKey(record.mutant, record.file))
    if (record.type === 'file' && record.complete) {
      order.set(record.file, record.tests)
      finished.set(record.file, [...(finished.get(record.file) ?? []), record.tests])
      if (record.wallMs !== undefined) fileWall.set(record.file, Math.min(fileWall.get(record.file) ?? Infinity, record.wallMs))
    }
    // A round that only gives failed tests their second run tries no mutant
    // in their file either, and goes through those tests alone: what the
    // other tests reach it does not say.
    if (record.type === 'file' && record.pristine && record.complete) {
      measured.set(record.file, (measured.get(record.file) ?? 0) + 1)
      leftOut.set(record.file, Math.max(leftOut.get(record.file) ?? 0, record.ignored ?? 0))
    }
    if (record.type === 'alternative') {
      alternatives.set(record.mutant, (alternatives.get(record.mutant) ?? new Set()).add(record.test))
    }
    if (record.type === 'statics') {
      const set = staticSites.get(record.file) ?? new Set()
      for (const site of record.sites) set.add(site)
      staticSites.set(record.file, set)
    }
    if (record.type === 'file' && record.staticSites) {
      const set = staticSites.get(record.file) ?? new Set()
      for (const site of record.staticSites) set.add(site)
      staticSites.set(record.file, set)
    }
    if (record.type === 'unhanded') unhanded.add(record.file)
    if (record.type === 'plain') {
      plain.add(wholeKey(record.mutant, record.file))
      if (record.memory) roomy.add(wholeKey(record.mutant, record.file))
      else lost.add(record.file)
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
    if (record.type === 'stall' && record.id !== '' && !record.whole) {
      if (record.cold) cold.add(record.id)
      else stalls.push({ mutant: record.mutant, test: record.id })
    }
    if (record.type === 'calm') {
      calms.set(record.file, (calms.get(record.file) ?? 0) + 1)
      if (record.verdict !== 'passed') {
        if (record.tests?.length) for (const test of record.tests) restive.add(test)
        else restless.add(record.file)
      }
    }
    if (record.type === 'apart') apart.set(record.test, record.verdict === 'passed' && apart.get(record.test) !== false)
    if (record.type === 'loading') unpaused.add(record.file)
    if (record.type === 'early') {
      if (record.site === -1) sharing.add(record.file)
      const set = staticSites.get(record.file) ?? new Set()
      set.add(record.site)
      staticSites.set(record.file, set)
    }
    if (record.type === 'file') {
      if (record.needsReplay) replay.add(record.file)
      for (const site of record.hookSites ?? []) reached.add(site)
      const hooks = hookSites.get(record.file) ?? new Set()
      for (const site of record.hookSites ?? []) hooks.add(site)
      hookSites.set(record.file, hooks)
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
      leads.push({
        mutant,
        file: record.file,
        test: record.id,
        passedAgain: record.sole === true,
        copied: record.copied,
        slow: record.overran === true,
      })
      if (!record.sole) beside.set(mutant, (beside.get(mutant) ?? new Set()).add(record.id))
      if (!record.sole && record.timedOut.includes(mutant)) besideLoops.add(mutant)
    }
    if (record.sole) {
      for (const mutant of [...record.survived, ...record.killed, ...record.timedOut, ...(record.suspected ?? [])]) {
        triedSole.set(mutant, (triedSole.get(mutant) ?? new Set()).add(record.id))
      }
    }
    // A copy that did not get to say what the test did left a record so that the test is not asked again, and no more.
    for (const mutant of record.copied ? [] : (record.suspected ?? [])) {
      // `failedAgain`: what such a lead shows is how the mutant left the worker, which `--led` does not take at its word.
      leads.push({ mutant, file: record.file, test: record.id, passedAgain: false, failedAgain: true })
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
      const own = exercised.get(record.file) ?? new Set()
      exercised.set(record.file, own)
      for (const site of record.sites) {
        reached.add(site)
        own.add(site)
      }
      test.retry = false
      // What a test reached in a worker no mutant had been tried in is what
      // it reaches, and a run in one that had tried some says nothing
      // against it. Nor does a pass against another run: a test that races
      // a timer reaches what the machine's load lets it, and in rea a pass
      // made beside twelve other runs missed a branch the first round had
      // reached, which left a mutant there with no file to pass.
      const covered = new Set([...(test.coverage?.covered ?? []), ...record.covered])
      const cleanup = [...new Set([...(test.coverage?.cleanup ?? []), ...record.cleanup])].filter((mutant) => !covered.has(mutant))
      const reachedSites = [...new Set([...(test.coverage?.reached ?? []), ...record.sites])]
      if (!test.pristine || record.pristine) {
        test.pristine = record.pristine ?? false
        test.coverage = {
          sites: record.sites.length,
          covered: [...covered],
          cleanup,
          reached: reachedSites,
          baselineMs: record.baselineMs,
          baselineLoops: record.baselineLoops,
          rss: record.rss ?? 0,
        }
      } else if (test.coverage) {
        test.coverage.covered = [...covered]
        test.coverage.cleanup = cleanup
        test.coverage.reached = reachedSites
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
  for (const test of cold) {
    const file = tests.get(test)?.file
    if (file) replay.add(file)
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
  // sleeps one. The test stays in the runs until it has done the same with
  // a mutant somewhere else in the code: one mutant's doing must not cost
  // another the test that detects it.
  for (const [test, sites] of unsteady) if (sites.size >= 2) flaky.add(test)
  // A failure seen with nothing else running is taken for the mutant's on
  // the premise that the file passes there with none. In h3 a test that
  // sends a body too large to a server on a port times out six times in six
  // when its file is run alone, and passes as a rule with the whole suite
  // around it: sixteen mutants it has nothing to do with were reported as
  // timeouts. What fails with no mutant on and nothing else running is left
  // out like any test that fails by itself, for what it had been taken to
  // show as well.
  for (const test of restive) flaky.add(test)
  // Two failures of a test that fails one run in ten are a matter of a
  // hundred mutants, and with nothing else running it failed as often: on a
  // 4-core runner a test of hono that checks the time it logged was two
  // kills that way, and tests of h3 that send a body to a port, timing out
  // now one and now another, nine timeouts. A test that failed and passed
  // with one mutant has shown that it can; whether the runs were in each
  // other's way or it waits on the clock cannot be told from that. Left in
  // the runs, since a mutant may have made it so, what it fails counts only
  // where it had failed trying the mutant and passed without, and there
  // only with a failure made with nothing else running: a run of the file
  // next to others fails by chance more often than a try in a worker that
  // has the file to itself, and the leads of other mutants, which is what
  // finds a test out that fails by chance, come from the tries alone. A run that
  // ends at a limit, with its worker, or with no test to name is the same
  // for a file where such a run passed another time, or failed with no
  // mutant on.
  const shaky = new Set(restive)
  const shakyFiles = new Set(restless)
  for (const test of restive) {
    const file = tests.get(test)?.file
    if (file) shakyFiles.add(file)
  }
  for (const record of counted) {
    if (record.verdict === 'passed' || !passedOnce.has(wholeKey(record.mutant, record.file))) continue
    for (const test of record.tests ?? (record.test === undefined ? [] : [record.test])) shaky.add(test)
    if (record.verdict === 'timeout' || record.died || (record.test ?? record.tests?.[0]) === undefined) shakyFiles.add(record.file)
  }
  /** Per mutant, the tests and files whose failures with it were not counted for that. */
  const doubted = new Map<number, Set<string>>()
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
  // A test that fails by chance when the machine is busy fails with
  // whatever mutant it happens to be trying, passes again without it, and
  // makes a lead. Nearly all such leads come to nothing, the file passing
  // with the mutant, but with a test that every mutant reaches some do not:
  // it fails once more in the run of the file, and that was a kill on a
  // 4-core CI runner about once a run. A test with one lead that came to
  // nothing vouches for no failure; what rests on it is seen again with
  // nothing else running. A lead can also come to nothing because the
  // mutant was switched on in the middle of a worker's life, and then a
  // test loses this for no fault of its own, at the price of those runs.
  // Running out of the time a test is given is the failure a busy machine
  // hands out most freely, and it hands it to the run of the file as readily
  // as to the try: what such a witness fails is seen again with nothing else
  // running, as with a witness that failed and passed a run of its file.
  const overrun = new Map<number, Set<string>>()
  const passedWith = new Set<string>()
  for (const record of settled) if (record.verdict === 'passed') passedWith.add(wholeKey(record.mutant, record.file))
  const refuted = new Set<string>()
  // Only a lead whose test passed again without the mutant is held against
  // it. Failing again says how the mutant left the worker, not that the test
  // fails by chance: in rea 40 of 46 tests lost this that way alone, and
  // 220 of 426 runs made with nothing else running were for failures those
  // tests had shown, every one confirmed.
  // A test that does fail by chance passes again far more often than it
  // fails twice in a row, and is found out by those leads.
  for (const { mutant, file, test, failedAgain } of leads) if (!failedAgain && passedWith.has(wholeKey(mutant, file))) refuted.add(test)
  /** Per mutant, the tests whose failing with it, and passing again without it, a run made with `led` takes at its word. */
  const led = new Map<number, { tests: Set<string>; sole: boolean }>()
  for (const { mutant, file, test, passedAgain, copied, slow, failedAgain } of leads) {
    if (flaky.has(test)) continue
    // What a copy does to the test is not the mutant's doing: without a copy
    // in which the test passed with no mutant on, its failing in one is no lead.
    if (copied && apart.get(test) !== true) continue
    note(mutant, { kind: 'lead', file, test })
    const files = suspects.get(mutant) ?? new Set()
    files.add(file)
    suspects.set(mutant, files)
    // Eight of nine leads that `--led` took wrongly over 28 scopes had other
    // runs of their file under way: a test that times itself failed by chance.
    if (!failedAgain && !refuted.has(test) && (!fastLeads || passedAgain)) {
      const entry = led.get(mutant) ?? { tests: new Set(), sole: false }
      entry.tests.add(test)
      entry.sole ||= passedAgain
      led.set(mutant, entry)
    }
    if (passedAgain && !refuted.has(test)) {
      witnesses.set(mutant, (witnesses.get(mutant) ?? new Set()).add(test))
      if (slow) overrun.set(mutant, (overrun.get(mutant) ?? new Set()).add(test))
    }
  }
  for (const record of wholeRecords) {
    const key = wholeKey(record.mutant, record.file)
    const entry = whole.get(key) ?? { runs: 0, repeated: 0, beside: 0, quiet: 0, knowing: 0, died: 0, failed: 0, timedOut: 0, passed: 0, doubted: 0, quietDoubted: 0 }
    whole.set(key, entry)
    entry.runs++
    if (uncopied.has(record.file) && record.by && record.by !== 'started') plain.add(key)
    if (!settled.has(record)) continue
    const named = record.test ?? record.tests?.[0]
    const failing = record.tests ?? (record.test === undefined ? [] : [record.test])
    // A worker the mutant had blocked under a test and a run of the file a limit ended say the same thing.
    const witnessed = failing.filter((test) => witnesses.get(record.mutant)?.has(test))
    const stalled = record.verdict === 'timeout' && blocked.get(record.mutant)?.has(record.file) === true
    const vouched = witnessed.length > 0 || stalled
    if (record.verdict === 'passed') entry.passed++
    else if (named && flaky.has(named)) continue
    // Nor does a failure count in a file that fails that way with no test to name.
    else if (restless.has(record.file)) continue
    else if (
      !vouched &&
      ((failing.length > 0 && failing.every((test) => shaky.has(test))) ||
        ((record.verdict === 'timeout' || record.died || failing.length === 0) && shakyFiles.has(record.file)))
    ) {
      entry.doubted++
      if (record.quiet) entry.quietDoubted++
      doubted.set(record.mutant, (doubted.get(record.mutant) ?? new Set()).add(failing.find((test) => shaky.has(test)) ?? record.file))
      continue
    } else if (record.died) entry.died++
    else if (record.verdict === 'failed') entry.failed++
    else entry.timedOut++
    if (record.verdict === 'passed') continue
    if (record.quiet) entry.quiet++
    if (record.knew) entry.knowing++
    // Where the run had failed before any test did, an error nothing handled for one, the test named is the first that then failed.
    note(record.mutant, { kind: record.died ? 'died' : record.verdict, quiet: record.quiet || undefined, file: record.file, test: record.test ?? record.tests?.[0], by: record.by })
    if (record.died) continue
    if (record.by && !record.alone) entry.beside++
    if (stalled || witnessed.some((test) => !shaky.has(test) && !overrun.get(record.mutant)?.has(test))) entry.repeated++
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
  // What a test reaches was seen in a worker that had tried mutants, or
  // after a test that failed there, and no pass without either gave the
  // test another run: what it would reach in a plain run is not known, so
  // its file is one any mutant may change. In vue a mutant left an effect
  // active, the test that fails on `else if (true)` for `else if (__DEV__
  // && !failSilently)` took the branch before it, and the mutant survived a
  // file it was never run with. A test that fails with no mutant on is left
  // out of the runs of its file, and nothing hangs on what it reaches.
  const unsure = new Set<string>()
  for (const test of tests.values()) if (test.coverage && !test.pristine && !test.failed) unsure.add(test.file)
  const pairWanted = new Set<string>()
  // Two tries at getting two runs to start together; a file that cannot be asked is left as it is.
  const askable = (file: string) => {
    const pair = pairs.get(file)
    return !exclusive.has(file) && (!pair || (pair.met < 2 && pair.asked < 2))
  }
  for (const [key, entry] of whole) {
    const file = key.split('\n')[1]
    if (entry.repeated > 0 || entry.passed > 0 || entry.beside === 0) continue
    if (askable(file)) pairWanted.add(file)
  }
  // A test that reaches none of the mutated code failed next to other runs
  // of its file, with a mutant it had never failed trying: nothing of the
  // mutant was in its way, so the first suspect is the file's runs getting
  // in each other's way. The run of a mutant the file goes on to detect is
  // left out above, and a worker that runs every mutant without a lead
  // before the others arrive leaves no other run to show it in.
  const triedAndFailed = new Map<number, Set<string>>()
  for (const { mutant, test } of leads) triedAndFailed.set(mutant, (triedAndFailed.get(mutant) ?? new Set()).add(test))
  for (const record of counted) {
    if (record.verdict === 'passed' || record.alone || !record.by || !askable(record.file)) continue
    const failing = record.tests ?? (record.test === undefined ? [] : [record.test])
    const bystander = (id: string) => tests.get(id)?.coverage?.sites === 0 && !flaky.has(id) && !triedAndFailed.get(record.mutant)?.has(id)
    if (failing.some(bystander)) pairWanted.add(record.file)
  }
  return { besideLoops, order, unwalked, fileWall, led, tests, replay, retried, completeFiles, detected, taints, staticMutants, staticSites, hookSites, sharing, unpaused, plain, roomy, whole, reached, measured, suspects, alternatives, blocked, flaky, wholeTook, exercised, unsure, leftOut, apart, restless, calms, evidence, witnesses, controls, uncopied, exclusive, lost, unhanded, doubted, pairWanted, pairs, beside, triedSole, refuted }
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

/**
 * With a limit on the files a mutant is run against, the mutants that passed
 * the files within it and have others left, with how many of each. Such a
 * mutant is not known to survive: over fifteen projects, 22 of some 3,400
 * that passed their four nearest files failed a later one.
 */
let confirmFiles = Infinity
/**
 * Per mutant in a binding only reading it can make anything of, the sites
 * that record reads of what it changes (see `Watched`). Such a mutant runs
 * in every file that loads its module, and can change nothing in one that
 * reads none of them.
 */
let watchedReads: readonly (readonly number[] | undefined)[] = []
/** See `RunOptions.strict`. */
let strictQuiet = false
/** Per such mutant, the same sites where its bindings can be made again, see `Mutant.again`. */
let watchedAgain: readonly (number[] | undefined)[] = []
/**
 * Whether a mutant a test failed with while trying it, and passed again
 * without, is left at that: no run of a whole file confirms it, and it is
 * reported as led, never as killed.
 */
let takeLeads = false
/** See `RunOptions.fast`. */
let fastLeads = false
const unconfirmed = new Map<number, { passed: number; open: number }>()
/** With `--led`, the mutants whose failure next to other runs was left at that, with the file. */
const besideOnly = new Map<number, string>()
/** Without such a limit, each mutant's files in the order a limit would take them. */
const nearestFiles = new Map<number, string[]>()
/** The work counted for a pass through a file that tries nothing, as if it took this long. */
const PASS_MS = 5000

/**
 * With `--fast`, the tests that failed or looped with a mutant next to other
 * runs of their file and can still try it with the file to themselves.
 */
function besideLeft(status: ReturnType<typeof inspect>, mutant: number): string[] {
  // A mutant a run of a whole file has failed is settled the way it is without the option.
  if (status.evidence.get(mutant)?.some((entry) => entry.kind !== 'lead')) return []
  return [...(status.beside.get(mutant) ?? [])].filter((id) => {
    const test = status.tests.get(id)
    return test !== undefined && !test.done && !test.failed && test.coverage !== undefined && !status.flaky.has(id) && !status.triedSole.get(mutant)?.has(id)
  })
}
/** With `--fast`, the mutants pending until such a test has tried them alone. */
const retryAlone = new Set<number>()

type Planned = {
  plan: RoundPlan
  workByFile: Map<string, { workMs: number; chunks: number; wholeRuns: number; wholeMs: number }>
  alternatives: { mutant: number; test: string }[]
}

/**
 * The work of the next round. What settles a failure that settled nothing
 * comes last and in rounds of its own, one kind at a time: first the tests
 * that failed try the mutant, each file with one worker to itself, which is
 * what makes what they find count; then, for what is still open, a run of
 * the file with nothing else running.
 */
export function planRound(...given: [ReturnType<typeof inspect>, Uint8Array, string[], Map<number, Set<string>>, ArrayLike<number>, ArrayLike<number>]): Planned {
  besideOnly.clear()
  const usual = planPhase(...given, false)
  // With `--led` what these rounds settle is left at that, unconfirmed: the
  // tries made with a file to itself one after another were a quarter of a
  // run of rea's `ExecFileOutput.ts`.
  if (takeLeads && !fastLeads) return usual
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
  /** Per mutant, a number for the source file it is in. */
  sourceOf: ArrayLike<number>,
  /** Nothing else is left to do: the round is for what settles failures that settled nothing. */
  settling: boolean,
): Planned {
  // A mutant whose runs of a file failed without settling anything is back
  // among the pending ones for one purpose: the tests that failed are to
  // try it. Given to every test that reaches it, one test a round, it would
  // take as many rounds as there are tests.
  // A mutant whose tests have tried it alone, or can no longer, goes on as without `--fast`.
  for (const mutant of [...retryAlone]) if (status.led.has(mutant) || besideLeft(status, mutant).length === 0) retryAlone.delete(mutant)
  const only = new Map<number, Set<string>>()
  const alternatives: Planned['alternatives'] = []
  // One file settles a mutant, so the tests of one file try it: the file
  // whose tests take least. The others' turn comes if that one's run, made
  // with nothing else running, passes.
  const testsMs = new Map<string, number>()
  for (const test of status.tests.values()) {
    testsMs.set(test.file, (testsMs.get(test.file) ?? 0) + (test.coverage?.baselineMs ?? 0))
  }
  const unsettled = [...status.whole]
    .filter(([, entry]) => entry.passed === 0 && entry.repeated === 0 && entry.quiet === 0 && entry.quietDoubted === 0 && entry.failed + entry.timedOut + entry.died > 0)
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
    if (settling && state[mutant] === MUTANT_PENDING && failed.size === 0 &&
        status.whole.get(wholeKey(mutant, file))!.timedOut > 0 && status.staticSites.get(file)?.has(siteOf[mutant])) {
      const asked = status.alternatives.get(mutant) ?? new Set<string>()
      let left = 4 - asked.size
      const chosenFiles = new Set([...asked].map((id) => status.tests.get(id)?.file))
      const untried = [...status.tests].filter(([id, test]) =>
        test.file !== file && !test.done && !test.failed && test.pristine && !status.flaky.has(id) &&
        test.coverage?.covered.includes(mutant) && !test.judged.has(mutant) && !asked.has(id) &&
        !status.triedSole.get(mutant)?.has(id) && status.staticSites.get(test.file)?.has(siteOf[mutant]) === false,
      )
      untried.sort(([a, first], [b, second]) => second.coverage!.sites - first.coverage!.sites || (a < b ? -1 : a > b ? 1 : 0))
      for (const [id, test] of untried) {
        if (left <= 0) break
        if (chosenFiles.has(test.file)) continue
        chosenFiles.add(test.file)
        failed.add(id)
        alternatives.push({ mutant, test: id })
        left--
      }
    }
    only.set(mutant, failed)
  }
  // With `--fast` a test that failed or looped with the mutant next to other
  // runs of its file tries it again with the file to itself before any run of
  // the whole file: that run would be followed by the same retry to make the
  // failure count (immich 4,080 such mutants on a 4-core runner), and a
  // whole-file run of a loop waits out the test's limit.
  if (fastLeads && settling) {
    for (const mutant of retryAlone) {
      const left = besideLeft(status, mutant)
      if (only.has(mutant) || left.length === 0) continue
      only.set(mutant, new Set(left))
      settledIn.set(mutant, status.tests.get(left[0])!.file)
    }
  }
  // A test that cannot be run a second time in a worker never tries a
  // mutant there, so a failure of the file in it has no witness and waits
  // for a run made with nothing else running: 183 such runs one after
  // another on solid. In a copy of a worker that went through the tests
  // before it with no mutant on, the test has its one run with the mutant on
  // from its start, which is what a test that can be re-run gives on its
  // second.
  const trials: { mutant: number; file: string; test: string }[] = []
  if (settling && cloning) {
    for (const [mutant, file] of settledIn) {
      // No copy is made of a process once the file has loaded, where loading leaves something open.
      if (status.sharing.has(file) || status.uncopied.has(file)) continue
      for (const id of only.get(mutant)!) {
        const test = status.tests.get(id)
        if (!test?.done || test.failed || !test.coverage || !test.pristine || status.apart.get(id) === false) continue
        if (status.triedSole.get(mutant)?.has(id)) continue
        trials.push({ mutant, file, test: id })
      }
    }
  }
  // And a test that failed with the mutant next to other runs of its file
  // tries it once more with the file to itself: what it finds then counts.
  const again = (id: string, mutant: number) =>
    settling &&
    status.tests.get(id)?.file === settledIn.get(mutant) &&
    status.beside.get(mutant)?.has(id) === true &&
    !status.triedSole.get(mutant)?.has(id)
  // A mutant a test failed with while its file then passed with it is one
  // tests say nothing reliable about: every test that had not tried it got
  // it again, one of them failed with it, its file passed, and so on round
  // after round, each a worker to every file that reaches the mutant. One
  // mutant of valibot took thirteen rounds of some 250 tests in 54 files
  // that way, two fifths of the run. Such a mutant is left to the runs of
  // whole files, which every file it can change is to pass anyway before it
  // counts as survived.
  const spent = new Set<number>()
  for (const [mutant, entries] of status.evidence) {
    if (entries.some((entry) => entry.kind === 'lead' && wholeVerdict(status.whole.get(wholeKey(mutant, entry.file))) === 'passed')) spent.add(mutant)
  }
  // Once, with the file to itself: a test that has done that has said what it can.
  const tries = (id: string, mutant: number) =>
    only.has(mutant)
      ? settling && ((only.get(mutant)!.has(id) && !status.triedSole.get(mutant)?.has(id)) || again(id, mutant))
      : !settling && !spent.has(mutant) && !(fastLeads && retryAlone.has(mutant))
  // In a file that runs one process at a time tests do not try mutants
  // one by one: one worker would go through a file that takes seconds once
  // a round for as many rounds as it takes, where a run of the whole file
  // says at once what the mutant does. Only what settles a failure is tried.
  const remaining = new Map<string, number[]>()
  for (const [id, test] of status.tests) {
    if (test.done || !test.coverage || (!settling && status.exclusive.has(test.file))) continue
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
    if (test.done || !test.coverage || (!settling && status.exclusive.has(test.file))) continue
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
  // Where a failure is to be settled the tests that failed are few and any
  // of them may be the witness: one a round would take as many rounds as
  // there are, which is what a run on three cores ran out of.
  // A mutant whose first try is over goes on to the rest at once rather than
  // wait for the first tries others still have to make: in rea those were a
  // few tries a round left over from workers a mutant had stopped, and five
  // rounds of 27 s to 92 s each went to them while every other mutant waited.
  let lists = remaining
  // With `--led` nothing waits on the first tries at all: a mutant a test
  // kills is skipped by the others as they come to it, and what the first
  // tries were to spare is tries, where waiting cost rounds that each ended
  // on one slow try.
  if (picks.size > 0 && !settling && takeLeads) {
    lists = new Map(remaining)
    for (const [id, mutants] of picks) lists.set(id, [...new Set([...mutants, ...(remaining.get(id) ?? [])])])
  } else if (picks.size > 0 && !settling) {
    const first = new Set([...picks.values()].flat())
    lists = new Map(picks)
    for (const [id, left] of remaining) {
      const rest = left.filter((mutant) => !first.has(mutant))
      if (rest.length > 0) lists.set(id, [...new Set([...(lists.get(id) ?? []), ...rest])])
    }
  }

  let jobs = 0
  const plan: RoundPlan = {
    replay: [...status.replay],
    retried: [...status.retried],
    tests: {},
    probe: {},
    pristine: [],
    measure: [],
    ignore: [],
    exclusive: [...status.exclusive],
    sole: [],
    handed: [],
    wholeOnly: [],
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
    addWork(file, PASS_MS, 1)
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
  // first, with no mutant tried. One worker of the file makes the pass and
  // tries nothing, beside those trying in the same round: made once nothing
  // else was left, it was a round of its own, 33 s of rea's
  // `ExecFileOutput.ts`. Not where a test reruns unmutated, nor in a round of
  // runs made alone.
  if (!settling) {
    const toLeaveOut = new Map<string, number>()
    for (const [id, test] of status.tests) {
      if (test.failed || status.flaky.has(id)) toLeaveOut.set(test.file, (toLeaveOut.get(test.file) ?? 0) + 1)
    }
    for (const test of status.tests.values()) {
      // Twice, and once more for every test found since to fail with no
      // mutant on: a pass such a test fails in says nothing of the tests
      // after it, and the next one leaves it out. A test that this still
      // gives no run to count leaves its file one that any mutant may change.
      const spent = (status.measured.get(test.file) ?? 0) >= 2 && (toLeaveOut.get(test.file) ?? 0) <= (status.leftOut.get(test.file) ?? 0)
      if (!test.coverage || test.pristine || test.failed || spent || test.file in plan.probe || retrying.has(test.file)) continue
      plan.probe[test.file] = []
      plan.pristine.push(test.file)
      plan.measure.push(test.file)
      addWork(test.file, PASS_MS, 1)
    }
  }
  const failing = new Map<string, string[]>()
  const fileMs = new Map<string, number>()
  const fileLoops = new Map<string, number>()
  const fileRss = new Map<string, number>()
  for (const [id, test] of status.tests) {
    fileMs.set(test.file, (fileMs.get(test.file) ?? 0) + (test.coverage?.baselineMs ?? 0))
    fileLoops.set(test.file, (fileLoops.get(test.file) ?? 0) + (test.coverage?.baselineLoops ?? 0))
    fileRss.set(test.file, Math.max(fileRss.get(test.file) ?? 0, test.coverage?.rss ?? 0))
    if (test.failed || status.flaky.has(id)) failing.set(test.file, [...(failing.get(test.file) ?? []), id])
  }
  // What a run of a file may take is gone by its tests alone only where
  // loading it and its hooks take no time: with a `beforeAll` of 16 s and a
  // test of a millisecond, every run of a mutant the suite passes ran into
  // the limit and was reported as a timeout. What a run costs is not: most
  // are copies that load nothing, and planned by the loading es-toolkit's
  // `pr` got 28 workers that each loaded the file to be copied, not 4,
  // and took 18.7 s for 8.5 s.
  const testMs = new Map(fileMs)
  for (const [file, wallMs] of status.fileWall) fileMs.set(file, Math.max(fileMs.get(file) ?? 0, wallMs))
  plan.ignore = [...failing.values()].flat()
  const controlled = new Set<string>()
  const shown = new Set<string>()
  for (const { mutant, file, test } of trials) {
    const job = (of: number): WholeJob => ({
      id: jobs++,
      mutant: of,
      ignore: failing.get(file) ?? [],
      fileMs: fileMs.get(file) ?? 0,
      fileLoops: fileLoops.get(file) ?? 0,
      fileRss: fileRss.get(file) ?? 0,
      stalled: false,
      witnesses: [],
      trial: test,
      site: of < 0 ? -1 : siteOf[of],
      // The mutant comes on at the test: the file loads without it either way.
      early: false,
      plain: false,
    })
    const list = (plan.whole[file] ??= [])
    if (!shown.has(test)) {
      shown.add(test)
      // First the run that shows the test passes in a copy at all, once per test.
      if (status.apart.get(test) === undefined) {
        list.push(job(-1))
        addWork(file, 0, 0, 1)
      }
      // Then mutants the file is known to pass with, which the test is to
      // pass with too. A test trying mutants in a worker meets such mutants
      // as a matter of course, and one that fails by chance is found out by
      // them; here only mutants the file failed with are tried otherwise.
      const harmless = (status.tests.get(test)!.coverage?.covered ?? []).filter(
        (other) => (status.whole.get(wholeKey(other, file))?.passed ?? 0) > 0 && !status.triedSole.get(other)?.has(test),
      )
      for (const other of harmless.slice(0, 3)) {
        list.push(job(other))
        addWork(file, 0, 0, 1)
      }
    }
    list.push(job(mutant))
    addWork(file, 0, 0, 1)
    workByFile.get(file)!.wholeMs = testMs.get(file) ?? 0
  }
  /** Runs that are to be made with nothing else running, which is a round of their own. */
  const quietJobs: [number, string][] = []
  // A mutant a file failed with comes back both as one that file is to run
  // and as one the test that failed named, and a second run next to the first
  // settles nothing the first does not.
  const planned = new Map<string, WholeJob>()
  /**
   * Per file, the index in its order of the first test whose unmutated run
   * reached each site, see `WholeJob.before`. A site, not a mutant: a test
   * that went past a condition `true` already holds reached the code of the
   * mutant `true` all the same, and a copy before a later test finds it ran.
   */
  const reaching = new Map<string, Map<number, number>>()
  const firstReaching = (file: string, mutant: number): string | undefined => {
    const order = status.order.get(file)
    if (!order) return undefined
    let first = reaching.get(file)
    if (!first) {
      first = new Map()
      for (const [index, id] of order.entries()) {
        const coverage = status.tests.get(id)?.coverage
        // A test of which nothing is known may reach anything: nothing after it comes first.
        if (!coverage) break
        for (const site of coverage.reached) if (!first.has(site)) first.set(site, index)
        for (const reached of coverage.cleanup) if (!first.has(siteOf[reached])) first.set(siteOf[reached], index)
      }
      reaching.set(file, first)
    }
    const index = first.get(siteOf[mutant])
    return index !== undefined && index > 0 ? order[index] : undefined
  }
  const wholeJob = (mutant: number, file: string, confirm: boolean, quiet = false) => {
    // Only while the lead is all there is: a mutant whose runs of a file failed
    // without settling anything is pending again, and the run that settles it
    // is what keeps it from being called survived.
    if (takeLeads && status.led.has(mutant) && (state[mutant] === MUTANT_KILLED || state[mutant] === MUTANT_TIMEOUT)) return
    if (fastLeads && retryAlone.has(mutant)) return
    const already = planned.get(wholeKey(mutant, file))
    if (already) {
      already.confirm ||= confirm
      return
    }
    // A run stopped for its memory is made again with the machine's memory
    // to hold, which only a run with nothing else running may have.
    if (!quiet && status.roomy.has(wholeKey(mutant, file))) {
      quietJobs.push([mutant, file])
      return
    }
    const entry = status.whole.get(wholeKey(mutant, file))
    // Unless a test of the file has given a lead that no run so far knew of: a run that goes on to it comes first.
    const unknown =
      entry?.knowing === 0 && [...(status.witnesses.get(mutant) ?? [])].some((id) => status.tests.get(id)?.file === file)
    if (!quiet && !unknown && entry && entry.passed === 0 && entry.repeated === 0 && entry.failed + entry.timedOut + entry.died > 0) {
      // With `--led` the run made with nothing else running is left out like the run a lead would get: in rea's
      // `ReverseEngineeringService.ts` it was a round of its own for two mutants that a run had stopped hanging.
      if (takeLeads && !fastLeads) besideOnly.set(mutant, file)
      else quietJobs.push([mutant, file])
      return
    }
    // The runs of a file that is run one process at a time stand in one
    // line, and what the round learns of its tests, that one fails by
    // itself for one, the runs still in the line do not: in h3 a thousand
    // of them waited five seconds each for a test that was to be left out.
    if (status.exclusive.has(file) && (plan.whole[file]?.length ?? 0) >= 24) return
    const hung = entry !== undefined && entry.timedOut + entry.died > 0
    // A binding the file reads in its tests alone can be made again in a copy
    // made after it loaded, where its value was made with the mutant off. Not
    // for a file that reads none: that run is what shows the module loads.
    const again = watchedAgain[mutant]
    const loadedReads = status.staticSites.get(file)
    const remade =
      again !== undefined &&
      loadedReads !== undefined &&
      !status.sharing.has(file) &&
      !again.some((site) => loadedReads.has(site)) &&
      again.some((site) => status.exercised.get(file)?.has(site) || status.hookSites.get(file)?.has(site))
    const early =
      !remade &&
      (status.sharing.has(file) ||
        !status.staticSites.has(file) ||
        status.staticSites.get(file)!.has(siteOf[mutant]))
    ;(plan.whole[file] ??= []).push({
      id: jobs++,
      mutant,
      ignore: failing.get(file) ?? [],
      fileMs: fileMs.get(file) ?? 0,
      fileLoops: fileLoops.get(file) ?? 0,
      fileRss: fileRss.get(file) ?? 0,
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
      // Not where a copy has been lost: the run with no mutant on that tells a
      // copy at fault from a mutant can only be made before or after loading.
      // Nor before an unmutated run has said what runs while the file loads: a
      // job whose module did not begin goes to a copy made after loading, and
      // those of formbricks' `validate.test.ts` failed beside other runs where
      // the suite passes.
      loading: early && status.staticSites.has(file) && !status.unpaused.has(file) && !status.lost.has(file),
      again: remade ? again : undefined,
      before:
        cloning && !early && !remade && !status.unwalked.has(file) && !status.unwalked.has(wholeKey(mutant, file)) && !status.staticMutants.get(file)?.has(mutant)
          ? firstReaching(file, mutant)
          : undefined,
      // A copy that runs into a limit holds up the copies due after it for
      // as long as that takes, a second or more where a loop does not end;
      // started for the run, the workers of such mutants wait side by side.
      // Where each file is not handed to a copy, a copy that runs into a
      // limit holds up the copies due after it for as long as that takes;
      // started for the run, the workers of such mutants wait side by side.
      // Where it is, each such run gets a worker run of its own.
      roomy: status.roomy.has(wholeKey(mutant, file)) || undefined,
      plain:
        status.plain.has(wholeKey(mutant, file)) ||
        status.uncopied.has(file) ||
        hung ||
        (!handing && (state[mutant] === MUTANT_STALLED || state[mutant] === MUTANT_TIMEOUT)),
    })
    const job = plan.whole[file].at(-1)!
    planned.set(wholeKey(mutant, file), job)
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
    workByFile.get(file)!.wholeMs = Math.max(testMs.get(file) ?? 0, took ? took.ms / took.runs : 0)
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
    // How much of a source file the tests of a test file go through: the
    // sites of it they reach while they run. Code that runs as a module
    // loads runs in every file that loads it and says nothing of the kind.
    const sourceOfSite = new Map<number, number>()
    for (let mutant = 0; mutant < state.length; mutant++) sourceOfSite.set(siteOf[mutant], sourceOf[mutant])
    const familiar = new Map<string, Map<number, number>>()
    const familiarity = (file: string, source: number): number => {
      let counts = familiar.get(file)
      if (!counts) {
        counts = new Map()
        for (const site of status.exercised.get(file) ?? []) {
          const of = sourceOfSite.get(site)!
          counts.set(of, (counts.get(of) ?? 0) + 1)
        }
        familiar.set(file, counts)
      }
      return counts.get(source) ?? 0
    }
    // A file written for one module reaches less of it than a wide file
    // does in passing, and goes through little else: h3's unit tests of its
    // proxy reach 14 sites, every one in the proxy's source, where four
    // other files reach 20 to 98 of them among hundreds, and they are what
    // fails for the mutants there. So two files by how much of the source
    // they go through, then two by how much of what they go through is the
    // source, then the rest. Under a limit the cost of a file does not break
    // a tie: which files a mutant is run against is not to change with the
    // machine's load.
    const share = (file: string, source: number): number => {
      const all = status.exercised.get(file)?.size ?? 0
      return all === 0 ? 0 : familiarity(file, source) / all
    }
    const nearest = (files: string[], source: number, byPath = confirmFiles !== Infinity): string[] => {
      const tie = (a: string, b: string) =>
        byPath ? (a < b ? -1 : a > b ? 1 : 0) : (fileMs.get(a) ?? 0) - (fileMs.get(b) ?? 0)
      const broad = [...files].sort((a, b) => familiarity(b, source) - familiarity(a, source) || tie(a, b))
      const narrow = [...files].sort((a, b) => share(b, source) - share(a, source) || tie(a, b))
      const taken = new Set<string>()
      const take = (list: string[], count: number) => {
        for (const file of list) {
          if (count === 0) break
          if (taken.has(file)) continue
          taken.add(file)
          count--
        }
      }
      take(broad, 2)
      take(narrow, 2)
      take(broad, Infinity)
      return [...taken]
    }
    unconfirmed.clear()
    const { unsure } = status
    for (let mutant = 0; mutant < state.length; mutant++) {
      // Code no test reaches is reported as such and not run.
      if (state[mutant] !== MUTANT_PENDING && state[mutant] !== MUTANT_STALLED) continue
      if (!status.reached.has(siteOf[mutant]) && !judgeStatic && unsure.size === 0) continue
      const loaders = new Set(covering.get(mutant))
      for (const [file, mutants] of status.staticMutants) if (mutants.has(mutant)) loaders.add(file)
      const reads = watchedReads[mutant]
      const readsIn = (file: string) =>
        reads!.some((site) => status.staticSites.get(file)?.has(site) || status.exercised.get(file)?.has(site) || status.hookSites.get(file)?.has(site))
      const targets = new Set([...(reads ? [...loaders].filter(readsIn) : loaders), ...unsure])
      // One file that loads the module all the same: that the initializer
      // can neither throw nor do anything else is the instrumenter's reading
      // of it, and a run that loads it is what shows a reading that is wrong.
      if (reads && targets.size === 0 && loaders.size > 0) {
        const cheapest = [...loaders].sort((a, b) => (fileMs.get(a) ?? 0) - (fileMs.get(b) ?? 0) || (a < b ? -1 : 1))
        targets.add(cheapest.find((file) => status.whole.has(wholeKey(mutant, file))) ?? cheapest[0])
      }
      const source = sourceOf[mutant]
      const ranked = nearest([...targets], source)
      if (confirmFiles === Infinity) nearestFiles.set(mutant, nearest([...targets], source, true))
      // A file in which a test stopped answering with the mutant is a lead like a
      // failure there, and no planner path but this one would run it.
      const within = new Set([...ranked.slice(0, confirmFiles), ...(status.blocked.get(mutant) ?? [])])
      const open = ranked.filter((file) => within.has(file) && !wholeVerdict(status.whole.get(wholeKey(mutant, file))))
      if (open.length === 0 && ranked.length > within.size) {
        const left = ranked.filter((file) => !within.has(file) && !wholeVerdict(status.whole.get(wholeKey(mutant, file)))).length
        if (left > 0) unconfirmed.set(mutant, { passed: targets.size - left, open: left })
      }
      // A file the mutant has failed in comes before any other: what settles
      // that failure ends the search. Otherwise a few files go first and twice as many
      // each round, so that a mutant some file detects costs little and one
      // that survives few rounds: the nearest files first. The cheapest alone
      // say nothing of which file detects: of the 322 test files that load
      // Effect's `Chunk`, one to three fail on most of its mutants, the
      // cheapest of them the 181st cheapest at the median, and the file
      // whose tests reach most of `Chunk` is one of them for 109 mutants in
      // 113. Where these runs have rarely failed so far there is little to
      // stop early for, and every round ends on its slowest run, so the
      // rest goes at once, but not before a file that knows the source.
      const suspect = open.filter((file) => status.whole.has(wholeKey(mutant, file)))
      // Where a run is a copy of a worker, a round costs more than the runs
      // it saves: a few files first, then all that is left.
      const done = targets.size - open.length
      const wave = cloning ? (done > 0 ? open.length : 4) : Math.max(1, done)
      const likely = done === 0 && open.length > 0 && familiarity(open[0], source) > 0
      const batch = suspect.length > 0 ? suspect : (rarelyFails && !likely) || confirmFiles !== Infinity ? open : open.slice(0, wave)
      for (const file of batch) wholeJob(mutant, file, false)
    }
  }
  // Confirming every file that gave a lead repeats a mutant's detection;
  // one file can settle it, with another tried if that run passes.
  for (const [mutant, files] of status.suspects) {
    if (status.detected.has(mutant)) continue
    const open = [...files].filter((file) => !wholeVerdict(status.whole.get(wholeKey(mutant, file))))
    if (open.length === 0) continue
    const alternativeFiles = new Set([...(status.witnesses.get(mutant) ?? [])]
      .filter((id) => status.alternatives.get(mutant)?.has(id))
      .map((id) => status.tests.get(id)!.file))
    // The cheaper loading failure cannot confirm a witness found in another file.
    const freshAlternative = (file: string) => alternativeFiles.has(file) && !status.whole.has(wholeKey(mutant, file))
    open.sort((a, b) => Number(freshAlternative(b)) - Number(freshAlternative(a)) || (fileMs.get(a) ?? 0) - (fileMs.get(b) ?? 0))
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
      if (asked.has(mutant) || status.restless.has(file)) continue
      asked.add(mutant)
      wholeJob(mutant, file, false, true)
    }
    // Among them runs with no mutant on, as alone as they are: two before
    // the first of a file, one after every six and one at the end. One such
    // run passes one time in five for a test that fails four times in five
    // when left alone; a test is left out once any of them fails in it.
    for (const [file, list] of Object.entries(plan.whole)) {
      const calm = (): WholeJob => ({
        id: jobs++,
        mutant: -1,
        ignore: failing.get(file) ?? [],
        fileMs: fileMs.get(file) ?? 0,
        fileLoops: fileLoops.get(file) ?? 0,
        fileRss: fileRss.get(file) ?? 0,
        stalled: false,
        control: true,
        quiet: true,
        calm: true,
        site: -1,
        early: status.sharing.has(file) || !status.staticSites.has(file),
        plain: status.uncopied.has(file),
      })
      const mixed: WholeJob[] = [calm(), calm()]
      list.forEach((job, index) => {
        mixed.push(job)
        if ((index + 1) % 6 === 0 && index + 1 < list.length) mixed.push(calm())
      })
      mixed.push(calm())
      addWork(file, 0, 0, mixed.length - list.length)
      plan.whole[file] = mixed
    }
    plan.quiet = Object.keys(plan.whole).length > 0
    // What two files can do to each other in a plain run they do here too,
    // and a busy machine is what the runs that pass with no mutant on are
    // there to show: those of a file whose runs have failed each other wait
    // for the machine to themselves, every other file goes beside them.
    plan.together = strictQuiet ? [] : Object.keys(plan.whole).filter((file) => !status.exclusive.has(file))
    if (plan.quiet) return { plan, workByFile, alternatives }
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
        fileRss: fileRss.get(file) ?? 0,
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
    workByFile.get(file)!.wholeMs ||= testMs.get(file) ?? 0
  }
  return { plan, workByFile, alternatives }
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
/** Workers hand each file to a copy, see `docs/design.md` item 14. */
let handing = false
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
    const source = relative(root, mutant.file)
    bySource.set(source, [...(bySource.get(source) ?? []), keys[id]])
  })
  // Cached keys of sources that only moved, read as the current mutants they are.
  const moved = alignedKeys(cache, bySource, idByKey, root)
  const aligned = new Set(Object.keys(cache.mutants).filter((source) => cache.mutants[source].some((key) => moved.has(key))))
  for (const [key, id] of moved) idByKey.set(key, id)
  const ids = (list: string[]) => list.flatMap((key) => idByKey.get(key) ?? [])
  const sites = (list: string[]) => [...new Set(ids(list).map((id) => generated.mutants[id].site))]
  const reused = new Set<string>()
  const lines: string[] = []
  const verdicts = new Map<number, number>()
  for (const file of files) {
    const cached = cache.files[relative(root, file)]
    if (!cached || !isFresh(cached, root, cache, bySource, aligned)) continue
    reused.add(file)
    lines.push(
      JSON.stringify({
        type: 'file',
        file,
        tests: Object.keys(cached.tests),
        // A binding that was not one of the kind then counts as read.
        staticSites: [...sites(cached.staticSites), ...[...bindingKeys(generated, root)].filter(([, key]) => cached.reads.includes(key) || !cache.watched.includes(key)).map(([site]) => site)],
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
    path.join(import.meta.dirname, `runtime/runner${path.extname(import.meta.filename)}`),
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

/**
 * The tests that leave a mutant no run of whole files detected open, per
 * mutant: those left out of the runs for failing by themselves, and those
 * that failed a run with the mutant where another run passed.
 */
export function doubts(
  status: { flaky: Set<string>; tests: Map<string, TestState> },
  records: SessionRecord[],
  label: (test: TestState) => string,
): { leftOutOf: Map<number, string[]>; everywhere: string[]; waveredIn: Map<number, Set<string>> } {
  // A test that fails by itself is left out of the runs of its file, and a
  // mutant it reaches has then passed the file without the one test that
  // may be what detects it: in h3 two tests that time out now and then on a
  // busy machine were all that fails on three mutants, which the suite
  // fails with every time. What the test would do with the mutant cannot be
  // told from its failures, so such a mutant has not survived the suite.
  const leftOutOf = new Map<number, string[]>()
  const everywhere: string[] = []
  // So is one whose unmutated run failed after it had passed once: it is
  // left out of the runs of its file all the same.
  const failed = [...status.tests].flatMap(([id, test]) => (test.failed ? [id] : []))
  for (const id of new Set([...status.flaky, ...failed])) {
    const test = status.tests.get(id)
    if (!test?.coverage) continue
    // Measured in a worker that mutants had been tried in, what the test reaches is not known.
    if (!test.pristine) everywhere.push(label(test))
    else for (const mutant of new Set([...test.coverage.covered, ...test.coverage.cleanup])) leftOutOf.set(mutant, [...(leftOutOf.get(mutant) ?? []), label(test)])
  }
  // A run of a file that passes settles it for the mutant, whatever failed
  // before: the failure was other runs of the file in the way, or the test's
  // own doing. Not where the test that failed reaches the mutant. A mutant
  // can make a test a matter of chance, a check for a session under way
  // taken out and three requests at once for one: the file then fails in
  // most runs and passes in some, and the suite fails with the mutant all
  // the same.
  const waveredIn = new Map<number, Set<string>>()
  for (const record of records) {
    if (record.type !== 'whole' || !record.by || record.verdict === 'passed') continue
    for (const id of record.tests ?? (record.test === undefined ? [] : [record.test])) {
      const test = status.tests.get(id)
      if (!test?.coverage) continue
      if (test.pristine && !test.coverage.covered.includes(record.mutant) && !test.coverage.cleanup.includes(record.mutant)) continue
      waveredIn.set(record.mutant, (waveredIn.get(record.mutant) ?? new Set()).add(label(test)))
    }
  }
  return { leftOutOf, everywhere, waveredIn }
}

function collectSuiteErrors(task: SuiteTask, root: string, into: string[]): void {
  if (task.type === 'test') return
  for (const error of task.result?.errors ?? []) {
    const where = task.filepath ? relative(root, task.filepath) : task.name
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
 *
 * Returns what resolves once every worker started so far has exited.
 */
function watchWorkers(): () => Promise<void> {
  const live = new Set<childProcess.ChildProcess>()
  let idle: (() => void)[] = []
  const fork = childProcess.fork
  childProcess.fork = ((...args: Parameters<typeof fork>) => {
    const child = fork(...args)
    live.add(child)
    child.once('exit', () => {
      live.delete(child)
      if (live.size > 0) return
      for (const resolve of idle) resolve()
      idle = []
    })
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
  return () => (live.size === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve)))
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
  return [...workingTree(root)].filter(([file, held]) => before.get(file) !== held).map(([file]) => relative(root, file))
}

/**
 * How much the records hold of what a round is made for; a round that adds
 * nothing to it got nowhere. A test that tries a mutant with its file to
 * itself counts though it had tried the mutant before, next to other runs,
 * and adds no mutant to those it has judged: the tests of one file take a
 * round each for that, and three of them in a row left Effect's
 * `RateLimiter.test.ts`, with every mutant it reaches, without a verdict.
 */
export function headway(status: ReturnType<typeof inspect>, state: ArrayLike<number>): { work: number; marked: number } {
  let count = 0
  for (const test of status.tests.values()) count += test.judged.size + Number(test.done)
  for (const entry of status.whole.values()) count += entry.runs
  for (const pair of status.pairs.values()) count += pair.asked + pair.met
  for (const passes of status.measured.values()) count += passes
  for (const runs of status.calms.values()) count += runs
  for (const tried of status.triedSole.values()) count += tried.size
  for (const asked of status.alternatives.values()) count += asked.size
  let marked = 0
  for (let mutant = 0; mutant < state.length; mutant++) if (state[mutant] !== MUTANT_PENDING) marked++
  // Withdrawing provisional detections can cancel an equal number of
  // completed runs if these counts are added together.
  return { work: count, marked }
}

export async function run(options: RunOptions): Promise<RunResult> {
  const startedAt = performance.now()
  const treeBefore = workingTree(options.root)
  let treeWarned = false
  const leftOut: RunResult['leftOut'] = { projects: {}, typeTests: 0, browserTests: 0 }
  judgeStatic = options.static
  confirmFiles = options.confirm
  takeLeads = options.led || options.fast
  fastLeads = options.fast
  retryAlone.clear()
  strictQuiet = options.strict
  watchedReads = []
  unconfirmed.clear()
  nearestFiles.clear()
  besideOnly.clear()
  const generated = generate(options)
  const generateMs = performance.now() - startedAt
  watchedReads = generated.mutants.map((mutant) => mutant.reads)
  watchedAgain = generated.mutants.map((mutant) => mutant.again)
  options.log(
    `${generated.mutants.length} mutants in ${generated.files.size} files (${Math.round(generateMs)} ms)`,
  )

  const projectRequire = createRequire(path.join(options.root, 'package.json'))
  const vitestPackage = projectRequire.resolve('vitest/package.json')
  const vitestVersion: string = JSON.parse(fs.readFileSync(vitestPackage, 'utf8')).version
  const vitestDist = fs.realpathSync(path.join(path.dirname(vitestPackage), 'dist'))
  const mended = /^4\./.test(vitestVersion) ? mendPool(vitestDist) : () => false
  const { createVitest } = await import(
    pathToFileURL(path.join(path.dirname(vitestPackage), 'dist/node.js')).href
  )

  // The runner shim imports `vitest` by bare specifier, so it has to live
  // where Node resolves that to the project's own copy.
  const sessionDir = path.join(options.root, 'node_modules/.vitant/session')
  const paths = sessionPaths(sessionDir)
  const [major, minor, patch] = vitestVersion.split('.').map((part) => Number.parseInt(part, 10))
  if (major < 3) throw new Error(`Vitest ${vitestVersion} is not supported; 3.0 or later is needed`)
  // The pool of Vitest 4 before 4.1.9 gives a worker that has ended to the
  // next file it could share one with, and waits for that file for good. A
  // worker that hands its files to copies ends when a copy is stopped in a
  // loop, so with more such files than workers a round of svelte never ended.
  // From 4.0.17 the pool is mended as it loads, see `mendPool`.
  const reusesEnded = major === 4 && (minor < 1 || (minor === 1 && patch < 9)) && !mended()
  const config = writeSession(sessionDir, generated, options, major, vitestPackage)
  const hookObserver = writeHookObserver(vitestPackage, sessionDir)
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

  const workersExited = watchWorkers()
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
      // Vitest keys the module cache it keeps on disk by the source on disk
      // and the environment, not by what `load` below returns, so a run with
      // another set of mutated files would be served the last run's switches
      // and site numbers, or the file with none. Within a run the module
      // graph in memory still transforms each file once.
      const uncached = (test: Record<string, unknown>): Record<string, unknown> =>
        major >= 5
          ? { ...test, fsModuleCache: false }
          : { ...test, experimental: { ...(test.experimental as object | undefined), fsModuleCache: false } }
      const withArgv = (test: Record<string, unknown> = {}): Record<string, unknown> => {
        if (major >= 4) return uncached({ ...test, execArgv: [`--require=${hookObserver}`, ...((test.execArgv as string[]) ?? []), ...workerArgv] })
        const pools = (test.poolOptions ?? {}) as { forks?: { execArgv?: string[] } }
        const forks = { ...pools.forks, isolate: true, execArgv: [`--require=${hookObserver}`, ...(pools.forks?.execArgv ?? []), ...workerArgv] }
        return { ...test, poolOptions: { ...pools, forks } }
      }
      for (const project of config.test?.projects ?? []) {
        if (typeof project !== 'object' || project === null) continue
        const inline = project as { plugins?: unknown[]; test?: Record<string, unknown> }
        inline.plugins = [...(inline.plugins ?? []), instrumentPlugin, readsPlugin()]
        inline.test = { ...withArgv(inline.test), runner: paths.runner }
      }
      // The project may have Vitest check types with its tests, which
      // fails a run for a mutant that breaks them with every test passing.
      // That is switched off here and not above, with the rest of what is
      // given to Vitest, so that what the project asked for can be read
      // first: the report is to say that survivors may be such mutants.
      const typecheck = (config.test?.typecheck ?? {}) as { enabled?: boolean }
      if (typecheck.enabled === true) leftOut.typeCheck = true
      config.test = { ...withArgv(config.test), typecheck: { ...typecheck, enabled: false } }
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
  const watchedModules = new Map<string, WatchedModule>()
  for (const [file, entry] of generated.files) {
    if (entry.bindings.size > 0) watchedModules.set(file, { exports: new Map([...entry.exports].map(([name, site]) => [name, [site]])), all: [...entry.bindings.values()] })
  }
  const everyRead = [...generated.readSites]
  type Resolve = (source: string, importer: string) => Promise<{ id: string } | null>
  const normalized = (id: string) => path.normalize(id.split('?')[0])
  // On the code as the other plugins leave it: one of them can add an import
  // (of names it provides by itself) or turn one into a call, as Vitest does
  // with the imports of a file that mocks a module. One for each project, which
  // resolves a specifier its own way, as each environment of one can.
  const readsPlugin = () => {
    /**
     * Per environment and module, what it gives with what it passes on, read
     * from its source on disk. Only what is done is kept: two modules being
     * read at once could otherwise each wait for the other.
     */
    const given = new Map<string, (WatchedModule & { aliased: Set<string> }) | undefined>()
    const watchedAt = async (file: string, resolve: Resolve, environment: string, chain: ReadonlySet<string> = new Set()): Promise<(WatchedModule & { aliased: Set<string> }) | undefined> => {
      const key = `${environment}\0${file}`
      if (given.has(key)) return given.get(key)
      const own = watchedModules.get(file)
      // A chain of re-exports that comes back to a module on it: what it passes on is not known.
      if (chain.has(file)) return { exports: new Map(own?.exports), all: everyRead, opaque: true, aliased: new Set() }
      if (file.includes('/node_modules/') || !/\.(m|c)?[jt]sx?$/.test(file) || !fs.existsSync(file)) return own && { ...own, aliased: new Set<string>() }
      const next = new Set([...chain, file])
      const found = await reexports(fs.readFileSync(file, 'utf8'), file, own, async (specifier) => {
        const resolved = await resolve(specifier, file)
        return resolved ? normalized(resolved.id) : undefined
      }, (target) => watchedAt(target, resolve, environment, next))
      // What depends on a cycle depends on where the chain came in: not kept.
      if (!found?.opaque || chain.size === 0) given.set(key, found)
      return found
    }
    return {
      name: 'vitant:reads',
      enforce: 'post' as const,
      async transform(this: { resolve: Resolve; environment?: { name: string } }, code: string, id: string, options?: { ssr?: boolean }) {
        const [file, query = ''] = id.split('?')
        // A module that is not a dependency and not a style sheet can be code
        // that reads a binding, a virtual one or one of a kind of its own.
        if (watchedModules.size === 0 || file.includes('/node_modules/')) return undefined
        if (/\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/.test(file) || /(^|&)(type=style|lang\.(css|scss|sass|less|styl))\b/.test(query)) return undefined
        const environment = this.environment?.name ?? (options?.ssr ? 'ssr' : 'client')
        const resolve: Resolve = (source, importer) => this.resolve(source, importer)
        const placed = await placeReads(code, file, {
          own: generated.files.get(path.normalize(file))?.bindings,
          checked: generated.files.get(path.normalize(file))?.checked,
          resolve: async (specifier) => {
            const resolved = await this.resolve(specifier, id)
            return resolved ? normalized(resolved.id) : undefined
          },
          watched: (target) => watchedAt(target, resolve, environment),
          aliased: (await watchedAt(normalized(file), resolve, environment))?.aliased,
          everything: everyRead,
        })
        return placed === undefined ? undefined : { code: placed, map: lineMap(id, code) }
      },
    }
  }
  const vitestStartedAt = performance.now()
  const addon = options.clone ? cloneAddon() : undefined
  cloning = addon !== undefined
  handing = cloning && major >= 4 && !reusesEnded
  workers = options.maxWorkers
  workerArgv.length = 0
  if (addon) {
    workerArgv.push('--single-threaded', `--require=${paths.preload}`)
    process.env.VITANT_FORK = addon
    // macOS ends a copy in which a class of its own frameworks is set up
    // for the first time, lest another thread was at that when the copy was
    // made: the first look-up of a host's name in a copy does it, and every
    // copy of a test file that makes one was lost. With the check off such
    // a copy goes on. What it guarded against, a thread of the worker being
    // at such a class when the copy is made, needs a look-up under way in a
    // worker that is copied before it has run anything or once it holds
    // nothing open.
    if (process.platform === 'darwin') process.env.OBJC_DISABLE_INITIALIZE_FORK_SAFETY ??= 'YES'
  } else {
    delete process.env.VITANT_FORK
    if (options.clone) options.log('whole-file runs start a worker each: no addon for this platform (pnpm build:native)')
  }
  // `createVitest` does not set what the CLI's `startVitest` sets before it,
  // and a project whose config or code branches on these fails its baselines
  // under the tool while the suite passes: actual skips a cache database only
  // under NODE_ENV=test, formbricks validates its environment schema.
  process.env.TEST = 'true'
  process.env.VITEST = 'true'
  process.env.NODE_ENV ??= 'test'
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
      // One run failing must not call off the others of its round.
      bail: 0,
      passWithNoTests: true,
      ...(options.related ? { related: [...generated.files.keys()] } : {}),
    },
    {
      plugins: [instrumentPlugin, readsPlugin()],
    },
  )

  // Reading the worker's configuration loses this main-process-only option.
  config.dangerouslyIgnoreUnhandledErrors = vitest.config.dangerouslyIgnoreUnhandledErrors === true
  fs.writeFileSync(paths.config, JSON.stringify(config))

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
      // Vitest picks the browser whatever pool it is given, and the page never loads this runner.
      if (spec.pool === 'browser') {
        leftOut.browserTests++
        return false
      }
      // Vitest hands the runner's path back with separators of its own choosing.
      const runner = spec.project.config.runner
      const usable = runner !== undefined && path.relative(runner, paths.runner) === '' && instrumented(spec.project) && !taken.has(spec.moduleId)
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
    let oneAtATime = false
    /** Of a round of runs made one at a time, the files whose runs go beside other files' runs, see `RoundPlan.together`. */
    let together = new Set<string>()
    const siteOf = generated.mutants.map((mutant) => mutant.site)
    const sources = [...generated.files.keys()]
    const sourceOf = generated.mutants.map((mutant) => sources.indexOf(mutant.file))
    let progress: ReturnType<typeof headway> | undefined
    /** Whether the workers of the round in flight copy themselves, which those of every round after the first do where a process can be copied. */
    let copying = false
    /** The test files of the round in flight that go to workers which hand them to copies, see `RoundPlan.handed`. */
    let handed = new Set<string>()
    /** How many runs of the round in flight stand first for pairs, see `WholeJob.pair`. */
    let leading = 0
    /** The whole-file runs of the round in flight, with how many records each pair had before it. */
    let planned: { id: number; mutant: number; file: string; had: number; plain: boolean; roomy: boolean; alone: boolean; quiet: boolean; knew: boolean }[] = []
    let plannedAt = 0
    let stalled = 0
    // Round one runs every test once, unmutated, and lets only fast tests try
    // their mutants. Later rounds follow a plan: first each mutant in the one
    // test most likely to kill it, then in every test that may still see it.
    for (;;) {
      if (plan.length > 0) {
        fs.rmSync(paths.claims, { recursive: true, force: true })
        fs.mkdirSync(paths.claims)
        const roundStartedAt = performance.now()
        const launch = async (part: typeof plan) => {
          if (part.length === 0) return
          const hands = part.every((spec) => handed.has(spec.moduleId))
          // Only workers that are to be copied need V8 to keep to one thread,
          // which slows down the tests they run themselves: those of the
          // first round, a worker to every file, are not. Before Vitest 4 the
          // pool takes its arguments once, for all rounds.
          if (cloning && major >= 4) {
            for (const project of new Set(part.map((spec) => spec.project))) {
              const config = project.config as { execArgv?: string[]; isolate?: boolean }
              const own = (config.execArgv ?? []).filter((argument) => !workerArgv.includes(argument))
              config.execArgv = copying ? [...own, ...workerArgv] : own
              // A worker that hands each file to a copy stays as it started;
              // any other has to be started for its file.
              config.isolate = !hands || reusesEnded
            }
          }
          await vitest.runTestSpecifications(part, true)
          // A worker that hands its files to copies tells Vitest nothing of
          // them, and Vitest forgets what it knew of a file when the file is
          // run again: what failed outside the tests is read while it is there.
          if (!hands) for (const file of vitest.state.getFiles()) collectSuiteErrors(file, options.root, suiteErrors)
        }
        // A worker stopped while it held a lock would keep the others waiting for good.
        const sweeping = setInterval(() => sweep(paths.locks), 100)
        try {
          // A round of runs made with nothing else running starts its
          // workers one after another too: started together they are each
          // other's load for as long as starting takes, which on four
          // cores was long enough for a test that checks the clock to fail
          // in the first of them.
          if (oneAtATime) {
            const beside = plan.filter((spec) => together.has(spec.moduleId))
            if (beside.length > 0) await launch(beside)
            const failedCalm = () => readRecords().filter((record) => record.type === 'calm' && record.verdict !== 'passed').length
            const before = failedCalm()
            for (const spec of plan.filter((spec) => !together.has(spec.moduleId))) {
              await launch([spec])
              // A test found to fail by itself is left out of what follows, which is planned anew.
              if (failedCalm() > before) break
            }
          }
          else if (reusesEnded || handed.size === 0) {
            // Where both parts take the same config they go in one call, the
            // files with a run in a worker started for it first: such a run is
            // where a copy did not get through or a mutant blocked or looped, the
            // long ones, and in two calls they waited for the copies to be through.
            // Pairs stay first, each half waiting for the other in a worker of its own.
            const rest = plan.slice(leading)
            await launch([...plan.slice(0, leading), ...rest.filter((spec) => !handed.has(spec.moduleId)), ...rest.filter((spec) => handed.has(spec.moduleId))])
          } else {
            // The pool shares the workers that hand their files over and starts
            // every other for its file, and one call takes one `isolate` for a project.
            await launch(plan.filter((spec) => handed.has(spec.moduleId)))
            await launch(plan.filter((spec) => !handed.has(spec.moduleId)))
          }
        } finally {
          clearInterval(sweeping)
        }
        rounds++
        fs.appendFileSync(
          path.join(paths.results, 'main.jsonl'),
          `${JSON.stringify({ type: 'round', round: rounds, startedAt: Date.now() - (performance.now() - roundStartedAt), workers, at: Date.now() })}\n`,
        )
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
      // A stop on time on the processor names the test it came in, as a
      // loop this runner ended in the test would: a lead its test gave for
      // the same mutant then vouches for it, where 28 of es-toolkit's went to
      // runs made one at a time. One by the clock names none, as a busy
      // machine can make one of a wait that only got longer. One on memory
      // is no verdict, the suite having no such limit.
      const stops = readRecords().filter((record): record is StallRecord & { at: number } => record.type === 'stall' && record.whole === true && record.at >= plannedAt)
      const stoppedIn = (mutant: number, file: string) => {
        const stop = stops.findLast((record) => record.mutant === mutant && status.tests.get(record.id)?.file === file)
        return stop && stop.by !== 'clock' && stop.id !== '' ? { test: stop.id, tests: [stop.id] } : {}
      }
      const stoppedForMemory = (mutant: number, file: string) =>
        stops.some((record) => record.mutant === mutant && record.by === 'memory' && (record.id === '' || status.tests.get(record.id)?.file === file))
      // A whole-file run that blocks is stopped by the watchdog, which marks
      // the mutant and kills the worker before it can write its verdict.
      const total = (entry?: WholeState) => entry?.runs ?? 0
      const stopped = planned.filter(
        (job) =>
          state[job.mutant] === MUTANT_TIMEOUT &&
          // A lead that ran out of time leaves the mark of its own before the run.
          !stoppedForMemory(job.mutant, job.file) &&
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
      // A file no process of the round said a word of, though it had runs to
      // make: its workers went before they took any. On a Linux runner the
      // same two runs of formbricks' `proxy.test.ts` were planned three
      // rounds in a row and the file was given up on. Its runs go to workers
      // started for each, which take no copy of themselves.
      const heard = new Set(readRecords().flatMap((record) => ((record as { at?: number }).at ?? 0) >= plannedAt && 'file' in record ? [record.file as string] : []))
      const unreached = planned.filter(
        (job) => !job.plain && !heard.has(job.file) && !fs.existsSync(path.join(paths.claims, `whole.${job.id}`)) && !stopped.includes(job),
      )
      const lines = [
        ...stopped.map(({ mutant, file, alone, quiet, knew }) => ({ type: 'whole', file, mutant, verdict: 'timeout', ...stoppedIn(mutant, file), alone, quiet, knew, by: 'started' })),
        ...silent.map(({ mutant, file, plain, alone, quiet, knew, roomy }) =>
          // Stopped for its memory, which the suite sets no limit on: made
          // again alone with the machine's memory to hold, and past that a timeout.
          stoppedForMemory(mutant, file)
            ? roomy
              ? { type: 'whole', file, mutant, verdict: 'timeout', ...stoppedIn(mutant, file), alone, quiet, knew, by: 'started' }
              : { type: 'plain', file, mutant, memory: true }
            : plain
              ? { type: 'whole', file, mutant, verdict: 'failed', died: true, alone, quiet, knew, by: 'started' }
              : { type: 'plain', file, mutant },
        ),
        ...unreached.map(({ mutant, file }) => ({ type: 'plain', file, mutant })),
        ...[...new Set(unreached.map((job) => job.file))].map((file) => ({ type: 'unhanded', file })),
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
        // With `--led` a lead is all that is asked for, also one that came to
        // count only after its mutant had gone back: a test's one run in a
        // copy counts once a copy with no mutant has passed it, and five
        // mutants of rea's `ExecFileOutput.ts` led that way went on to be run
        // whole, with nothing else running at the end.
        if (takeLeads && status.led.has(mutant) && !status.detected.has(mutant)) {
          retryAlone.delete(mutant)
          if (state[mutant] === MUTANT_PENDING || state[mutant] === MUTANT_STALLED) {
            state[mutant] = MUTANT_KILLED
            writeStateByte(paths.state, mutant, MUTANT_KILLED)
          }
          continue
        }
        // With `--fast` a loop made next to other runs is tried again alone before anything else is made of the mutant.
        if (fastLeads && !status.detected.has(mutant) && (retryAlone.has(mutant) || state[mutant] === MUTANT_KILLED || state[mutant] === MUTANT_TIMEOUT) && besideLeft(status, mutant).length > 0) {
          retryAlone.add(mutant)
          if (state[mutant] !== MUTANT_PENDING) {
            state[mutant] = MUTANT_PENDING
            writeStateByte(paths.state, mutant, MUTANT_PENDING)
          }
          continue
        }
        retryAlone.delete(mutant)
        if ((state[mutant] !== MUTANT_KILLED && state[mutant] !== MUTANT_TIMEOUT) || status.detected.has(mutant)) continue
        // A failure that settles nothing is not waited on: the test that
        // failed is given the mutant to try, which is what could settle it.
        const waiting = (entry?: WholeState) =>
          !wholeVerdict(entry) && (entry === undefined || entry.failed + entry.timedOut + entry.died === 0)
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
      const next = planRound(status, state, files, killers, siteOf, sourceOf)
      const pairing = Object.entries(next.plan.whole).filter(([, jobs]) => jobs.some((job) => job.pair))
      if (pairing.length > 0) {
        const lines = pairing.map(([file]) => JSON.stringify({ type: 'pairing', file, at: Date.now() }))
        fs.appendFileSync(path.join(paths.results, 'main.jsonl'), `${lines.join('\n')}\n`)
      }
      plannedAt = Date.now()
      planned = Object.entries(next.plan.whole).flatMap(([file, jobs]) =>
        jobs.filter((job) => !job.control && job.trial === undefined).map(({ id, mutant, plain, roomy, exclusive, quiet, witnesses }) => ({
          id,
          mutant,
          file,
          plain,
          roomy: roomy === true,
          alone: exclusive === true || quiet === true,
          quiet: quiet === true,
          knew: (witnesses?.length ?? 0) > 0,
          had: total(status.whole.get(wholeKey(mutant, file))),
        })),
      )
      const judged = headway(status, state)
      if (next.workByFile.size === 0) break
      stalled = judged.work === progress?.work && judged.marked === progress?.marked ? stalled + 1 : 0
      progress = judged
      if (stalled >= 3 || rounds >= options.maxRounds) {
        abandonedFiles.push(...next.workByFile.keys())
        break
      }
      if (next.alternatives.length > 0) {
        // A stopped worker may report no test, but must not reset the search budget.
        const lines = next.alternatives.map((entry) => JSON.stringify({ type: 'alternative', ...entry, at: Date.now() }))
        fs.appendFileSync(path.join(paths.results, 'main.jsonl'), `${lines.join('\n')}\n`)
      }
      copying = cloning
      // Workers claim a test's mutants a few at a time and
      // keep claiming until none are left, so a round ends within one chunk of
      // its work running out. A file gets a worker run per `budgetMs` of work,
      // or per worker's share of a small round: a worker rarely lasts longer
      // before it is replaced for its memory, and a run that finds nothing
      // left to claim ends at once.
      let roundWork = 0
      for (const work of next.workByFile.values()) roundWork += work.workMs
      /** What a run whose mutant loops takes at the least: the time Vitest gives a test. */
      const loopMs = (vitest.config as { testTimeout?: number }).testTimeout || 5000
      const unitMs = Math.min(options.budgetMs, Math.max(2000, roundWork / options.maxWorkers))
      const units: { spec: (typeof specs)[number]; workMs: number }[] = []
      let wholeWork = 0
      for (const work of next.workByFile.values()) wholeWork += work.wholeRuns * work.wholeMs
      /** Per file, the tries its tests have made and those this round gives them. */
      const tried = new Map<string, number>()
      const toTry = new Map<string, number>()
      for (const [id, test] of status.tests) {
        tried.set(test.file, (tried.get(test.file) ?? 0) + test.judged.size)
        toTry.set(test.file, (toTry.get(test.file) ?? 0) + (next.plan.tests[id]?.mutants?.length ?? 0))
      }
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
        // A test trying a mutant in a copy is to have its file to itself, as one trying it in a worker has.
        const trialing = (next.plan.whole[spec.moduleId] ?? []).some((job) => job.trial !== undefined)
        const serial = status.exclusive.has(spec.moduleId) || trialing
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
        // So does one whose mutant blocked a worker before, a loop that is
        // to run out a test's time: one after another in a worker, those of
        // es-toolkit's `array` made the round longer by a fifth.
        const looping = serial ? 0 : (next.plan.whole[spec.moduleId] ?? []).filter((job) => job.stalled && !job.plain).length
        for (let i = 0; i < looping; i++) units.push({ spec, workMs: work.wholeMs + loopMs })
        if (trialing || (work.chunks === 0 && !(spec.moduleId in next.plan.probe))) continue
        // A worker stops at the first test a mutant leaves broken, and what
        // it had taken goes to whichever worker is still on the file. Where
        // that happened before, more of them start together: as many as the
        // tries of this round are likely to stop, going by how often those
        // made so far did. A worker started for a stop that does not come
        // runs every test of the file for nothing, and with two more for
        // every file a worker ever stopped in, that was two workers in three
        // of a round that had a handful of tries left in each of sixty files.
        const taints = status.taints.get(spec.moduleId) ?? 0
        const likely = (taints * (toTry.get(spec.moduleId) ?? 0)) / Math.max(1, tried.get(spec.moduleId) ?? 0)
        // With `--led`, whose tries all come in one round, twice the file's share: a worker cannot move to
        // another file, and rea's `ReverseEngineeringService.ts` went from 188 s to 149 s. Without the
        // option the extra workers cost more than they spared, immer 75 s against 82 s.
        // A pass one worker makes is a chunk of its own, the rest the file's tries.
        let measured = next.plan.measure.includes(spec.moduleId) ? 1 : 0
        const chunks = work.chunks - measured
        const tries = Math.max(1, Math.min(chunks, (takeLeads ? 2 : 1) * Math.ceil((work.workMs - measured * PASS_MS) / unitMs))) + Math.min(Math.round(likely), 2)
        // Tries one worker would make with the file to itself, which counts
        // for what they find, would have the pass beside them: it waits.
        if (measured > 0 && chunks > 0 && tries === 1 && wholeUnits + alone === 0) {
          measured = 0
          delete next.plan.probe[spec.moduleId]
          next.plan.pristine = next.plan.pristine.filter((file) => file !== spec.moduleId)
          next.plan.measure = next.plan.measure.filter((file) => file !== spec.moduleId)
        }
        const count =
          measured > 0
            ? measured + (chunks > 0 ? tries : 0)
            : next.plan.pristine.includes(spec.moduleId)
            ? 1
            : spec.moduleId in next.plan.probe
              ? // A file whose tests still need their unmutated run has tries to make all the same: in rea three
                // workers had `ExecFileOutput.test.ts`, and one of them went through ten tries of 20 s each.
                Math.min(options.maxWorkers, Math.max(1 + taints, work.chunks > 0 ? tries : 0))
              : serial || next.plan.settling
                ? 1
                : tries
        for (let i = 0; i < count; i++) units.push({ spec, workMs: work.workMs / count })
      }
      units.sort((a, b) => b.workMs - a.workMs)
      // Longest first keeps a round from ending on a long run. In a round
      // that gives every worker several runs that matters little, and a fixed
      // order costs more: the tests of the files that come last get their
      // turn only once every other test has tried the same mutants, so a
      // mutant only they can kill is run by all of them.
      if (roundWork / options.maxWorkers > options.budgetMs) {
        // Not a file with more than a worker's share of the round: it ends
        // the round wherever its units stand, the later the later they
        // start, and in rea those of `ExecFileOutput.test.ts` began a minute
        // into a round of fifty shorter ones.
        const share = roundWork / options.maxWorkers
        const heavy = units.filter((unit) => next.workByFile.get(unit.spec.moduleId)!.workMs > share)
        const seed = (index: number) => Math.sin((index + 1) * 12.9898 + rounds * 78.233) * 43758.5453
        const keyed = units.filter((unit) => !heavy.includes(unit)).map((unit, index) => ({ unit, key: seed(index) - Math.floor(seed(index)) }))
        keyed.sort((a, b) => a.key - b.key)
        units.splice(0, units.length, ...heavy, ...keyed.map((entry) => entry.unit))
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
      leading = paired.length * 2
      plan = units.map((unit) => unit.spec)
      oneAtATime = next.plan.quiet
      together = new Set(next.plan.together)
      const unitsOf = new Map<string, number>()
      for (const spec of plan) unitsOf.set(spec.moduleId, (unitsOf.get(spec.moduleId) ?? 0) + 1)
      next.plan.sole = [...unitsOf].flatMap(([file, count]) => (count === 1 ? [file] : []))
      // Before Vitest 4 the pool is told once, for all rounds, whether a worker is started for every file.
      handed = new Set(cloning && major >= 4 ? [...unitsOf.keys()].filter((file) => !status.unhanded.has(file) && !next.plan.whole[file]?.some((job) => job.plain)) : [])
      next.plan.handed = [...handed]
      const driven = new Set(Object.keys(next.plan.tests).map((id) => status.tests.get(id)?.file))
      next.plan.wholeOnly = [...unitsOf.keys()].filter((file) => !driven.has(file) && !(file in next.plan.probe))
      fs.writeFileSync(paths.plan, JSON.stringify(next.plan))
      const totalWork = units.reduce((sum, unit) => sum + unit.workMs, 0)
      options.log(
        `round ${rounds + 1}: ${next.workByFile.size} file(s), ${plan.length} worker run(s), ` +
          `~${Math.round(totalWork / 1000)}s of test time on ${options.maxWorkers} workers`,
      )
      // What the round is made of, for reading a slow run from its log.
      if (process.env.VITANT_DEBUG) {
        const kinds: Record<string, number> = {}
        for (const job of Object.values(next.plan.whole).flat()) {
          const kind = job.calm ? 'calm' : job.trial !== undefined ? 'trial' : job.control ? 'control' : job.pair ? 'pair' : job.quiet ? 'quiet' : job.exclusive ? 'exclusive' : job.plain ? 'plain' : 'whole'
          kinds[kind] = (kinds[kind] ?? 0) + 1
        }
        const trying = Object.values(next.plan.tests).filter((test) => test.mutants)
        options.log(
          `  ${trying.length} test(s) with ${trying.reduce((sum, test) => sum + test.mutants!.length, 0)} tries, ` +
            `${Object.keys(next.plan.tests).length - trying.length} run again, ${Object.keys(next.plan.probe).length} file(s) measured, ` +
            `runs of whole files ${JSON.stringify(kinds)}${next.plan.settling ? ', settling' : ''}${next.plan.quiet ? ', one at a time' : ''}`,
        )
      }
    }
  } finally {
    // A worker that does not end when asked keeps Vitest waiting, and once
    // nothing else is left to wait for, Node ends the process there, with
    // no word and no report. The wait gets a limit of its own, which is
    // also what keeps the process alive until it is over.
    let limit: NodeJS.Timeout | undefined
    // A global setup's teardown runs in close before the wait on the
    // workers, and may take seconds to stop a server or a database: it is
    // not cut short, and close gets the full limit.
    const tearsDown = [vitest.config, ...(vitest.projects ?? []).map((project: { config: typeof vitest.config }) => project.config)].some(
      (config) => [config.globalSetup ?? []].flat().length > 0,
    )
    await Promise.race([
      vitest.close(),
      new Promise((resolve) => (limit = setTimeout(resolve, 15_000))),
      // Vitest 4 waits for a worker it stops to exit unless its `exitCode`
      // is set, which it never is for one that died of a signal, so after a
      // worker that ended itself close does not end. Once every worker is
      // gone, what close has left takes milliseconds.
      ...(tearsDown ? [] : [workersExited().then(() => new Promise((resolve) => setTimeout(resolve, 500).unref()))]),
    ])
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
      // As `inspect` has it: whatever any unmutated run of the test reached.
      if (record.mode === 'probe' && record.baseline === 'pass') coveringSites.set(record.id, [...new Set([...(coveringSites.get(record.id) ?? []), ...record.sites])])
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
  const label = (test: TestState) => `${relative(options.root, test.file)} > ${test.name}`
  const tests = status.tests.size
  const failedBaselines = [...status.tests.values()].filter((t) => t.failed).map(label)
  const nonRepeatableTests = [...status.tests.values()].filter((t) => t.done && t.coverage && !t.failed).map(label)

  if (options.incremental && abandonedFiles.length === 0) {
    const siteKey = (site: number) => keys[generated.siteMutants[site]]
    const toKeys = (mutants: Iterable<number>) => [...mutants].map((mutant) => keys[mutant])
    const readKeys = bindingKeys(generated, options.root)
    const next: Cache = { fingerprint: print, mutants: {}, files: {}, watched: [...readKeys.values()] }
    generated.mutants.forEach((mutant, id) => {
      ;(next.mutants[relative(options.root, mutant.file)] ??= []).push(keys[id])
    })
    for (const [file, pass] of passes) {
      // Read back, what its tests reach would pass for what a plain run shows.
      if (status.unsure.has(file)) continue
      const snapshot = path.join(path.dirname(file), '__snapshots__', `${path.basename(file)}.snap`)
      const entry: CachedFile = {
        deps: {},
        // A read site has no mutant to be keyed by; see `restore`.
        staticSites: pass.staticSites.filter((site) => !generated.readSites.has(site)).map(siteKey),
        hookSites: (pass.hookSites ?? []).filter((site) => !generated.readSites.has(site)).map(siteKey),
        staticMutants: toKeys(status.staticMutants.get(file) ?? []),
        whole: {},
        tests: {},
        reads: [...readKeys].filter(([site]) => status.staticSites.get(file)?.has(site) || status.hookSites.get(file)?.has(site) || status.exercised.get(file)?.has(site)).map(([, key]) => key),
      }
      for (const [key, entryState] of status.whole) {
        const [mutant, wholeFile] = key.split('\n')
        const verdict = wholeVerdict(entryState)
        if (wholeFile === file && verdict && verdict !== 'doubted') entry.whole[keys[Number(mutant)]] = verdict
      }
      for (const dep of [file, snapshot, ...pass.modules!]) {
        entry.deps[relative(options.root, dep)] = hashFile(dep)
      }
      next.files[relative(options.root, file)] = entry
    }
    for (const [id, test] of status.tests) {
      const entry = next.files[relative(options.root, test.file)]
      if (!entry) continue
      const { killed, timedOut } = detectionsOf(id)
      entry.tests[id] = {
        name: test.name,
        baseline: test.failed ? 'fail' : test.coverage ? 'pass' : 'skip',
        baselineMs: test.coverage?.baselineMs ?? 0,
        baselineLoops: test.coverage?.baselineLoops ?? 0,
        nonRepeatable: test.done && !test.failed && test.coverage !== undefined,
        sites: (coveringSites.get(id) ?? []).filter((site) => !generated.readSites.has(site)).map(siteKey),
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
    Unconfirmed: 0,
    Led: 0,
    Timeout: 0,
    NoCoverage: 0,
    Static: 0,
    Pending: 0,
  }
  const wholeRuns: WholeRuns = { started: 0, 'copied before load': 0, 'copied while loading': 0, 'copied after load': 0, 'copied before a test': 0, lost: 0 }
  const work = { trials: 0, trialCpuMs: 0, wholeMs: { passed: 0, detected: 0 }, workers: 0 }
  for (const record of records) {
    if (record.type === 'whole' && record.by) {
      wholeRuns[record.by]++
      work.wholeMs[record.verdict === 'passed' ? 'passed' : 'detected'] += record.ms ?? 0
    } else if (record.type === 'plain' && !record.memory) wholeRuns.lost++
    else if (record.type === 'test') {
      work.trials += record.attempts
      work.trialCpuMs += record.cpuMs
    } else if (record.type === 'worker') work.workers++
  }
  work.trialCpuMs = Math.round(work.trialCpuMs)
  work.wholeMs.passed = Math.round(work.wholeMs.passed)
  work.wholeMs.detected = Math.round(work.wholeMs.detected)
  let nearest: RunResult['nearest']
  if (confirmFiles === Infinity) {
    const places = Math.max(0, ...[...nearestFiles.values()].map((files) => files.length))
    nearest = { detected: new Array<number>(places).fill(0), ms: new Array<number>(places).fill(0) }
    const exempt = (mutant: number, file: string) =>
      status.suspects.get(mutant)?.has(file) === true || status.blocked.get(mutant)?.has(file) === true
    const place = (mutant: number, file: string) => (exempt(mutant, file) ? -1 : (nearestFiles.get(mutant)?.indexOf(file) ?? -1))
    for (const record of records) {
      if (record.type !== 'whole' || !record.by) continue
      const at = place(record.mutant, record.file)
      if (at >= 0) nearest.ms[at] += record.ms ?? 0
    }
    const detectedAt = new Map<number, number>()
    for (const [key, entry] of status.whole) {
      const verdict = wholeVerdict(entry)
      if (verdict !== 'failed' && verdict !== 'timeout') continue
      const [id, file] = key.split('\n')
      const mutant = Number(id)
      const at = place(mutant, file)
      // One file a limit runs all the same is enough.
      detectedAt.set(mutant, Math.min(detectedAt.get(mutant) ?? Infinity, at < 0 ? -1 : at))
    }
    for (const at of detectedAt.values()) if (at >= 0) nearest.detected[at]++
    nearest.ms = nearest.ms.map(Math.round)
  }
  // A file that fails with no mutant on, nothing else running and no test to name leaves no way to tell what a mutant does to it.
  for (const file of status.restless) if (!abandonedFiles.includes(file)) abandonedFiles.push(file)
  const pending = abandonedFiles.length > 0
  const { detected, doubted: doubtedIn, tests: known, led: ledBy } = status
  const proof = (mutant: number): Evidence[] =>
    (status.evidence.get(mutant) ?? []).map((entry) => ({
      ...entry,
      file: relative(options.root, entry.file),
      test: entry.test === undefined ? undefined : (status.tests.get(entry.test)?.name ?? entry.test),
    }))
  const { leftOutOf, everywhere, waveredIn } = doubts(status, records, label)
  const mutants = generated.mutants.map((mutant): MutantResult => {
    const isStatic = staticSites.has(mutant.site)
    const leftOut = [...(leftOutOf.get(mutant.id) ?? []), ...everywhere]
    const wavered = [...(waveredIn.get(mutant.id) ?? [])].filter((test) => !leftOut.includes(test))
    const doubted = [...(doubtedIn.get(mutant.id) ?? [])].map((id) => {
      const test = known.get(id)
      return test ? label(test) : relative(options.root, id)
    })
    let status: MutantStatus
    // Only what runs of whole files found counts; what a test found while trying a mutant led to them.
    if (detected.get(mutant.id) === MUTANT_KILLED) status = 'Killed'
    else if (detected.has(mutant.id)) status = 'Timeout'
    else if (pending || retryAlone.has(mutant.id)) status = 'Pending'
    else if (takeLeads && (state[mutant.id] === MUTANT_KILLED || state[mutant.id] === MUTANT_TIMEOUT)) status = ledBy.has(mutant.id) ? 'Led' : 'Pending'
    else if (coveredBy[mutant.id] > 0 || (isStatic && judgeStatic)) status = unconfirmed.has(mutant.id) || besideOnly.has(mutant.id) || leftOut.length + wavered.length + doubted.length > 0 ? 'Unconfirmed' : 'Survived'
    else status = isStatic ? 'Static' : 'NoCoverage'
    counts[status]++
    return {
      id: mutant.id,
      file: relative(options.root, mutant.file),
      mutator: mutant.mutator,
      replacement: mutant.replacement,
      location: mutant.loc,
      status,
      static: isStatic,
      coveredBy: coveredBy[mutant.id],
      killedBy: killedBy[mutant.id],
      timeoutCause: status === 'Timeout' ? (timeoutCauses.get(mutant.id) ?? 'fresh worker') : undefined,
      confirmed: status === 'Unconfirmed' ? unconfirmed.get(mutant.id) : undefined,
      leftOut: status === 'Unconfirmed' && leftOut.length > 0 ? leftOut : undefined,
      wavered: status === 'Unconfirmed' && wavered.length > 0 ? wavered : undefined,
      doubted: status === 'Unconfirmed' && doubted.length > 0 ? doubted : undefined,
      besideOnly: status === 'Unconfirmed' && besideOnly.has(mutant.id) ? relative(options.root, besideOnly.get(mutant.id)!) : undefined,
      led: status === 'Led' ? { tests: [...ledBy.get(mutant.id)!.tests].map((id) => (known.get(id) ? label(known.get(id)!) : id)), sole: ledBy.get(mutant.id)!.sole } : undefined,
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
    exclusiveFiles: [...status.exclusive].map((file) => relative(options.root, file)),
    unsureFiles: [...status.unsure].map((file) => relative(options.root, file)),
    changedFiles: changedSince(treeBefore, options.root),
    flakyTests: [...status.flaky].flatMap((id) => {
      const test = status.tests.get(id)
      return test ? [label(test)] : []
    }),
    nonRepeatableTests,
    suiteErrors: [...new Set(suiteErrors)],
    abandonedFiles,
    rounds,
    wholeRuns,
    work,
    nearest,
    unplaced: generated.unplaced,
    skippedFiles: generated.skipped,
    vitestVersion,
  }
}
