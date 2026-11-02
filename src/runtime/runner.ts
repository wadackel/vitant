// Runs inside Vitest's test worker. It must not import `vitest`: the base
// runner class and helpers are handed in by a shim generated inside the target
// project, so this file works with whichever Vitest version that project
// resolves.

import { createHook } from 'node:async_hooks'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import { constants, PerformanceObserver } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import {
  createRuntime,
  MUTANT_KILLED,
  MUTANT_PENDING,
  MUTANT_STALLED,
  MUTANT_TIMEOUT,
  type PlannedTest,
  type RoundPlan,
  type WholeJob,
  type Runtime,
  type SessionConfig,
  sessionPaths,
} from '../session.ts'
import { giveUp, meet, take } from './turns.ts'

interface TaskLike {
  id: string
  name: string
  type: string
  mode: string
  fails?: boolean
  concurrent?: boolean
  repeats?: number
  retry?: unknown
  tasks?: TaskLike[]
  file: { filepath: string }
  meta: Record<string, unknown>
  result?: { state: string; errors?: unknown[] }
  context: { skip: (note?: string) => never }
}

interface TryOptions {
  retry: number
  repeats: number
}

interface MockControls {
  restoreAllMocks: () => void
  resetAllMocks: () => void
  clearAllMocks: () => void
  unstubAllEnvs: () => void
  unstubAllGlobals: () => void
}

export interface VitestBindings {
  major: number
  vi: MockControls
  getFn: (test: TaskLike) => (() => unknown) | undefined
  /** Vitest's registry of every mock ever created, where it is a plain Set (before Vitest 5). */
  mocks?: Set<object>
}

/**
 * Before Vitest 5 the mock registry keeps every `vi.fn()` alive, together with
 * the arguments it was called with, until the worker exits. That is harmless
 * when a test runs once and exhausts the heap when it runs thousands of times,
 * so mocks created during an attempt are held weakly once the attempt is over.
 * `vi.clearAllMocks()` and friends still have to reach the ones that are
 * alive, and Vitest goes through the registry two ways: with `forEach` up to
 * 3.0.6, and from 3.0.7 by spreading it and restoring in reverse, so the order
 * matters too. Patching `forEach` alone leaves every mock made before the
 * first attempt ended uncleared from 3.0.7 on: call counts grow from test to
 * test, and tests that count calls fail with no mutant on. Both
 * ways go through one sequence: the weakly held mocks, which were
 * all made before those still in the set, then the set, in the order made.
 */
function trackMocksWeakly(mocks: Set<object>): () => void {
  const weak = new Set<WeakRef<object>>()
  let created: object[] = []
  const add = mocks.add.bind(mocks)
  mocks.add = (mock) => {
    created.push(mock)
    return add(mock)
  }
  const held = mocks.values.bind(mocks)
  function* all(): SetIterator<object> {
    for (const ref of weak) {
      const mock = ref.deref()
      if (mock) yield mock
      else weak.delete(ref)
    }
    yield* held()
  }
  mocks[Symbol.iterator] = all
  mocks.forEach = (callback, thisArg) => {
    for (const mock of [...all()]) callback.call(thisArg, mock, mock, mocks)
  }
  return () => {
    for (const mock of created) {
      if (mocks.delete(mock)) weak.add(new WeakRef(mock))
    }
    created = []
  }
}

/**
 * What a test tries with a mutant: it fails with the mutant, then runs once
 * more without it. The control tells a test the mutant failed from one that
 * broke for good. Passing it makes a lead and no more; a run of the whole
 * file decides.
 */
type Attempt = 'baseline' | 'mutant' | 'control'

interface TestRun {
  /**
   * `probe` starts with an unmutated attempt that finds the mutants the test
   * reaches; `planned` gets its mutants from the plan and starts with them.
   */
  mode: 'probe' | 'planned'
  /** Whether the unmutated run was made before any mutant had been on in this worker. */
  pristine?: boolean
  attempt: Attempt
  /** False while an attempt is in flight. */
  settled: boolean
  /** Sites the unmutated run evaluated (probe mode). */
  sites: number[]
  /** Mutants the unmutated run found able to change the test (probe mode). */
  covered: number[]
  queue: number[]
  next: number
  /** End of the slice of `queue` this worker claimed. */
  sliceEnd: number
  /** Planned tests are claimed a chunk of `queue` at a time. */
  planned?: PlannedTest
  chunkIndex: number
  /** Mutant of the current `mutant` attempt, or the one a `control` attempt is checking. */
  mutant: number
  /** Whether the mutant being checked tripped a time limit rather than an assertion. */
  mutantTimedOut: boolean
  /** Which limit the last attempt tripped, for the report. */
  timeoutCause?: 'loop' | 'timer' | 'idle'
  timeoutCauses: string[]
  /** Why the worker stopped running the test's mutants, for diagnosis. */
  stop?: string
  /** Whether the test has passed in this worker on a run after its first. */
  repeated?: boolean
  startedAt: number
  startedCpu: number
  baselineMs: number
  baselineLoops: number
  baselineState: 'pass' | 'fail' | 'skip'
  baselineError?: string
  /** The unmutated run failed but gets another try in a fresh worker. */
  baselineRetry: boolean
  killed: number[]
  timedOut: number[]
  survived: number[]
  /**
   * The unmutated attempt is made again with the probes off, having run
   * out of the test's time with them on.
   */
  unprobed?: boolean
  /** What the unmutated attempt had reached when the test itself was over. */
  reached?: { sites: number[]; mutants: number[] }
  /**
   * Mutants that could only make a difference once the test itself was
   * over, in the hooks that clean up after it. Those run unmutated here, so
   * the test cannot try these; a run of the whole file can.
   */
  cleanup: number[]
  /**
   * Mutants the test failed with and went on failing without. Nothing is
   * confirmed by that, but a mutant that leaves the worker in such a state
   * has done something, and the file run whole with it says what; left as
   * one more mutant nobody detected, it would cost every test that
   * reaches it a worker before any file is run.
   */
  suspected: number[]
  /** Mutants whose code never ran in a worker that skipped the tests before this one. */
  unreached: number[]
  /**
   * Mutants this test could not judge in place: it failed under them without
   * being able to confirm it, see `nonRepeatable`, or it passed without ever
   * running their code.
   */
  unverified: number[]
  /** The test stopped passing unmutated after it had passed, with the tests before it replayed. */
  nonRepeatable: boolean
  /** Same, in a worker that skipped the tests before it; the file has to be replayed to tell. */
  needsReplay: boolean
  /** Outcome of the last attempt, when the Vitest version reports it after `afterEach`. */
  failed?: boolean
  /** How many errors the attempt had when that outcome was read. */
  errorsSeen?: number
  lastError?: string
  attempts: number
}

// oxlint-disable-next-line typescript/no-explicit-any
type RunnerClass = new (...args: any[]) => any

// Tests may install fake timers, which replace these globals.
const realNow = Date.now.bind(Date)
const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout
const realSetInterval = setInterval
const realClearInterval = clearInterval
const preciseNow = performance.now.bind(performance)

const sessionDir = process.env.VITANT_SESSION
if (!sessionDir) throw new Error('VITANT_SESSION is not set')
const paths = sessionPaths(sessionDir)
let config: SessionConfig = JSON.parse(fs.readFileSync(paths.config, 'utf8'))

const siteMutants = new Uint32Array(
  new Uint8Array(fs.readFileSync(paths.sites)).buffer,
  0,
  config.siteCount + 1,
)
const globals = globalThis as Record<string, unknown>
const runtime: Runtime =
  (globals[config.runtimeGlobal] as Runtime | undefined) ??
  createRuntime(config.siteCount, config.mutantCount)
globals[config.runtimeGlobal] = runtime

const tracked = fs.readFileSync(paths.tracked)

const stateFd = fs.openSync(paths.state, 'r+')
const stateByte = new Uint8Array(1)

function readState(mutant: number): number {
  fs.readSync(stateFd, stateByte, 0, 1, mutant)
  return stateByte[0]
}

function writeState(mutant: number, value: number): void {
  stateByte[0] = value
  fs.writeSync(stateFd, stateByte, 0, 1, mutant)
}

/**
 * A file's run failed with the mutant in this round. What settles that
 * failure ends the search, so the mutant's other files wait for it: Effect's
 * `Option` had two mutants go on through 240 more test files in the round
 * in which one had failed, a tenth of all the time its runs of whole files
 * took. The mark goes with the round, and a failure that comes to nothing
 * leaves those files as open as they were.
 */
const failedMark = (mutant: number): string => path.join(paths.claims, `failed.${mutant}`)

function markFailed(mutant: number): void {
  if (mutant < 0) return
  try {
    fs.closeSync(fs.openSync(failedMark(mutant), 'w'))
  } catch {
    // The runs it would have spared are made.
  }
}

/**
 * A mutant left the test it was tried with failing without it. The copy that
 * goes on with the file starts the work the one before handed back over
 * again, and the mutant is still pending there: in solid one test tried the
 * same mutant 50 times in a row, a copy each, in three rounds. What it does
 * is left to runs of whole files either way.
 */
const taintedMark = (testId: string, mutant: number): string => path.join(paths.claims, `tainted.${testId}.${mutant}`)

function markTainted(testId: string, mutant: number): void {
  try {
    fs.closeSync(fs.openSync(taintedMark(testId, mutant), 'w'))
  } catch {
    // The copy that goes on tries it again.
  }
}

let tryingFd: number | undefined
const tryingMutant = new Int32Array(1)
/**
 * Leaves word of the mutant a test is about to run with, or -1 for none. A
 * process the mutant takes down says nothing afterwards, and this is how
 * the main process learns which one it was.
 */
function trying(mutant: number): void {
  if (tryingFd === undefined && mutant === -1) return
  tryingFd ??= fs.openSync(path.join(paths.trying, String(process.pid)), 'w')
  tryingMutant[0] = mutant
  fs.writeSync(tryingFd, new Uint8Array(tryingMutant.buffer), 0, 4, 0)
}

/** The mutant the process with this id had on for a test when it last said, -1 for none. */
function triedBy(pid: number): number {
  try {
    return new Int32Array(new Uint8Array(fs.readFileSync(path.join(paths.trying, String(pid)))).buffer)[0] ?? -1
  } catch {
    return -1
  }
}

let resultsFd: number | undefined
function emit(record: unknown): void {
  resultsFd ??= fs.openSync(path.join(paths.results, `${process.pid}.jsonl`), 'a')
  fs.writeSync(resultsFd, `${JSON.stringify({ ...(record as object), at: realNow(), pid: process.pid })}\n`)
}

emit({ type: 'worker' })

/**
 * A mutant that blocks the event loop never yields back to the runner, so only
 * another thread can notice. It records which test stalled under which mutant
 * and kills the process. A long but finite computation looks the same from
 * here, so the mutant is left for the whole-file runs to judge.
 *
 * The limit is on CPU time spent since the last heartbeat rather than on wall
 * time: with more workers than cores a worker can go seconds without being
 * scheduled, and that must not read as a mutant that never returns.
 */
const watchdogSource = `
const { workerData } = require('node:worker_threads')
const fs = require('node:fs')
const beat = new Float64Array(workerData.shared, 0, 2)
const stretch = new Float64Array(workerData.stretch)
const mutant = new Int32Array(workerData.shared, 16, 2)
const testId = new Uint8Array(workerData.shared, 24, 256)
const deadline = new Float64Array(workerData.deadline)
const resident = new Float64Array(workerData.resident)
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const fd = fs.openSync(workerData.statePath, 'r+')
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
for (;;) {
  Atomics.wait(sleeper, 0, 0, 100)
  const started = beat[0]
  const stalled = mutant[0]
  // A run of a whole file can also wait for good on what a mutant keeps
  // from happening, using no CPU time at all, where Vitest has no limit on
  // time to end it, such as while the file loads: see clockOn.
  // Nor does a limit on time come soon enough for a mutant that takes a
  // gigabyte a second.
  const clock = deadline[0] > 0 && Date.now() > deadline[0]
  const memory = resident[0] > 0 && process.memoryUsage.rss() > resident[0]
  const overdue = clock || memory
  const long = beat[1] > 0 && cpu() - started > beat[1] && (stretch[1] === 0 || Date.now() - stretch[0] > stretch[1])
  if (long || overdue) {
    const end = testId.indexOf(0)
    const id = new TextDecoder().decode(testId.subarray(0, end === -1 ? testId.length : end))
    // The attempt may have ended while this thread was getting here; the
    // record and the state must name the same mutant, and only one that is
    // still running.
    if (!overdue && (beat[0] !== started || mutant[0] !== stalled || beat[1] === 0)) continue
    // The limit comes from a run of the test after the tests before it. A
    // worker that skipped those has the test do first what they had done,
    // loading what the file's first test loads once for all for one, and
    // on a slow machine that alone is over the limit, with every mutant in
    // turn: the mutant stays as it is and the file's tests are replayed.
    const cold = mutant[1] === 2
    const by = clock ? 'clock' : memory ? 'memory' : 'cpu'
    fs.appendFileSync(workerData.resultsPath, JSON.stringify({ type: 'stall', id, mutant: stalled, cold, whole: mutant[1] === 1, by, at: Date.now(), pid: process.pid }) + String.fromCharCode(10))
    // In a whole-file run the stall is the verdict. Either way it must not
    // replace what another worker has already found out.
    const current = new Uint8Array(1)
    // A run with no mutant on has no byte here; the position -1 would be read as the file's own.
    if (stalled >= 0) fs.readSync(fd, current, 0, 1, stalled)
    if (stalled >= 0 && !cold && (current[0] === ${MUTANT_PENDING} || current[0] === ${MUTANT_STALLED})) {
      fs.writeSync(fd, new Uint8Array([mutant[1] ? ${MUTANT_TIMEOUT} : ${MUTANT_STALLED}]), 0, 1, stalled)
    }
    // A worker that is gone with a mutant on is taken to have died of it.
    if (cold) fs.writeFileSync(workerData.tryingPath, new Uint8Array(new Int32Array([-1]).buffer))
    process.kill(process.pid, 'SIGKILL')
  }
}
`
const shared = new SharedArrayBuffer(24 + 256)
/** [0] process CPU time at the last heartbeat, [1] how much more it may use, 0 when no mutant is active. */
const beat = new Float64Array(shared, 0, 2)
/** [0] the active mutant, [1] 1 in a whole-file run, 2 in a test's first try of a mutant in a worker that skipped the tests before it. */
const beatMutant = new Int32Array(shared, 16, 2)
const beatTest = new Uint8Array(shared, 24, 256)
/**
 * [0] wall time at the last heartbeat, [1] how long by the clock a stretch
 * must last before it is ended, 0 for no such floor. The processor time of
 * the process counts every thread: a loop that allocates keeps the
 * collector's threads busy beside it, and in four seconds by the clock used
 * six of processor time, where the suite's limit of five is on the clock.
 */
const stretch = new Float64Array(new SharedArrayBuffer(16))
/** Sets how much processor time one stretch without a heartbeat may use, and how long by the clock it must at least last. */
function limitStretch(cpuMs: number, wallMs = 0): void {
  beat[1] = cpuMs
  stretch[1] = wallMs
}
/** When a run of a whole file has to have moved on, by the clock; 0 outside one. */
const wallDeadline = new Float64Array(new SharedArrayBuffer(8))
/** How far each heartbeat puts `wallDeadline` off while the body of a test with a limit of Vitest's runs in such a run; 0 otherwise. */
let bodyClockMs = 0
/** How much memory a run of a whole file may hold, in bytes; 0 outside one. */
const residentLimit = new Float64Array(new SharedArrayBuffer(8))
let watching = false
/** Whether this process is a copy made for one whole-file run. */
let cloned = false
/**
 * Whether this process is a copy that runs one test file as a worker Vitest
 * started for the file would: the process Vitest did start hands every file
 * it is given to such a copy and runs nothing of the project itself, so that
 * it stays what a worker is before its first file, for the next.
 */
let hosted = false
/** Whether this copy goes on with a file that a copy before it ended itself in. */
let succeeding = false
/** What Vitest put in the place of `process.exit` when the worker started; it takes it back after the first file. */
let exitGuard: typeof process.exit | undefined
/**
 * Started with the first file rather than with the process: a process that
 * is going to be copied must not have the thread, which a copy would be
 * without while still holding its message ports.
 */
function watch(): void {
  if (watching) return
  watching = true
  new Worker(watchdogSource, {
    eval: true,
    workerData: {
      shared,
      deadline: wallDeadline.buffer,
      stretch: stretch.buffer,
      resident: residentLimit.buffer,
      statePath: paths.state,
      resultsPath: path.join(paths.results, `${process.pid}.jsonl`),
      tryingPath: path.join(paths.trying, String(process.pid)),
    },
  }).unref()
}
const heartbeat = () => {
  const usage = process.cpuUsage()
  beat[0] = (usage.user + usage.system) / 1000
  stretch[0] = realNow()
  // A copy whose watcher is gone has nobody to hand a verdict to, and one
  // that runs a file nobody to end it.
  if ((cloned || hosted) && process.ppid !== copiedFrom) cloner!.exit(1)
  // Vitest ends a test's body by a timer, which only fires while the event
  // loop turns: a body that blocks it without using the processor, on a
  // child process run to its end for one, is left to the clock.
  if (bodyClockMs > 0) wallDeadline[0] = realNow() + bodyClockMs
  // A copy has no thread that would stop it by the clock. Over its time it
  // ends without a verdict, rather than with a timeout as a worker does: a
  // copy can wait for good on a thread it does not have, and a worker
  // started for the job decides.
  if (cloned && wallDeadline[0] > 0 && realNow() > wallDeadline[0]) cloner!.exit(1)
  if (cloned) {
    // It has no thread to watch it; the process it was copied from does,
    // from outside, and is told what the thread would read.
    cloner!.heartbeat(beat[0], beat[1], stretch[1])
  }
  if (hosted) cloner!.turned()
}
heartbeat()
realSetInterval(heartbeat, 50).unref()

/** The addon that copies a process (`native/src/lib.rs`). */
interface Cloner {
  /** 0 in the copy, its process id in the one that was copied. */
  fork(lock: number): number
  pid(): number
  heartbeat(cpuMs: number, limitMs: number, floorMs: number): void
  /** In a copy: its verdict is written. */
  done(): void
  /** Waits for a copy to end and says how it did. */
  supervise(pid: number, stuckMs: number, residentLimit: number): number
  /** In a copy that runs a test file, or one it made: its event loop has turned. */
  turned(): void
  /** Waits for a copy that watches itself; the code it ended itself with, -1, or -2 where it was stopped as stuck. */
  host(pid: number, stuckMs: number): number
  Ended: { Done: number; Blocked: number; Lost: number }
  exit(code: number): never
}
/** In a copy: the id of the process it was copied from. */
let copiedFrom = 0
// V8 hands work to other threads unless told not to, and a copy would wait
// for threads it does not have.
const cloner: Cloner | undefined =
  process.env.VITANT_FORK && process.execArgv.includes('--single-threaded')
    ? createRequire(import.meta.url)(process.env.VITANT_FORK)
    : undefined

/**
 * How long this process, and those it was copied from, stood still for
 * copies of themselves since the project's code began: a copy made after
 * others starts that much later than the run it stands for, and a process
 * that made copies goes on that much later. The clocks the project reads
 * leave it out, so that a copy reads the time it would have read in a run
 * of the suite: a test that checks how long has passed since the file
 * loaded, or since an earlier test, would otherwise see the copies before
 * it. Timers are put off by the same, see `stoodStill` and `thaw`. In
 * whole milliseconds, as `Date.now()` has them: formbricks makes a BigInt
 * of it, which a fraction fails.
 */
let stood = 0

/**
 * Puts clocks in place of `Date`, `performance.now`, `process.hrtime` and
 * `process.uptime` that leave out `stood`, before the project's code reads
 * them. `Date` is a function returning the engine's own dates, with its
 * prototype, as fake timers make it: a class of its own would give
 * `new Date()` another prototype and fail `instanceof` both ways.
 */
function standClocks(): void {
  const NativeDate = Date
  const nativeNow = NativeDate.now.bind(NativeDate)
  const nativeBigint = process.hrtime.bigint.bind(process.hrtime)
  const nativeUptime = process.uptime.bind(process)
  const nativePerformanceNow = performance.now.bind(performance)
  function StoodDate(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new NativeDate(nativeNow() - stood).toString()
    const date = args.length === 0 ? new NativeDate(nativeNow() - stood) : new (NativeDate as unknown as new (...args: unknown[]) => Date)(...args)
    if (new.target !== StoodDate) Object.setPrototypeOf(date, new.target.prototype)
    return date
  }
  for (const key of Reflect.ownKeys(NativeDate)) {
    if (key === 'now') continue
    Object.defineProperty(StoodDate, key, Object.getOwnPropertyDescriptor(NativeDate, key)!)
  }
  Object.defineProperty(StoodDate, 'now', { value: () => nativeNow() - stood, writable: true, configurable: true })
  globalThis.Date = StoodDate as unknown as DateConstructor
  performance.now = () => nativePerformanceNow() - stood
  const bigint = () => nativeBigint() - BigInt(Math.round(stood * 1e6))
  const hrtime = ((previous?: [number, number]) => {
    const now = bigint()
    const since = previous ? now - (BigInt(previous[0]) * 1_000_000_000n + BigInt(previous[1])) : now
    return [Number(since / 1_000_000_000n), Number(since % 1_000_000_000n)]
  }) as typeof process.hrtime
  hrtime.bigint = bigint
  process.hrtime = hrtime
  process.uptime = () => nativeUptime() - stood / 1000
}
if (cloner) standClocks()

/** Calls that change the file system somewhere outside this tool's session, since the worker started, see `countWrites`. */
let writes = 0

/**
 * Counts the calls of `fs` that change the file system. What one test
 * writes and closes, a later one can read or remove: made once in a
 * process that is copied before the later test, it is there for one copy
 * and gone for the next, where every run of the suite makes its own.
 * Nothing open is left to show for it, so the calls are counted. Through a
 * descriptor opened before, a write needs no call counted here; the
 * descriptor is left open, and that is seen.
 */
function countWrites(): void {
  const session = path.resolve(sessionDir!)
  const outside = (target: unknown) => {
    const name =
      typeof target === 'string' ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : undefined
    return name === undefined || !path.resolve(name).startsWith(session)
  }
  const writing = (flags: unknown) =>
    typeof flags === 'string'
      ? /[wa+]/.test(flags)
      : typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0
  const wrap = (object: Record<string, unknown>, name: string, counts: (args: unknown[]) => boolean) => {
    const original = object[name]
    if (typeof original !== 'function') return
    object[name] = function (this: unknown, ...args: unknown[]) {
      if (counts(args)) writes++
      return original.apply(this, args)
    }
  }
  const changes = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'truncate', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes', 'symlink', 'link']
  const modules = [fs as unknown as Record<string, unknown>, fs.promises as unknown as Record<string, unknown>]
  for (const object of modules) {
    for (const name of changes) for (const variant of object === modules[0] ? [name, `${name}Sync`] : [name]) wrap(object, variant, (args) => outside(args[0]))
    for (const name of object === modules[0] ? ['open', 'openSync'] : ['open']) wrap(object, name, (args) => writing(args[1]) && outside(args[0]))
  }
  wrap(modules[0], 'createWriteStream', (args) => outside(args[0]))
  syncBuiltinESMExports()
}
if (cloner) countWrites()

/**
 * Where a copy notes the test it is in. The process that copied it stops it
 * from outside, on its time on the processor or its memory, and a copy's
 * memory is its own: read from here, the stop names the test, as one by the
 * watchdog of a worker started for the run does, and a lead of that test
 * vouches for it. Without it a mutant whose loop filled memory waited for a
 * run made with nothing else running.
 */
const testSlot = cloner ? fs.openSync(path.join(sessionDir!, `slot.${process.pid}`), 'w+') : undefined

/** Notes the test a run of a whole file is in, or that it is in none. */
function noteTest(id?: string): void {
  beatTest.fill(0)
  const bytes = new TextEncoder().encode(id ?? '').subarray(0, 255)
  beatTest.set(bytes)
  if (testSlot !== undefined && cloned) {
    const slot = Buffer.alloc(256)
    slot.set(bytes)
    fs.writeSync(testSlot, slot, 0, 256, 0)
  }
}

/** The test the copy this process stopped was in, see `testSlot`. */
function stoppedIn(): string | undefined {
  if (testSlot === undefined) return undefined
  const slot = Buffer.alloc(256)
  fs.readSync(testSlot, slot, 0, 256, 0)
  const end = slot.indexOf(0)
  const id = slot.subarray(0, end === -1 ? 256 : end).toString('utf8')
  return id === '' ? undefined : id
}

/** What a copy that runs a test file ends with to be replaced by another, see `handOver`. */
const RECYCLED = 75
/**
 * How long a copy that runs a test file may sit with no child, no CPU time
 * and no turn of an event loop before it is taken to be stuck at a lock.
 */
const HOST_STUCK_MS = 30_000
/** How many copies one after another are given a file in a round. */
const MAX_COPIES = 50

/** How long a copy may go without a heartbeat while using no CPU time. */
const STUCK_MS = 3000

type CopiedBy = 'copied before load' | 'copied while loading' | 'copied after load' | 'copied before a test'

/** In `runtime.a`: no mutant is on, and none is to be probed for either. */
const NO_MUTANT = 0x7fffffff

/**
 * Held open from the start, so that it is among the descriptors a process
 * had before it loaded the file, which are what a copy may share.
 */
let forkLock: number | undefined = cloner ? fs.openSync(paths.config, 'r') : undefined
/** Calls to the main process that have not been answered. */
let calls = 0
let counting = false
/**
 * This process runs a file's tests only to copy itself before some of
 * them, see `walk`: nothing reads what they print, and a call to print it
 * still out when a copy is due keeps the copy from being made, 575 times in
 * a run of jotai on a Linux runner.
 */
let walking = false
/**
 * Counts the calls this process has out. A copy shares the channel with the
 * process it was copied from: an answer to one would reach the other, and
 * half of one, if a copy ended while reading it, the next copy.
 */
/** The wrapped channels: Vitest hands the runner one state and keeps another for itself. */
const wrapped = new WeakSet<object>()
function trackCalls(state: { rpc?: object } | undefined): void {
  if (!state?.rpc || wrapped.has(state.rpc)) return
  counting = true
  const plain = state.rpc
  state.rpc = new Proxy(plain, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function' || typeof key !== 'string' || key.startsWith('$')) return value
      // What a test prints is the one long message a copy would send, and a
      // copy stopped with half of it sent would leave the channel, which the
      // process it was copied from goes on using, with a message that never
      // ends. Nothing reads the output of a copy's run.
      if ((cloned || walking) && key === 'onUserConsoleLog') return () => {}
      // The functions carry variants of themselves as properties, which stay reachable.
      return new Proxy(value, {
        apply(fn, self, args) {
          const result = Reflect.apply(fn, self, args) as { then?: (resolved: () => void, rejected: () => void) => unknown } | undefined
          if (result && typeof result.then === 'function') {
            calls++
            const done = () => void calls--
            result.then(done, done)
          }
          return result
        },
      })
    },
  })
  wrapped.add(state.rpc)
}
/**
 * How much longer than a loop past its count may keep the process busy the
 * watchdog lets a stretch go on. A copy that the process it came from stops
 * names no test, and a lead its test gave for the same loop then does not
 * vouch for it; ended in the test, the loop names it.
 */
const LOOP_FIRST_MS = 1000

/** How often a loop past its count in a whole-file run looks whether it may be ended, in milliseconds. */
const LOOP_LOOK_MS = 10

/** How long Vitest lets a test or a hook run before it fails it, or 0 where it gives no limit, which leaves this runner's own. */
function deadline(ms: number | undefined): number {
  return ms !== undefined && ms > 0 && Number.isFinite(ms) ? ms : 0
}

/**
 * Timers set while a file loads, whether they keep the process alive or
 * not: what the process lists as active leaves out one that was unref'd, and
 * a copy made later meets it due sooner, or at once. In a file whose code
 * turned a flag off 300 ms after loading, a copy made later passed a test
 * that every run of the suite fails.
 */
interface LoadTimer {
  _destroyed?: boolean
  _idleStart?: number
  _idleTimeout?: number
  refresh?: () => unknown
}
const loadTimers: LoadTimer[] = []
const timerHook = createHook({
  // Node calls `destroy` later than a timer is done with, and a timer that fired is no longer due in a copy.
  init(_id, type, _trigger, resource) {
    if (type === 'Timeout') loadTimers.push(resource as { _destroyed?: boolean })
  },
})

/**
 * Moves the timers set while the file loads as late as the time a process
 * stood still, so that each is due as far into what runs next as it was
 * when the process stopped. Node takes a timer's due time from its start
 * every time its list comes up, and puts the list back for later where the
 * first timer is not due yet.
 */
function stoodStill(ms: number): void {
  const by = Math.round(ms)
  stood += by
  for (const timer of loadTimers) if (!timer._destroyed && timer._idleStart !== undefined) timer._idleStart += by
}

/** Timers set while the file loaded, put off for now, with what was left of each when they were. */
let frozen: [LoadTimer, number][] = []
/** When `freeze` stopped the clocks of `standClocks`. */
let frozenAt = 0

/**
 * Puts every timer set while the file loaded off for good, keeping what
 * was left of it, so that none goes off while this process waits between
 * copies made once the file has loaded: `stoodStill` after the fact
 * cannot take back a callback that has run. A timer's due time is its
 * start in the event loop's time plus its delay; that time is read off a
 * timer made for the purpose.
 */
function freeze(): void {
  frozenAt = preciseNow()
  const probe = realSetTimeout(() => {}, 0) as unknown as LoadTimer
  const now = probe._idleStart
  clearTimeout(probe as unknown as NodeJS.Timeout)
  frozen = []
  for (const timer of loadTimers) {
    if (timer._destroyed || timer._idleStart === undefined || timer._idleTimeout === undefined || now === undefined || !timer.refresh) continue
    frozen.push([timer, Math.max(0, timer._idleStart + timer._idleTimeout - now)])
    timer._idleTimeout = 2 ** 31 - 1
    timer.refresh()
  }
}

/**
 * Makes each timer `freeze` put off due as long from now as it was then.
 * An interval goes on at its own period after that, which Node takes from
 * `_repeat`.
 */
function thaw(): void {
  stood += Math.round(preciseNow() - frozenAt)
  for (const [timer, left] of frozen) {
    if (timer._destroyed) continue
    timer._idleTimeout = left
    timer.refresh!()
  }
  frozen = []
}

/**
 * Waits for what this process has under way to end, and says whether it
 * then holds nothing open beyond `before`. A write half done would be
 * finished by the process and its copy both; a request a thread is working
 * on would never be answered in the copy.
 *
 * Timers count only once the project's code has run. One it set would be
 * due sooner in each copy made later, where every run of the suite has it
 * due at the same point; Vitest's own are in every worker alike.
 */
async function calm(before: Map<string, number>, ignored: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await quiet()
    const now = activeResources()
    for (const kind of ignored) now.delete(kind)
    if (!exceeds(now, before)) return true
    await new Promise((resolve) => realSetTimeout(resolve, 5))
  }
  return false
}

/**
 * The file descriptors this process has open, or nothing where that cannot
 * be told. What keeps the event loop alive is not all a process has open: a
 * file opened and left open keeps nothing alive, and copies made afterwards
 * would read on from where the one before stopped.
 */
function openDescriptors(): Set<string> | undefined {
  try {
    return new Set(fs.readdirSync('/dev/fd'))
  } catch {
    return undefined
  }
}

/** Resolves once every call has its answer. */
async function quiet(): Promise<void> {
  while (calls > 0 || unanswered.size > 0) await new Promise((resolve) => realSetTimeout(resolve, 0))
}

/** Whether `waited` came about within the time an answer of the main process may take on a machine that is behind. */
function inTime(waited: Promise<unknown>): Promise<boolean> {
  return Promise.race([waited.then(() => true), new Promise<boolean>((resolve) => realSetTimeout(() => resolve(false), 60_000))])
}

/** Ids of the calls this process has sent to the main process and has no answer to. */
const watched = (globalThis as { __vitant_unanswered?: Set<string> }).__vitant_unanswered
const unanswered = watched ?? new Set<string>()
let listening = false

/** The call or the answer inside a message of the channel, however Vitest wraps it. */
function envelope(message: unknown, depth = 0): { t?: unknown; i?: unknown } | undefined {
  if (message === null || typeof message !== 'object' || depth > 3) return undefined
  const plain = message as { type?: unknown; data?: unknown }
  const bytes = ArrayBuffer.isView(message)
    ? (message as Uint8Array)
    : plain.type === 'Buffer' && Array.isArray(plain.data)
      ? Buffer.from(plain.data as number[])
      : undefined
  if (bytes) {
    try {
      return envelope(v8.deserialize(bytes), depth + 1)
    } catch {
      return undefined
    }
  }
  const candidate = message as { t?: unknown; i?: unknown }
  if ((candidate.t === 'q' || candidate.t === 's') && typeof candidate.i === 'string') return candidate
  for (const value of Object.values(message)) {
    const found = envelope(value, depth + 1)
    if (found) return found
  }
  return undefined
}

/**
 * Counts calls by what goes over the channel. Counting them where they are
 * made misses those made through a reference taken before the count
 * began, what a test prints for one: with such a call under way a copy
 * was made, the copy read the answer, and the process it was copied from
 * waited for it for good at the end of its file.
 */
function trackChannel(): void {
  // `send` itself may have been taken hold of before this runs; what it calls has not.
  const target = process as unknown as { _send?: (...args: unknown[]) => boolean }
  if (listening || watched || !target._send) return
  listening = true
  const send = target._send
  target._send = function (this: unknown, ...args: unknown[]) {
    const sent = envelope(args[0])
    if (sent?.t === 'q') unanswered.add(sent.i as string)
    return send.apply(this, args)
  }
  process.prependListener('message', (message: unknown) => {
    const answer = envelope(message)
    if (answer?.t === 's') unanswered.delete(answer.i as string)
  })
}

const staticHits = new Uint8Array(config.siteCount)
const staticMutants = new Uint8Array(config.mutantCount)
/**
 * The same for what ran once the file had loaded, outside the tests that
 * try mutants: `beforeAll` and `afterAll` hooks, fixtures shared by a
 * file, tests left to run as the project set them up. A run of the whole
 * file is all that can judge a mutant there.
 */
const hookHits = new Uint8Array(config.siteCount)
const hookMutants = new Uint8Array(config.mutantCount)
/** Whether the test file is past its imports and `describe` bodies. */
let loaded = false
let plan: RoundPlan | undefined
let retried = new Set<string>()
let replayFiles = new Set<string>()
let probed = new Set<string>()

/**
 * Reads the round's plan. A worker that Vitest keeps alive between files can
 * outlive a round, so this happens per file rather than once per process.
 */
function loadRound(): void {
  config = JSON.parse(fs.readFileSync(paths.config, 'utf8'))
  plan = fs.existsSync(paths.plan) ? JSON.parse(fs.readFileSync(paths.plan, 'utf8')) : undefined
  retried = new Set(plan?.retried)
  replayFiles = new Set([...(plan?.replay ?? []), ...Object.keys(plan?.probe ?? {})])
  probed = new Set(Object.values(plan?.probe ?? {}).flat())
}

/**
 * Whether tests this worker does not drive still run once, unmutated. The
 * first round runs every test anyway. Later workers skip them, which is only
 * wrong for a test that needs what an earlier test left behind; such a test
 * fails without the mutant and its file is replayed from then on.
 */
function replays(file: string): boolean {
  return !plan || replayFiles.has(file)
}

/**
 * Folds hits recorded outside any test (module load, `beforeAll`) into the
 * static set, with the mutants that would have made a difference there.
 */
function drainStaticHits(): void {
  outside(drainCoverage())
}

function outside({ sites, mutants }: { sites: number[]; mutants: number[] }): void {
  for (const site of sites) (loaded ? hookHits : staticHits)[site] = 1
  for (const mutant of mutants) (loaded ? hookMutants : staticMutants)[mutant] = 1
}

function marked(flags: Uint8Array): number[] {
  const list: number[] = []
  for (let at = flags.indexOf(1); at !== -1; at = flags.indexOf(1, at + 1)) list.push(at)
  return list
}

/** How often a test is run again after failing, as the project set it. */
function retries(test: TaskLike): number {
  const { retry } = test
  if (typeof retry === 'number') return retry
  return (retry as { count?: number } | undefined)?.count ?? 0
}

/**
 * Reads what the unmutated attempt touched. A tracked mutant whose probe never
 * saw a different value cannot change the test's outcome, so it is left out.
 */
function mutantsAt(site: number): number[] {
  const list: number[] = []
  for (let mutant = siteMutants[site]; mutant < siteMutants[site + 1]; mutant++) list.push(mutant)
  return list
}

function drainCoverage(): { sites: number[]; mutants: number[] } {
  const hits = runtime.h
  const infected = runtime.i
  const unfinished = runtime.b
  const sites: number[] = []
  const mutants: number[] = []
  for (let site = hits.indexOf(1); site !== -1; site = hits.indexOf(1, site + 1)) {
    hits[site] = 0
    sites.push(site)
    const threw = unfinished[site] !== 0
    for (let mutant = siteMutants[site]; mutant < siteMutants[site + 1]; mutant++) {
      if (tracked[mutant] === 0 || infected[mutant] === 1 || threw) mutants.push(mutant)
      infected[mutant] = 0
    }
  }
  unfinished.fill(0)
  return { sites, mutants }
}

/**
 * Live heap size as of the last major GC. `heapUsed` between collections also
 * counts garbage, and forcing a collection to find out costs close to a second
 * on a large heap.
 */
let liveHeap = 0
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const kind = (entry as { detail?: { kind?: number } }).detail?.kind
    if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) liveHeap = process.memoryUsage().heapUsed
  }
}).observe({ entryTypes: ['gc'] })

/**
 * Whether the worker should hand over to a fresh one. The live heap catches
 * leaks; the resident size also catches a heap that grows without a major GC
 * and memory held outside it, such as jsdom's native allocations.
 */
function memoryExceeded(): boolean {
  return liveHeap > config.recycleHeapBytes || process.memoryUsage.rss() > config.recycleHeapBytes * 1.5
}

function forEachTask(tasks: TaskLike[], fn: (task: TaskLike) => void): void {
  for (const task of tasks) {
    fn(task)
    if (task.tasks) forEachTask(task.tasks, fn)
  }
}

/** Skips the tests not in this round's plan; returns whether anything under `task` still runs. */
function skipUnplanned(task: TaskLike): boolean {
  if (task.mode !== 'run' && task.mode !== 'queued') return false
  if (task.type === 'test') {
    if (plan!.tests[task.id]) return true
    task.mode = 'skip'
    return false
  }
  let runs = false
  for (const child of task.tasks ?? []) runs = skipUnplanned(child) || runs
  if (!runs && task.type === 'suite') task.mode = 'skip'
  return runs
}

/** Files of the project that the worker evaluated, across Vitest versions. */
function loadedModules(state: {
  moduleCache?: Map<string, unknown>
  evaluatedModules?: { fileToModulesMap: Map<string, unknown> }
}): string[] {
  const ids = state.evaluatedModules?.fileToModulesMap.keys() ?? state.moduleCache?.keys() ?? []
  const files = new Set<string>()
  for (const id of ids) {
    const file = id.split('?')[0]
    if (path.isAbsolute(file) && !file.includes('/node_modules/') && fs.existsSync(file)) files.add(file)
  }
  return [...files]
}

function cpuMs(): number {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000
}

/**
 * Vitest serialises what a test throws and gives up on the test where it
 * cannot, an assertion error that holds a revoked proxy for one. Of a run
 * with a mutant on, or of the control run after it, only the message is used.
 */
function plainError(error: unknown): unknown {
  try {
    const { code, message } = error as { code?: unknown; message?: unknown }
    // How a test skips itself.
    if (code === 'VITEST_PENDING') return error
    return new Error(String(message ?? error))
  } catch {
    return new Error('unknown error')
  }
}

/** What a first-round worker spends at most on the mutants its tests try in passing. */
const TRIAL_BUDGET_MS = 2000

/** What a mutant run may take before it is looked at. */
function limitMs(run: { baselineMs: number }): number {
  return run.baselineMs * config.timeoutFactor + config.timeoutMs
}

/** The longest a mutant run may take, however busy the machine is. */
function hardLimitMs(run: { baselineMs: number }): number {
  return limitMs(run) * 5
}

/**
 * The most memory a run of a whole file may hold with a mutant on. Like the
 * limit on time it is a judgement: four times what the file's tests were
 * seen to leave a worker holding, and a gigabyte. Where that was not
 * measured, and for a file that takes most of its memory while it loads,
 * what this process holds stands in.
 */
function residentLimitOf(job: { fileRss: number }): number {
  return Math.max(job.fileRss, process.memoryUsage.rss()) * 4 + 1024 ** 3
}

function firstError(test: TaskLike): string | undefined {
  const error = test.result?.errors?.[0] as { message?: string } | undefined
  return error?.message?.slice(0, 500)
}

/**
 * Several workers may run the same file at once. Whichever creates the claim
 * file first takes the test, or the chunk of its mutants; the others move on.
 */
let heldLock: string | undefined

/**
 * Waits until no other run of the test file is under way and keeps the
 * others out until `release`, see `WholeJob.exclusive`; with no file named,
 * until nothing else runs at all, see `WholeJob.quiet`.
 */
async function alone(file: string): Promise<void> {
  heldLock ??= await take(paths.locks, file)
}

/** A copy shares what the process it was copied from holds, and that one lets go of it. */
function release(): void {
  if (cloned || !heldLock) return
  giveUp(heldLock)
  heldLock = undefined
}
process.on('exit', release)

/** Starts a run of `WholeJob.pair` at the same moment as the other one. Says whether the other one came. */
function meetOther(job: WholeJob, jobs: WholeJob[]): Promise<boolean> {
  const other = jobs.find((candidate) => candidate.pair && candidate.id !== job.id)
  if (!other) return Promise.resolve(false)
  const taken = (id: number) => path.join(paths.claims, `whole.${id}`)
  // The other half may have to wait for a worker that a run of this length holds.
  return meet(taken(job.id), taken(other.id), 10_000 + 3 * job.fileMs)
}

function taken(name: string): boolean {
  return fs.existsSync(path.join(paths.claims, name))
}

function claim(name: string): boolean {
  try {
    fs.closeSync(fs.openSync(path.join(paths.claims, name), 'wx'))
    return true
  } catch {
    return false
  }
}

function claimed(name: string): boolean {
  return fs.existsSync(path.join(paths.claims, name))
}

/**
 * Claims the next free chunk of a planned test's mutants, looking from `from`
 * on and then at the ones before it, which a recycled worker may have handed
 * back; -1 when none is left.
 */
function claimChunk(testId: string, planned: PlannedTest, from: number): number {
  const chunks = Math.ceil(planned.mutants!.length / planned.chunk)
  for (let step = 0; step < chunks; step++) {
    const index = (from + step) % chunks
    if (claim(`${testId}.${index}`)) return index
  }
  return -1
}

/** Whether a planned test still has work for a worker that reaches it. */
function untaken(testId: string): boolean {
  const planned = plan?.tests[testId]
  if (!planned) return false
  if (!planned.mutants) return !taken(testId)
  const chunks = Math.ceil(planned.mutants.length / planned.chunk)
  for (let index = 0; index < chunks; index++) if (!taken(`${testId}.${index}`)) return true
  return false
}

function newRun(mode: TestRun['mode']): TestRun {
  return {
    mode,
    attempt: mode === 'probe' ? 'baseline' : 'mutant',
    settled: false,
    sites: [],
    covered: [],
    queue: [],
    next: 0,
    sliceEnd: 0,
    chunkIndex: -1,
    mutant: -1,
    mutantTimedOut: false,
    startedAt: preciseNow(),
    startedCpu: cpuMs(),
    baselineMs: 0,
    baselineLoops: 0,
    baselineState: 'skip',
    baselineRetry: false,
    killed: [],
    timedOut: [],
    survived: [],
    cleanup: [],
    suspected: [],
    unreached: [],
    unverified: [],
    nonRepeatable: false,
    needsReplay: false,
    attempts: 0,
    timeoutCauses: [],
  }
}

const NEVER_ENDING = 1e9
/** How far back a timed-out attempt is checked for CPU use before it counts as hung. */
const WINDOW_MS = 1000
const IDLE_POLL_MS = 100
const IDLE_MS = 500

/** What keeps the event loop alive, counted by kind. */
function activeResources(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const kind of process.getActiveResourcesInfo()) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return counts
}

/** What the worker holds open before any test file is loaded, the watchdog's thread included. */
let workerResources = activeResources()

function exceeds(now: Map<string, number>, before: Map<string, number>): boolean {
  for (const [kind, count] of now) if (count > (before.get(kind) ?? 0)) return true
  return false
}

export function withMutationTesting<T extends RunnerClass>(Base: T, vitest: VitestBindings): T {
  const releaseMocks = vitest.mocks instanceof Set ? trackMocksWeakly(vitest.mocks) : undefined

  return class MutationRunner extends Base {
    constructor(...args: any[]) {
      super(...args)
      // From the start, so that as few calls as possible are out uncounted
      // when the first copy is made.
      if (cloner) {
        trackCalls(this.workerState as { rpc?: object })
        // What a test prints is sent through the state Vitest keeps in a
        // global, which is not always the one the runner is given: its
        // calls went uncounted, and a copy made with one under way read
        // the answer in place of the process that waits for it.
        trackCalls((globalThis as { __vitest_worker__?: { rpc?: object } }).__vitest_worker__)
        trackChannel()
      }
    }

    /** Tests admitted in `onBeforeRunTask`, waiting for their first attempt. */
    private admitted = new Map<string, TestRun>()
    /** The test whose attempt is in flight, if it is one this runner drives. */
    private active: { test: TaskLike; run: TestRun } | undefined
    /** Set while a test runs that this runner only lets pass through. */
    private passive = false
    /** Tests that run as the project set them up, without mutants being tried on them. */
    private apart = new Set<string>()
    private passiveApart = false
    private loopLimit = runtime.x
    /** Every runnable test of the files this worker ran. */
    private seen: string[] = []
    /** In a replayed file, the tests anyone drives, in the order they run. */
    private ahead: string[] = []
    /** Whether nothing is left for this worker to drive in its replayed file. */
    private through = false
    /**
     * Tests of `ahead` seen with every chunk taken. Looked up on disk for
     * each test passed by, the tests after it went quadratic in a worker
     * that starts after the others: 25 million lookups and 248 s of twelve
     * workers in one round of immer. A chunk handed back after that is left
     * to the next round, as it is once `through` is set.
     */
    private full = new Set<string>()
    /** This worker makes its file's pass, see `RoundPlan.measure`. */
    private measuring = false
    /** In a run of a whole file, the shortest stretch, on the processor and by the clock, that ends it: the suite's own limit for what is running. */
    private floorMs = 0
    /** In a run of a whole file, the limit on a stretch that comes from what the file takes. */
    private wholeBase = 0
    /** In a run of a whole file, how long by the clock it may go without moving on, see `clockOn`. */
    private wholeClockMs = 0
    /** In a run of a whole file, how many test bodies with a time limit of Vitest's are running. */
    private wholeBodies = 0
    /** When this process took its file on, before loading it. */
    private fileStart = 0
    /** Whether a test stopped passing unmutated in this worker, which ends the worker. */
    private tainted = false
    /** Whether a mutant has been on in this worker. */
    private attempted = false
    /**
     * Whether a test failed its unmutated run in this worker, or ran out of
     * time under the probes and was run again in place. The tests after it
     * start from what that left, as those after a mutant do.
     */
    private upset = false
    /** In a copy made for one test to try a mutant: the test is through, or one before it failed. */
    private trialOver = false
    private trialSaid = false
    /** How many tests a pass that measures the file left out for failing with no mutant on. */
    private ignored = 0
    /** Time this worker has spent on mutants its tests tried in passing. */
    private trialMs = 0
    /** The mutant this worker runs the whole file with, if it took such a job. */
    private whole: WholeJob | undefined
    private wholeFailure: 'failed' | 'timeout' | undefined
    private wholeFile: string | undefined
    private wholeStartedAt = 0
    /** The test whose failure the run's verdict is, if it was a test's. */
    private wholeTest: string | undefined
    /** For a run of `WholeJob.pair`: the other run was there to start with. */
    private pairMet = false
    /** Every test that failed in the run; more than the first where the run went on for a witness. */
    private wholeTests: string[] = []
    /** The witnesses of the job that have not run yet, see `wholeSettled`. */
    private wholeWaits = new Set<string>()
    /** Tests of the run that Vitest's own time limit ended. */
    private wholeOverran = 0
    /**
     * While this process runs the file's tests with no mutant on to copy
     * itself before some of them, the runs to copy for, by the test they
     * are made before: see `walk`.
     */
    private walking: Map<string, WholeJob[]> | undefined
    /** Tests the runs of the file leave out, which the process walking it leaves out too. */
    private walkIgnore: string[] = []
    /** This process walked the file, see `walk`. */
    private walked = false
    /** A test failed, or an error nothing handled came, while walking. */
    private walkFailed = false
    /** `writes` as the walk began. */
    private walkWrites = 0
    /** The teardowns of fixtures scoped to the worker, each made to run once, see `onCleanupWorkerContext`. */
    private workerCleanups: (() => Promise<unknown>)[] = []
    /** This copy repeats a run that failed where no test had failed while trying the mutant. */
    /** How the process making the whole-file run came to be. */
    private wholeBy: 'started' | CopiedBy = 'started'
    /** This process loads the file with no mutant on, to be copied for each job once it has. */
    private template = false
    private heldBeforeLoad = new Map<string, number>()
    private openBeforeLoad: Set<string> | undefined
    /** Jobs to be copied for as their mutants' modules begin their own code, see `copyWhileLoading`. */
    private waiting: WholeJob[] = []
    /** No copy was made while the file loaded, where one was to be. */
    private unpaused = false
    /** Vitest gave up on a test part-way, and with it on the rest of its suite. */
    private dropped = false
    /** A copy of this process runs the file; this one imports nothing of it. */
    private away = false
    /**
     * The file's runs are all made in other processes, and no test of it is
     * for this one: loading it would be for nothing, at what one more run of
     * the file costs.
     */
    private idle = false

    /**
     * Hands the file to a copy of this process and waits for it. Returns
     * whether this is the process that waited.
     */
    private async handOver(file: string): Promise<boolean> {
      exitGuard ??= process.exit
      await this.standStill()
      forkLock ??= fs.openSync(paths.config, 'r')
      const self = process.pid
      for (let copies = 1; ; copies++) {
        let pid: number
        try {
          pid = cloner!.fork(forkLock)
        } catch (error) {
          // Running the file here would leave its traces for the next; the
          // round after this one finds its work not done, and gives the file
          // workers of its own.
          emit({ type: 'unhanded', file, error: String(error) })
          return process.kill(process.pid, 'SIGKILL')
        }
        if (pid === 0) {
          succeeding = copies > 1
          break
        }
        const ended = cloner!.host(pid, HOST_STUCK_MS)
        // A copy that a mutant left unfit for the tests that follow, or
        // that holds too much, ends itself with what it had taken handed
        // back. This process is still what a worker is before its first
        // file, so the next copy goes on with the file here and now, where
        // a worker Vitest started has to leave the rest to the next round:
        // one file of vue took eighteen rounds that way. Not without end,
        // for a copy that ends so having got nowhere.
        if (ended === RECYCLED && copies < MAX_COPIES) continue
        if (ended !== 0 && ended !== RECYCLED) {
          // A copy can end over what a worker started for the file would not
          // meet, a thread it does not have for one. One that a mutant
          // took down says which.
          if (!(triedBy(pid) >= 0)) emit({ type: 'unhanded', file })
          // However it ended, it may have done so in the middle of a message
          // to the main process, and no message of this process after that
          // would be read as one. The channel goes with this process, and the
          // round after this one finds the file's work not done.
          return process.kill(process.pid, 'SIGKILL')
        }
        this.away = true
        this.keepToItself()
        return true
      }
      hosted = true
      copiedFrom = self
      Object.defineProperty(process, 'pid', { value: cloner!.pid(), writable: true, enumerable: true, configurable: true })
      process.exit = exitGuard
      workerResources = activeResources()
      this.keepToItself()
      return false
    }

    async importFile(filepath: string, source: unknown): Promise<unknown> {
      if (this.away || this.idle) return
      return super.importFile(filepath, source)
    }

    async onBeforeCollect(paths: (string | { filepath: string })[]): Promise<unknown> {
      this.fileStart = realNow()
      loadRound()
      const file = typeof paths[0] === 'string' ? paths[0] : paths[0]?.filepath
      if (cloner && !hosted && !cloned && !watching && plan?.handed.includes(file) && (await this.handOver(file))) return super.onBeforeCollect?.(paths)
      loaded = false
      this.idle = false
      this.measuring = false
      this.wholeFile = file
      const jobs = plan?.whole[file] ?? []
      // Before anything of the file runs here, loading it included.
      if (plan?.quiet) await alone(plan.together?.includes(file) ? file : '')
      else if (plan?.exclusive.includes(file)) await alone(file)
      const plain = jobs.find((job) => job.plain && this.open(job) && claim(`whole.${job.id}`))
      let settled: boolean | undefined
      if (plain) {
        if (plain.pair) this.pairMet = await meetOther(plain, jobs)
        this.begin(plain, true)
      } else if (cloner && !watching && jobs.length > 0 && (settled = await calm(workerResources, ['Timeout', 'Immediate']))) {
          // Nothing of the project has run in this process yet, so a copy of
        // it is what a new worker would be at this point.
        for (const job of jobs) {
          if (job.plain || !job.early || job.loading || !this.open(job) || !claim(`whole.${job.id}`)) continue
          if (await this.clone(job, true)) {
            this.begin(job, true)
            return super.onBeforeCollect?.(paths)
          }
        }
        // The other jobs are for mutants whose code does not run while the
        // file loads, or does once their module begins its own code. A copy
        // made once it has loaded, or as that module begins, is for them what
        // a run that had the mutant on all along would be at that point. Until
        // then no mutant is on and no probe runs.
        this.template = jobs.some((job) => !job.plain && (!job.early || job.loading) && this.open(job))
        if (this.template) {
          this.waiting = jobs.filter((job) => !job.plain && job.loading && this.open(job))
          this.unpaused = false
          // A copy made while loading is made on the spot, and the count of
          // calls under way that says it may be has to be whole by then.
          if (this.waiting.length > 0) await this.standStill()
          runtime.a = NO_MUTANT
          // Node opens its end of the standard streams when they are first
          // used. A file that logs while it loads would look as if it had
          // opened a pipe; these exist in every copy either way.
          void process.stdout
          void process.stderr
          this.heldBeforeLoad = activeResources()
          this.openBeforeLoad = openDescriptors()
          this.keepToItself()
          loadTimers.length = 0
          timerHook.enable()
          if (this.waiting.length > 0) runtime.m = (first, end) => this.copyWhileLoading(first, end)
          return super.onBeforeCollect?.(paths)
        }
      } else {
        const job = jobs.find((job) => !job.control && this.open(job) && claim(`whole.${job.id}`))
        if (job) this.begin(job, true)
      }
      this.idle = !this.whole && file !== undefined && plan?.wholeOnly.includes(file) === true
      // A round in which the file's workers made none of its runs ends with
      // nothing learnt, and three such end the run: what kept each from them
      // is otherwise written nowhere.
      if (this.idle && jobs.length > 0) {
        emit({
          type: 'idle',
          file,
          settled,
          jobs: jobs.map((job) => ({
            id: job.id,
            mutant: job.mutant,
            control: job.control === true,
            open: this.open(job),
            taken: claimed(`whole.${job.id}`),
          })),
        })
      }
      watch()
      workerResources = activeResources()
      return super.onBeforeCollect?.(paths)
    }

    /** Whether this worker gives the tests of the file their unmutated run, see `RoundPlan.probe`. */
    private probes(file: string): boolean {
      return plan !== undefined && file in plan.probe && (!plan.measure.includes(file) || this.measuring)
    }

    private untakenHere(testId: string): boolean {
      if (this.full.has(testId)) return false
      if (untaken(testId)) return true
      this.full.add(testId)
      return false
    }

    private open(job: WholeJob): boolean {
      if (job.control || job.trial !== undefined) return true
      const state = readState(job.mutant)
      // A run asked for by name is made whatever a test has since written of the mutant.
      if (job.confirm === true || job.quiet === true) return true
      return (state === MUTANT_PENDING || state === MUTANT_STALLED) && !fs.existsSync(failedMark(job.mutant))
    }

    /**
     * Copies this process for one whole-file run and, in the process that
     * was copied, waits for the copy to end. Returns whether this is the copy.
     */
    private async clone(job: WholeJob, beforeLoad: boolean): Promise<boolean> {
      await this.standStill()
      return this.copy(job, beforeLoad ? 'copied before load' : 'copied after load')
    }

    /**
     * Ends this copy, which runs a test file, for another to take its place.
     * A worker Vitest started ends on the spot, and its channel with it. This
     * one's channel is the one the process it was copied from goes on using:
     * ended with half a message sent, what a test printed for one, it left
     * the main process waiting for the other half and the file never over,
     * which is how runs of jotai on a macOS runner came to no end.
     */
    private async giveWay(): Promise<never> {
      return cloner!.exit((await inTime(this.standStill())) ? RECYCLED : 1)
    }

    /** Leaves nothing under way between this process and the main one, so that a copy can be made. */
    private async standStill(): Promise<void> {
      // An answer still on its way to this process would go to the copy.
      await quiet()
      // Calls made before the count began are not in it. Answers mostly come
      // in the order of the calls, so one more call and its answer leave
      // few of those outstanding, and counting again leaves none of its own.
      await (this.workerState as { rpc?: { getCountOfFailedTests?: () => Promise<number> } }).rpc?.getCountOfFailedTests?.()
      // Getting back here from a wait gives what was queued meanwhile its
      // turn first, and Vitest sends what a test printed from just such a
      // queue. So the last look is made here, with nothing between it and
      // the copy.
      do await quiet()
      while (calls > 0 || unanswered.size > 0)
    }

    /**
     * Vitest has the runner tell the main process what it collects and how
     * each task goes. The run of a copy, or of a process that loads a file
     * only to be copied, is nobody's business but this tool's, and a file's
     * thousands of tests are a long message to have under way.
     */
    private keepToItself(): void {
      const self = this as unknown as Record<string, unknown>
      const inherited = Object.getPrototypeOf(this) as Record<string, ((...args: unknown[]) => unknown) | undefined>
      for (const name of ['onTaskUpdate', 'onCollectStart', 'onCollected']) {
        if (Object.hasOwn(self, name)) self[name] = (...args: unknown[]) => inherited[name]?.apply(this, args)
      }
    }

    /**
     * The copying itself, which nothing may interrupt: see `standStill`. In the
     * process that was copied this waits for the copy to end. Returns whether
     * this is the copy.
     */
    private copy(job: WholeJob, by: CopiedBy): boolean {
      forkLock ??= fs.openSync(paths.config, 'r')
      const self = process.pid
      let pid: number
      try {
        pid = cloner!.fork(forkLock)
      } catch {
        // No copy could be made; a worker started for the job makes the run.
        emit({ type: 'plain', file: this.wholeFile, mutant: job.mutant })
        return false
      }
      if (pid === 0) {
        cloned = true
        this.wholeBy = by
        copiedFrom = self
        // Node read the process id when it started, which was in the process
        // this is a copy of; a signal the tests send themselves must not go there.
        Object.defineProperty(process, 'pid', { value: cloner!.pid(), writable: true, enumerable: true, configurable: true })
        this.keepToItself()
        return true
      }
      // This process waits without touching the channel to the main
      // process, which the copy uses in its place. A copy that keeps to its
      // heartbeat and never ends stops itself by the clock, see `heartbeat`.
      const copiedAt = preciseNow()
      const ended = cloner!.supervise(pid, STUCK_MS, job.control || job.calm ? 0 : residentLimitOf(job))
      if (job.trial !== undefined) {
        if (ended !== cloner!.Ended.Done) untold(job, this.wholeFile!)
      } else if (job.calm) {
        // A copy that did not get to its end has shown nothing of the file either way.
      } else if (job.control) {
        // A copy that says nothing of the file unmutated says nothing of it with a mutant either.
        if (ended !== cloner!.Ended.Done) emit({ type: 'control', file: this.wholeFile, verdict: 'failed', by })
      } else if (ended === cloner!.Ended.Blocked) {
        const state = readState(job.mutant)
        if (state === MUTANT_PENDING || state === MUTANT_STALLED) writeState(job.mutant, MUTANT_TIMEOUT)
        const test = stoppedIn()
        emit({
          type: 'whole',
          file: this.wholeFile,
          mutant: job.mutant,
          verdict: 'timeout',
          ...(test ? { test, tests: [test] } : {}),
          knew: (job.witnesses?.length ?? 0) > 0,
          alone: job.exclusive || job.quiet,
          quiet: job.quiet,
          by,
          ms: preciseNow() - copiedAt,
        })
      } else if (ended === cloner!.Ended.Lost) {
        // The copy ended without a verdict, by this process's hand or its
        // own. Whatever it was, a worker started for the job alone decides.
        emit({ type: 'plain', file: this.wholeFile, mutant: job.mutant })
      }
      return false
    }

    /**
     * Starts the time a run of a whole file has by the clock over, at each
     * point where the run is seen to move on. A limit on the run as a whole
     * is not one the suite has: thirty tests that each wait a second under a
     * limit of five pass, and would be over it. What is left between two such
     * points is what Vitest gives no limit, loading the file or a fixture's
     * teardown, or hooks, every `beforeEach` of a test for one, each under a
     * limit of its own but not seen apart here. The body of a test that has a limit
     * is timed only while it keeps the event loop from turning, see
     * `heartbeat`: otherwise Vitest ends it.
     */
    private clockOn(): void {
      if (this.whole) wallDeadline[0] = realNow() + this.wholeClockMs
    }

    /** Runs a test's body in a run of a whole file, where the clock counts only while Vitest's limit cannot end it. */
    private async runWholeBody(test: TaskLike, fn: () => unknown): Promise<void> {
      const limited = deadline((test as { timeout?: number }).timeout ?? this.config.testTimeout) > 0
      if (limited && this.wholeBodies++ === 0) bodyClockMs = this.wholeClockMs
      try {
        await fn()
      } finally {
        if (limited && --this.wholeBodies === 0) bodyClockMs = 0
        this.clockOn()
      }
    }

    /** The limits on a stretch of a run of a whole file, for what is running now. */
    private limitWhole(): void {
      const floor = this.floorMs && this.floorMs + LOOP_FIRST_MS
      limitStretch(Math.max(this.wholeBase, floor), floor)
    }

    /**
     * Runs the file's tests on with no mutant on, to copy this process
     * before the first test that reached each job's mutant: a process with
     * the mutant on would have gone through the same steps up to there,
     * the mutant's code not having run, and the copy saves the tests before.
     */
    private walk(jobs: WholeJob[]): void {
      // What ran while the file loaded is noted now. What the tests reach
      // from here on is not code that runs while it loads, and noted as such
      // it sent immich's runs of those mutants to copies made before loading.
      drainStaticHits()
      this.walked = true
      walking = true
      // The walk runs the tests as they are, with no mutant on and no limit of this tool's.
      runtime.l = Infinity
      this.template = false
      this.walking = new Map()
      for (const job of jobs) this.walking.set(job.before!, [...(this.walking.get(job.before!) ?? []), job])
      this.walkIgnore = jobs[0].ignore
      this.walkWrites = writes
      workerResources = this.heldBeforeLoad
      // What the tests before set off is put off in the copies, as a timer set while the file loaded is.
      timerHook.enable()
      for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
        for (const listener of process.listeners(event) as ((...args: unknown[]) => void)[]) {
          process.off(event, listener)
          process.on(event, (...args: unknown[]) => {
            this.walkFailed = true
            listener(...args)
          })
        }
      }
    }

    /**
     * Copies this process for the jobs to be made before the test, without
     * a pause: an `await` here lets a chain of promises an earlier test left
     * behind run ahead of the test, where the suite has it run later. Not
     * where an earlier test failed or changed the file system, or anything
     * is open or under way that was not before loading. Returns whether
     * this is a copy.
     */
    private copyBefore(jobs: WholeJob[]): boolean {
      const open = openDescriptors()
      const why = this.walkFailed
        ? 'failed'
        : writes !== this.walkWrites
          ? 'wrote'
          : calls > 0 || unanswered.size > 0
            ? 'calls'
            : open === undefined || this.openBeforeLoad === undefined || [...open].some((fd) => !this.openBeforeLoad!.has(fd))
              ? 'descriptors'
              : // A close under way finishes in this process and never in the
                // copy, which keeps the descriptor and is told nothing: in immer
                // Vitest's reading of a file's snapshots left one under way for
                // the whole file, in every file that has snapshots.
                exceeds(new Map([...activeResources()].filter(([kind]) => kind !== 'Immediate' && kind !== 'Timeout' && kind !== 'CloseReq')), this.heldBeforeLoad)
                ? 'held'
                : undefined
      if (why) {
        // What an earlier test failed or wrote stays for the tests after it;
        // a call or a file under way, often Vitest's own reading of the
        // file's snapshots as its suite begins, is over by a later test.
        const lasting = why === 'failed' || why === 'wrote'
        const held = why === 'held' ? [...activeResources()] : undefined
        // For the whole file where it lasts: a run refused here is not made
        // this round, and with each refused in turn, the runs of actual's
        // `main.test.ts`, one process at a time, went three rounds without
        // a verdict and the run gave up on six files.
        if (lasting) {
          emit({ type: 'walk', file: this.wholeFile, why })
          this.walking = new Map()
        } else {
          for (const job of jobs) emit({ type: 'walk', file: this.wholeFile, mutant: job.mutant, why, held })
        }
        return false
      }
      freeze()
      for (const job of jobs) {
        if (runtime.h[job.site] === 1) {
          emit({ type: 'walk', file: this.wholeFile, mutant: job.mutant, why: 'ran' })
          continue
        }
        if (!this.open(job) || !claim(`whole.${job.id}`)) continue
        if (this.copy(job, 'copied before a test')) {
          thaw()
          // The loops of the tests before are not the run's to count.
          runtime.n = 0
          this.walking = undefined
          timerHook.disable()
          this.begin(job, false)
          return true
        }
      }
      thaw()
      return false
    }

    /**
     * Makes the copies for the jobs whose mutants are in the module now
     * beginning its own code, the one with sites `first` to `end`. Nothing is
     * awaited here: a pause would let what the modules before it queued run
     * ahead of its code, which no run of the suite does, and a copy made
     * without one goes on from the same queue. Only where nothing this
     * process holds could be shared with a copy, as after loading. A timer
     * set since is put off, in each copy and then here, by as long as the
     * copies took: otherwise it is due sooner in each copy made later, and
     * here it would go off part-way through loading, in a process that may
     * yet be copied once the file has loaded.
     */
    private copyWhileLoading(first: number, end: number): void {
      const due = this.waiting.filter((job) => job.site >= first && job.site < end)
      if (due.length === 0) return
      this.waiting = this.waiting.filter((job) => !due.includes(job))
      const open = openDescriptors()
      const held = activeResources()
      const why = runtime.h.subarray(first, end).includes(1)
        ? 'ran'
        : calls > 0 || unanswered.size > 0
          ? 'calls'
          : open === undefined || this.openBeforeLoad === undefined || [...open].some((fd) => !this.openBeforeLoad!.has(fd))
            ? 'descriptors'
            : // A callback queued with `setImmediate` is due at the next turn
              // of the loop whatever the clock says, in each copy as in the
              // run of the suite; a timer is put off, below.
              exceeds(new Map([...held].filter(([kind]) => kind !== 'Immediate' && kind !== 'Timeout')), this.heldBeforeLoad)
              ? 'held'
              : undefined
      if (why) {
        // The jobs are left for the next round, which makes them before the file loads.
        if (!this.unpaused) emit({ type: 'loading', file: this.wholeFile, why, held: why === 'held' ? [...held] : undefined })
        this.unpaused = true
        return
      }
      const stoppedAt = preciseNow()
      for (const job of due) {
        if (!this.open(job) || !claim(`whole.${job.id}`)) continue
        if (this.copy(job, 'copied while loading')) {
          stoodStill(preciseNow() - stoppedAt)
          runtime.m = undefined
          this.waiting = []
          this.template = false
          timerHook.disable()
          workerResources = this.heldBeforeLoad
          this.begin(job, true)
          return
        }
      }
      stoodStill(preciseNow() - stoppedAt)
    }

    /** Turns the job's mutant on for the rest of the file's run. */
    private begin(job: WholeJob, beforeLoad: boolean): void {
      this.whole = job
      this.wholeTests = []
      this.wholeWaits = new Set(job.witnesses)
      this.wholeOverran = 0
      this.wholeStartedAt = preciseNow()
      // A mutant that is only to be on for one test comes on at that test.
      runtime.a = job.control || job.trial !== undefined ? NO_MUTANT : job.mutant
      // A module the file has not loaded yet makes the value as it loads, with the mutant on.
      if (!beforeLoad) for (const site of job.again ?? []) for (const remake of runtime.e[site] ?? []) remake()
      this.trialOver = false
      this.trialSaid = false
      // The loops of the whole file share one count, with room for those
      // that run while it loads.
      if (beforeLoad) runtime.n = 0
      runtime.t = false
      runtime.l = job.fileLoops * config.loopFactor + config.loopSlack
      // An error nothing handles fails the run with every test passing.
      // Vitest reports one only while its own listener is the only one,
      // taking any other for the project handling such errors itself, so
      // a listener added here would silence it. Its listener is wrapped
      // instead, and counts what it would report.
      for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
        for (const listener of process.listeners(event) as ((...args: unknown[]) => void)[]) {
          process.off(event, listener)
          process.on(event, (...args: unknown[]) => {
            const reported = process.listeners(event).length === 1 && !this.config.dangerouslyIgnoreUnhandledErrors
            if (reported && this.whole) this.wholeFailure ??= 'failed'
            listener(...args)
          })
        }
      }
      heartbeat()
      beatMutant[0] = job.mutant
      beatMutant[1] = 1
      noteTest()
      // No stretch of the run can take longer than the whole file does. A
      // mutant that blocked a worker before gets the plain limit: blocking
      // twice is what a timeout is.
      const file = { baselineMs: job.fileMs }
      // Nor sooner than the suite's own limit could end what is running, a
      // hook until the first test: a mutant that kept a test busy for 4 s
      // where the project gives a test 60 s passes the suite, and was
      // reported as a timeout.
      this.wholeBase = job.stalled ? limitMs(file) : hardLimitMs(file)
      this.floorMs = deadline(this.config.hookTimeout)
      this.limitWhole()
      heartbeat()
      this.wholeClockMs = hardLimitMs(file) + Math.max(deadline(this.config.testTimeout), deadline(this.config.hookTimeout))
      this.wholeBodies = 0
      bodyClockMs = 0
      this.clockOn()
      residentLimit[0] = cloned || job.control || job.calm ? 0 : residentLimitOf(job)
      // A count of iterations says a loop is long, not that it does not
      // end: a mutant can send a loop over a few million elements that it
      // is through with in milliseconds, and the suite passes. Here, where
      // the verdict is made, a loop past its count goes on until it has
      // also kept the process busy without a pause for longer than any
      // loop of the file is likely to.
      const busyMs = Math.min(beat[1], Math.max(1000, job.fileMs * 2))
      // The next look comes some milliseconds on, not a fixed count of
      // iterations on: where each iteration made objects to keep, a
      // million of them took seconds, and valibot's loops ran 12 s to 21 s
      // past a limit of 5 s.
      let lookedAt = 0
      let lookedN = 0
      let slack = config.loopSlack
      runtime.x = (() => {
        const now = realNow()
        if (cpuMs() - beat[0] < Math.max(busyMs, this.floorMs) || now - stretch[0] < this.floorMs) {
          if (lookedAt > 0) slack = Math.max(1000, Math.min(config.loopSlack, Math.round(((runtime.n - lookedN) * LOOP_LOOK_MS) / Math.max(now - lookedAt, 0.01))))
          lookedAt = now
          lookedN = runtime.n
          runtime.l = runtime.n + slack
          return
        }
        return this.loopLimit()
      }) as () => never
    }

    async onCollected(files: TaskLike[]): Promise<unknown> {
      if (this.away) return super.onCollected?.(files)
      if (this.template) {
        runtime.m = undefined
        // Jobs whose modules did not begin while the file loaded.
        const unbegun = this.waiting.filter((job) => this.open(job))
        this.waiting = []
        const told = new Set<number>()
        // Before anything is awaited: what the loop runs meanwhile is what
        // copies made from here start from.
        freeze()
        // A file, a socket, a child process or a watcher the file left open
        // while loading would be shared by every copy made from here; such a
        // file's runs are all made from copies taken before it loads. So is a
        // timer set since the timers were put off, which is not.
        const open = openDescriptors()
        const opened = !open || !this.openBeforeLoad || [...open].some((fd) => !this.openBeforeLoad!.has(fd))
        const settled = !opened && (await calm(this.heldBeforeLoad, ['Timeout']))
        timerHook.disable()
        const putOff = new Set(frozen.map(([timer]) => timer))
        const shares = !settled || loadTimers.some((timer) => !timer._destroyed && !putOff.has(timer))
        if (shares) emit({ type: 'early', file: this.wholeFile, site: -1, held: [...activeResources()] })
        // Nor can they be made from here then, and their next round makes them before the file loads.
        if (shares && unbegun.length > 0 && !this.unpaused) emit({ type: 'loading', file: this.wholeFile, why: 'unbegun' })
        // No copy is made of a process that holds something open: a test that was to have its one run in one has had its turn.
        for (const job of shares ? (plan?.whole[this.wholeFile!] ?? []) : []) {
          if (job.trial !== undefined && claim(`whole.${job.id}`)) untold(job, this.wholeFile!)
        }
        let copied = false
        // Tests that run at once leave no point between two of them where
        // the earlier ones are through and the later not begun.
        let concurrent = false
        forEachTask(files, (task) => {
          if ((task as { concurrent?: boolean }).concurrent) concurrent = true
        })
        if (concurrent && (plan?.whole[this.wholeFile!] ?? []).some((job) => job.before !== undefined)) emit({ type: 'walk', file: this.wholeFile, why: 'concurrent' })
        for (const job of shares ? [] : (plan?.whole[this.wholeFile!] ?? [])) {
          if (job.plain || (job.early && !job.loading) || !this.open(job)) continue
          // The mutant's code did run while this process loaded the file, so
          // a copy from here would have had it off for that: the job is left
          // for a copy made before loading.
          // A binding that is to be made again was read while this process
          // loaded the file, after all: what read it had the value made with
          // the mutant off.
          const read = job.again ? job.again.find((site) => runtime.h[site] === 1) : job.trial === undefined && runtime.h[job.site] === 1 ? job.site : undefined
          if (read !== undefined) {
            if (!told.has(read)) emit({ type: 'early', file: this.wholeFile, site: read })
            told.add(read)
            continue
          }
          if (job.before !== undefined && !concurrent) continue
          if (!claim(`whole.${job.id}`)) continue
          if (await this.clone(job, false)) {
            thaw()
            this.begin(job, false)
            return super.onCollected?.(files)
          }
          copied = true
        }
        thaw()
        runtime.a = -1
        const ahead =
          shares || concurrent
            ? []
            : (plan?.whole[this.wholeFile!] ?? []).filter(
                (job) => job.before !== undefined && !job.plain && !told.has(job.site) && runtime.h[job.site] !== 1 && this.open(job) && !claimed(`whole.${job.id}`),
              )
        if (ahead.length > 0) {
          this.walk(ahead)
          return super.onCollected?.(files)
        }
        // Every worker a file is given takes it as a template while a run
        // asked for by name is open, whoever has claimed it. One left with
        // no job is, with no mutant on so far, a worker the file's tries
        // can have: ending the file here left them to a round of their own,
        // 76 s of rea's `ExecFileOutput.ts`.
        if (!copied && plan && !plan.wholeOnly.includes(this.wholeFile!)) {
          this.template = false
          watch()
          workerResources = this.heldBeforeLoad
        } else {
          forEachTask(files, (task) => {
            if (task.mode === 'run' || task.mode === 'queued') task.mode = 'skip'
          })
          return super.onCollected?.(files)
        }
      }
      if (this.whole) return super.onCollected?.(files)
      const file = this.wholeFile!
      if (plan?.measure.includes(file)) {
        this.measuring = claim(`measure.${plan.measure.indexOf(file)}`)
        // The workers that try run the file as they would in any other round.
        if (!this.measuring && !plan.replay.includes(file)) replayFiles.delete(file)
      }
      drainStaticHits()
      loaded = true
      // One global holds the active mutant, so tests cannot interleave.
      forEachTask(files, (task) => {
        task.concurrent = false
      })
      for (const file of files) {
        if (plan && !replayFiles.has(file.file.filepath)) {
          // Tests no worker drives this round are skipped before any hook
          // runs, and with them every suite left without a test to run.
          skipUnplanned(file)
        } else if (plan && !this.probes(file.file.filepath)) {
          // A replayed file runs as in a normal run up to the last test
          // anyone drives; nothing after it is needed.
          let last: TaskLike | undefined
          this.ahead = []
          this.through = false
          this.full.clear()
          forEachTask([file], (task) => {
            if (task.type === 'test' && plan!.tests[task.id]) {
              last = task
              this.ahead.push(task.id)
            }
          })
          let reached = last === undefined
          forEachTask([file], (task) => {
            if (task.type !== 'test') return
            if (reached) task.mode = 'skip'
            if (task === last) reached = true
          })
        }
      }
      return super.onCollected?.(files)
    }

    async onBeforeRunSuite(suite: TaskLike): Promise<void> {
      this.finishActive()
      this.clockOn()
      await super.onBeforeRunSuite?.(suite)
    }

    async onAfterRunSuite(suite: TaskLike): Promise<void> {
      this.clockOn()
      await super.onAfterRunSuite?.(suite)
    }

    async onBeforeRunTask(test: TaskLike): Promise<void> {
      await super.onBeforeRunTask?.(test)
      if (this.walking) {
        const jobs = this.walking.get(test.id)
        this.walking.delete(test.id)
        if (!(jobs && this.copyBefore(jobs))) {
          // Nothing is left to copy for once the last such test is reached.
          if (this.walking.size === 0 || this.walkIgnore.includes(test.id)) test.mode = 'skip'
          return
        }
      }
      if (this.whole) {
        noteTest(test.id)
        this.floorMs = deadline((test as { timeout?: number }).timeout ?? this.config.testTimeout)
        this.limitWhole()
        this.clockOn()
        heartbeat()
        // The first failure settles it.
        const over = this.whole.trial !== undefined ? this.trialOver : this.wholeSettled()
        if (over || this.whole.ignore.includes(test.id)) test.mode = 'skip'
        return
      }
      if (test.mode !== 'run' && test.mode !== 'queued') return
      this.seen.push(test.id)
      if (plan?.ignore.includes(test.id) && plan.pristine.includes(test.file.filepath) && plan.probe[test.file.filepath]?.length === 0 && this.probes(test.file.filepath)) {
        test.mode = 'skip'
        this.ignored++
        return
      }
      const run = this.through ? undefined : this.admit(test)
      if (!run) {
        if (!replays(test.file.filepath)) test.mode = 'skip'
        // A replayed file runs its tests unmutated only to bring the ones
        // after them to where they would be. Once every test after this one
        // is taken by other workers, that is for nothing: in rea five workers
        // of `ExecFileOutput.test.ts` ran on for 32 s each at the end of a
        // round. A chunk a recycled worker hands back after this is left to
        // the next round.
        else if (plan && !this.probes(test.file.filepath) && (this.through || !this.ahead.slice(this.ahead.indexOf(test.id) + 1).some((id) => this.untakenHere(id)))) {
          this.through = true
          test.mode = 'skip'
        }
        return
      }
      this.admitted.set(test.id, run)
      // Vitest reads `repeats` once, before the first run, when the number of
      // mutants to try is still unknown; the loop is ended from
      // `onBeforeTryTask` instead.
      test.repeats = NEVER_ENDING
      test.retry = 0
    }

    /** Decides whether this worker drives the test, and how. */
    private admit(test: TaskLike): TestRun | undefined {
      // A test that is expected to fail, that only passes on a later try
      // or that is asked to run several times cannot be run again and again
      // with one mutant each: what it does on its first run is not what it
      // does on the others. It runs as the project has it, and what it
      // reaches is settled by runs of the whole file.
      if (test.fails || retries(test) > 0 || (test.repeats ?? 0) > 0) {
        this.apart.add(test.id)
        if (!plan) emit({ type: 'test', file: test.file.filepath, id: test.id, name: test.name, mode: 'probe', ...noMutants })
        return undefined
      }
      if (!plan) return newRun('probe')
      if (this.probes(test.file.filepath) && !probed.has(test.id) && claim(test.id)) {
        return newRun('probe')
      }
      if (this.measuring) return undefined
      const planned = plan.tests[test.id]
      if (!planned) return undefined
      if (!planned.mutants) return claim(test.id) ? newRun('probe') : undefined
      const index = claimChunk(test.id, planned, 0)
      if (index === -1) return undefined
      const run = newRun('planned')
      run.planned = planned
      run.queue = planned.mutants
      run.baselineMs = planned.baselineMs
      run.baselineLoops = planned.baselineLoops
      this.enterChunk(run, index)
      return run
    }

    private enterChunk(run: TestRun, index: number): void {
      run.chunkIndex = index
      run.next = index * run.planned!.chunk
      run.sliceEnd = Math.min(run.queue.length, run.next + run.planned!.chunk)
    }

    // Vitest 3.0 has no hook that fires after `afterEach`, so the start of the
    // next attempt is the one place, across versions, where the previous
    // attempt is known to be over and its result settled.
    onBeforeTryTask(test: TaskLike, options: TryOptions): unknown {
      // Nothing of the trying of mutants: it clears what the tests reached, which the walk adds up.
      if (this.walking) return super.onBeforeTryTask?.(test, options)
      if (this.whole) {
        this.clockOn()
        if (this.whole.trial === test.id && this.whole.mutant >= 0) {
          runtime.n = 0
          runtime.t = false
          runtime.a = this.whole.mutant
        }
        return super.onBeforeTryTask?.(test, options)
      }
      if (this.active?.test !== test) this.finishActive()
      if (test.repeats !== NEVER_ENDING) {
        drainStaticHits()
        this.passive = true
        this.passiveApart = this.apart.has(test.id)
        return super.onBeforeTryTask?.(test, options)
      }

      let run: TestRun
      if (options.repeats === 0) {
        run = this.admitted.get(test.id)!
        this.admitted.delete(test.id)
        this.active = { test, run }
        drainStaticHits()
        if (run.mode === 'probe') {
          runtime.n = 0
          runtime.l = Infinity
          run.attempts = 1
          run.startedAt = preciseNow()
          return super.onBeforeTryTask?.(test, options)
        }
      } else {
        run = this.active!.run
        this.settle(test, run)
      }

      if (run.attempt === 'mutant') {
        const next = this.nextMutant(run)
        run.mutant = next
        const exhausted = next === -1
        const recycle =
          this.tainted || (!exhausted && run.attempts > 0 && run.attempts % 8 === 0 && memoryExceeded())
        if (exhausted || recycle) {
          run.stop = this.tainted ? 'tainted' : recycle ? 'memory' : 'done'
          if (recycle && !exhausted && run.mode === 'planned') {
            // Hands the rest of the chunk back, so another worker still
            // running this file can pick it up this round. It redoes the
            // mutants already judged here, which the report merges.
            run.next = run.sliceEnd
            fs.rmSync(path.join(paths.claims, `${test.id}.${run.chunkIndex}`), { force: true })
          }
          this.finishActive()
          // Re-running tests thousands of times in one process accumulates
          // whatever each run leaks. The main process plans what is left for
          // a fresh worker.
          if (recycle) {
            if (hosted && !cloned) return this.giveWay()
            process.kill(process.pid, 'SIGKILL')
          }
          test.context.skip()
        }
      }
      run.attempts++

      // Vitest 3 neither resets a failed state between repeats nor drops the
      // errors each killed mutant leaves behind, and clears mocks once per
      // test rather than once per attempt.
      test.result!.state = 'run'
      test.result!.errors = undefined
      if (vitest.major < 5) this.clearMocks()
      const result = super.onBeforeTryTask?.(test, options)
      run.settled = false
      runtime.n = 0
      runtime.t = false
      if (run.attempt === 'baseline') {
        run.startedAt = preciseNow()
        run.reached = undefined
        runtime.a = NO_MUTANT
      }
      // The run without the mutant that follows a failure with it can meet
      // what the mutant left behind: a graph of dependencies that was built
      // wrong and now takes a billion steps to walk. With no mutant on
      // nothing would end that, and a worker that is silent for a minute
      // is given up on by Vitest without being stopped.
      if (run.attempt === 'control') {
        heartbeat()
        beatMutant[0] = run.mutant
        beatMutant[1] = 0
        limitStretch(limitMs(run))
        runtime.l = run.baselineLoops * config.loopFactor + config.loopSlack
      }
      if (run.attempt === 'mutant') {
        heartbeat()
        beatMutant[0] = run.mutant
        beatMutant[1] = run.mode === 'planned' && run.attempts === 1 && !replays(test.file.filepath) ? 2 : 0
        noteTest(test.id)
        // CPU time does not stretch on a busy machine the way wall time does,
        // so one stretch without yielding ends at the plain limit. That only
        // hands the mutant to a whole-file run, which gives it the most a run
        // may take before it calls it a timeout.
        limitStretch(limitMs(run))
        runtime.l = run.baselineLoops * config.loopFactor + config.loopSlack
        runtime.r = 0
        trying(run.mutant)
        runtime.a = run.mutant
        this.attempted = true
      }
      return result
    }

    /** The next pending mutant this worker may try for the test, or -1. */
    private nextMutant(run: TestRun): number {
      if (run.nonRepeatable || run.needsReplay || run.baselineRetry) return -1
      // Checked per mutant: one test with many slow mutants would otherwise
      // keep its worker for as long as they take.
      if (!plan && this.trialMs + preciseNow() - run.startedAt - run.baselineMs > TRIAL_BUDGET_MS) return -1
      for (;;) {
        while (run.next < run.sliceEnd) {
          const candidate = run.queue[run.next++]
          if (readState(candidate) === MUTANT_PENDING && !fs.existsSync(taintedMark(this.active!.test.id, candidate))) return candidate
        }
        if (run.mode !== 'planned') return -1
        const index = claimChunk(this.active!.test.id, run.planned!, run.chunkIndex + 1)
        if (index === -1) return -1
        this.enterChunk(run, index)
      }
    }

    async runTask(test: TaskLike): Promise<void> {
      const fn = vitest.getFn(test)
      if (!fn) throw new Error('Test function is not found')
      if (this.whole) return this.runWholeBody(test, fn)
      const run = this.active?.test === test ? this.active.run : undefined
      if (!run || run.attempt === 'baseline') {
        await fn()
        return
      }
      // The run without the mutant that follows a failure with it is held
      // to the same limits as the run with it: it meets what the mutant
      // left behind, which can be a promise nothing will settle, and the
      // test's own time limit, half a minute in some projects, is a long
      // time to find that out.
      // A mutant can leave the test awaiting something that never happens.
      // The abandoned promise stays pending; the control run that follows
      // shows whether it did any harm. A test that is still computing when
      // the time is up is only slow, typically because the machine is busy,
      // so it gets more time, up to a hard limit.
      let timer: ReturnType<typeof setTimeout> | undefined
      let poll: ReturnType<typeof setInterval> | undefined
      const softMs = limitMs(run)
      const deadline = preciseNow() + hardLimitMs(run)
      const limit = new Promise<never>((_, reject) => {
        let lastCpu = cpuMs()
        const check = () => {
          const cpu = cpuMs()
          const busy = cpu - lastCpu > 0.05 * WINDOW_MS
          lastCpu = cpu
          if (busy && preciseNow() < deadline) {
            timer = realSetTimeout(check, WINDOW_MS)
            return
          }
          runtime.t = true
          run.timeoutCause = 'timer'
          reject(new Error('[vitant] mutant run timed out'))
        }
        timer = realSetTimeout(() => {
          lastCpu = cpuMs()
          timer = realSetTimeout(check, WINDOW_MS)
        }, Math.max(0, softMs - WINDOW_MS))
      })
      // A test waiting on a promise while nothing is left that could settle
      // it, no timer, no I/O, no CPU in use, is not going to finish: with
      // fake timers on, a mutant easily leaves one waiting for a tick nobody
      // gives. That is seen in half a second rather than at the limit. It
      // only holds while nothing is open beyond what the worker itself
      // keeps: a child process or a socket from an earlier test can answer
      // without anything new appearing.
      // The timer of the limit above is this runner's own. Any other one
      // may be what the test waits for: a route that sleeps for a second
      // looks just like this otherwise.
      const before = new Map(workerResources)
      before.set('Timeout', (before.get('Timeout') ?? 0) + 1)
      let idleFor = 0
      let idleCpu = cpuMs()
      const idle = new Promise<never>((_, reject) => {
        poll = realSetInterval(() => {
          const cpu = cpuMs()
          const quiet = cpu - idleCpu < 0.05 * IDLE_POLL_MS && !exceeds(activeResources(), before)
          idleCpu = cpu
          idleFor = quiet ? idleFor + IDLE_POLL_MS : 0
          if (idleFor < IDLE_MS) return
          runtime.t = true
          run.timeoutCause = 'idle'
          reject(new Error('[vitant] mutant run timed out'))
        }, IDLE_POLL_MS)
        poll.unref()
      })
      try {
        await Promise.race([fn(), limit, idle])
      } catch (error) {
        throw plainError(error)
      } finally {
        realClearTimeout(timer)
        realClearInterval(poll)
      }
    }

    // Cleanup hooks run unmutated so a mutant cannot keep them from restoring
    // shared state.
    onTaskFinished(test: TaskLike): unknown {
      if (this.whole || this.walking) return super.onTaskFinished?.(test)
      runtime.a = -1
      limitStretch(0)
      // What only the cleanup hooks reach is not something a mutant run of
      // the test could reach either.
      const run = this.active?.test === test ? this.active.run : undefined
      if (run?.attempt === 'baseline' && !run.settled) run.reached = drainCoverage()
      return super.onTaskFinished?.(test)
    }

    // Vitest 5 resets the state before the next `onBeforeTryTask`, so there the
    // outcome has to be read here.
    onAfterRetryTask(test: TaskLike, options: TryOptions): unknown {
      this.clockOn()
      if (this.active?.test === test) {
        this.active.run.failed = test.result?.state === 'fail'
        this.active.run.errorsSeen = test.result?.errors?.length ?? 0
        if (this.active.run.failed) this.active.run.lastError = firstError(test)
      }
      return super.onAfterRetryTask?.(test, options)
    }

    async onAfterRunTask(test: TaskLike): Promise<void> {
      await super.onAfterRunTask?.(test)
      if (this.walking) {
        if (test.result?.state === 'fail') this.walkFailed = true
        return
      }
      if (!this.whole) {
        const driven = this.active?.test === test
        this.finishActive()
        // What the hooks after the last attempt reached is no more static
        // than what those after the first did.
        if (driven) {
          runtime.h.fill(0)
          runtime.i.fill(0)
          runtime.b.fill(0)
        }
      }
      if (!this.whole) return
      noteTest()
      this.floorMs = deadline(this.config.hookTimeout)
      this.limitWhole()
      this.clockOn()
      heartbeat()
      if (this.whole.trial !== undefined) {
        // A loop this runner ended is a failure whatever the test made of the
        // error, as in a test trying a mutant, and not Vitest's limit.
        const failed = test.result?.state === 'fail' || runtime.t
        if (test.id === this.whole.trial) {
          runtime.a = NO_MUTANT
          const mutant = this.whole.mutant
          if (mutant < 0) emit({ type: 'apart', file: test.file.filepath, test: test.id, verdict: failed ? 'failed' : 'passed' })
          else {
            emit({
              type: 'test',
              file: test.file.filepath,
              id: test.id,
              name: test.name,
              mode: 'planned',
              ...noMutants,
              attempts: 1,
              copied: true,
              sole: !plan || plan.sole.includes(test.file.filepath) || plan.exclusive.includes(test.file.filepath),
              overran: failed && !runtime.t && /^Test timed out in \d+ms/.test(firstError(test) ?? ''),
              killed: failed ? [mutant] : [],
              survived: failed ? [] : [mutant],
            })
          }
          this.trialOver = true
          this.trialSaid = true
        } else if (failed) {
          // A test before it failed with no mutant on: this copy is not the run the test has in the file.
          this.trialOver = true
        }
        if (this.trialOver && cloned) await this.leave()
        return
      }
      this.wholeWaits.delete(test.id)
      // A plain run never gets past a loop this runner ended, though the
      // test caught the error and passed.
      if (test.result?.state === 'fail' || (runtime.t && this.wholeFailure === undefined)) {
        if (!this.wholeFailure) this.wholeTest = test.id
        this.wholeTests.push(test.id)
        const overran = /^Test timed out in \d+ms/.test(firstError(test) ?? '')
        this.wholeFailure ??= runtime.t || overran ? 'timeout' : 'failed'
        if (overran) this.wholeOverran++
        // A plain run goes on past a test that ran out of Vitest's time, and
        // without the witness after it that failure waits for a run made with
        // nothing else running, one at a time: in jotai fifty mutants that
        // way, five seconds each. A plain run never gets past a loop this
        // runner ended, and once a second test has waited out its time the
        // tests that follow may each do the same.
        if (runtime.t || this.wholeOverran >= 2) this.wholeWaits.clear()
      }
      // Nobody waits for the rest of a copy's run.
      if (cloned && this.wholeSettled()) await this.leave()
    }

    /**
     * Whether the run has said what it can. A failure in a test that had
     * failed with the mutant while trying it settles the mutant, and so the
     * run ends there. A failure in any other test settles nothing by itself,
     * so the run does not end at it while such a test is still to come: it
     * goes on as a plain run would, which does not stop at a failure either,
     * and that test failing too is worth more than the same failure once
     * more. A loop this runner ended, or a second test that ran out of its
     * time, ends the run.
     */
    private wholeSettled(): boolean {
      if (!this.wholeFailure) return false
      // A run made with nothing else running counts by itself, whichever test fails in it.
      if (this.wholeWaits.size === 0 || this.whole!.quiet) return true
      return this.wholeTests.some((id) => this.whole!.witnesses?.includes(id))
    }

    /**
     * Ends a copy: no answer is half read, which would leave the other half
     * to the next copy, and its verdict is written.
     */
    private async leave(): Promise<never> {
      // An error nothing handled may be on its way with an answer; the
      // verdict is read once nothing is.
      await quiet()
      if (this.whole!.trial !== undefined) {
        if (!this.trialSaid) untold(this.whole!, this.wholeFile!)
        cloner!.done()
        return cloner!.exit(0)
      }
      if (this.whole!.calm) {
        emit({ type: 'calm', file: this.wholeFile, verdict: this.wholeFailure ? 'failed' : 'passed', tests: this.wholeTests })
        cloner!.done()
        return cloner!.exit(0)
      }
      if (this.whole!.control) {
        emit({ type: 'control', file: this.wholeFile, verdict: this.wholeFailure ? 'failed' : 'passed', test: this.wholeTest, by: this.wholeBy })
        cloner!.done()
        return cloner!.exit(0)
      }
      if (this.wholeFailure) markFailed(this.whole!.mutant)
      emit({
        type: 'whole',
        file: this.wholeFile,
        mutant: this.whole!.mutant,
        verdict: this.wholeFailure ?? 'passed',
        test: this.wholeTest,
        tests: this.wholeTests,
        knew: (this.whole!.witnesses?.length ?? 0) > 0,
        alone: this.whole!.exclusive || this.whole!.quiet,
        quiet: this.whole!.quiet,
        by: this.wholeBy,
        ms: preciseNow() - this.wholeStartedAt,
      })
      cloner!.done()
      return cloner!.exit(0)
    }

    /**
     * Vitest 3.2 runs the teardown of a fixture scoped to the worker after
     * the file, and fails the run where it throws: a mutant the teardown's
     * assertion sees fails the suite with every test passing. A copy ends
     * before that, and a worker started for the run has said its verdict, so
     * a run of a whole file runs them itself, once. From Vitest 4 such a
     * teardown failing fails nothing.
     */
    onCleanupWorkerContext(listener: () => unknown): void {
      let ran: Promise<unknown> | undefined
      const once = () => (ran ??= Promise.resolve().then(listener))
      this.workerCleanups.push(once)
      super.onCleanupWorkerContext?.(once)
    }

    async onAfterRunFiles(files: TaskLike[]): Promise<unknown> {
      if (this.away) return super.onAfterRunFiles?.(files)
      try {
        return await this.afterRunFiles(files)
      } finally {
        // Vitest would go on to tell the main process the file is through,
        // which the process this was copied from does.
        // An answer that never comes must not keep the file from ending:
        // ended as one that failed, this copy takes the worker with it.
        if (hosted && !cloned) cloner!.exit((await inTime(quiet())) ? 0 : 1)
      }
    }

    private async afterRunFiles(files: TaskLike[]): Promise<unknown> {
      // The file's tests and hooks are through, which is all another run of it could meet.
      release()
      if (this.whole) {
        // With the mutant still on, as the suite has it.
        if (vitest.major === 3) {
          for (const cleanup of this.workerCleanups.splice(0)) {
            try {
              await cleanup()
            } catch {
              this.wholeFailure ??= runtime.t ? 'timeout' : 'failed'
            }
          }
        }
        runtime.a = -1
        limitStretch(0)
        wallDeadline[0] = 0
        bodyClockMs = 0
        residentLimit[0] = 0
        runtime.x = this.loopLimit
        // A hook or the file itself can fail with every test passing.
        forEachTask(files, (task) => {
          if (task.result?.state === 'fail') this.wholeFailure ??= runtime.t ? 'timeout' : 'failed'
        })
        if (cloned) return this.leave()
        for (const file of this.whole.calm ? files : []) {
          emit({ type: 'calm', file: file.file.filepath, verdict: this.wholeFailure ? 'failed' : 'passed', tests: this.wholeTests })
        }
        for (const file of this.whole.pair && !this.whole.calm ? files : []) {
          emit({ type: 'pair', file: file.file.filepath, verdict: this.wholeFailure ? 'failed' : 'passed', met: this.pairMet, test: this.wholeTest })
        }
        for (const file of this.whole.pair || this.whole.calm ? [] : files) {
          if (this.wholeFailure) markFailed(this.whole.mutant)
          emit({
            type: 'whole',
            file: file.file.filepath,
            mutant: this.whole.mutant,
            verdict: this.wholeFailure ?? 'passed',
            test: this.wholeTest,
            tests: this.wholeTests,
            knew: (this.whole.witnesses?.length ?? 0) > 0,
            alone: this.whole.exclusive || this.whole.quiet,
            quiet: this.whole.quiet,
            by: this.wholeBy,
            ms: preciseNow() - this.wholeStartedAt,
          })
        }
        this.whole = undefined
        this.wholeFailure = undefined
        this.wholeTest = undefined
        return super.onAfterRunFiles?.(files)
      }
      this.finishActive()
      if (!this.walked) drainStaticHits()
      const sites: number[] = []
      for (let site = staticHits.indexOf(1); site !== -1; site = staticHits.indexOf(1, site + 1)) {
        sites.push(site)
      }
      const mutants: number[] = []
      for (let mutant = staticMutants.indexOf(1); mutant !== -1; mutant = staticMutants.indexOf(1, mutant + 1)) {
        mutants.push(mutant)
      }
      for (const file of files) {
        // A file counts as covered once a worker went through all of it with
        // every test running, which the first round does and probing does.
        // A process that loaded the file only to be copied ran none of its tests.
        const complete = (!plan || this.probes(file.file.filepath)) && !this.dropped && !this.template
        emit({
          type: 'file',
          file: file.file.filepath,
          tests: this.seen,
          staticSites: sites,
          staticMutants: mutants,
          hookSites: marked(hookHits),
          hookMutants: marked(hookMutants),
          // Only a pass that gave every test its run: one that fills in what
          // a worker that was lost left out passes the others by, and one for
          // the tests that failed is for them alone.
          pristine: plan?.pristine.includes(file.file.filepath) && plan.probe[file.file.filepath]?.length === 0 && this.probes(file.file.filepath) && !this.template,
          ignored: this.ignored,
          complete,
          wallMs: realNow() - this.fileStart,
          // What the file loaded decides whether its results can be reused later.
          modules: complete ? loadedModules(this.workerState) : undefined,
        })
      }
      this.seen = []
      return super.onAfterRunFiles?.(files)
    }

    private clearMocks(): void {
      const { clearMocks, mockReset, restoreMocks, unstubEnvs, unstubGlobals } = this.config
      if (restoreMocks) vitest.vi.restoreAllMocks()
      if (mockReset) vitest.vi.resetAllMocks()
      if (clearMocks) vitest.vi.clearAllMocks()
      if (unstubEnvs) vitest.vi.unstubAllEnvs()
      if (unstubGlobals) vitest.vi.unstubAllGlobals()
    }

    /**
     * A test that passes with a mutant on has only shown something if the
     * mutant's code ran. The unmutated run reached it, so when a repeat does
     * not, the test took another path than in a normal run, and passing says
     * nothing. With the tests before it replayed, what differs is state left
     * by earlier repeats, a filled cache for one, and a fresh worker decides.
     */
    private passed(test: TaskLike, run: TestRun): void {
      if (runtime.r !== 0) run.survived.push(run.mutant)
      // What reaches the code may be something the skipped tests before this
      // one left behind, a listener for one. Replaying them is cheaper than a
      // fresh worker per mutant.
      else if (replays(test.file.filepath)) run.unverified.push(run.mutant)
      else run.unreached.push(run.mutant)
    }

    /** Records the outcome of the attempt that just ended and decides what the next one is. */
    private settle(test: TaskLike, run: TestRun): void {
      runtime.a = -1
      trying(-1)
      limitStretch(0)
      run.settled = true
      releaseMocks?.()
      // Vitest 5 tears down `aroundEach` hooks and their fixtures after its
      // last hook for the attempt; an error from there only shows as one more
      // entry in the list.
      const late = run.errorsSeen !== undefined && (test.result?.errors?.length ?? 0) > run.errorsSeen
      // Vitest cannot serialise every error: one that holds a revoked proxy
      // makes it throw while recording the failure. Vitest 5 then skips the
      // rest of the attempt, cleanup hooks and `onAfterRetryTask` included,
      // and what is left to see is the error that replaced the first.
      const cut = vitest.major >= 5 && run.failed === undefined && (test.result?.errors?.length ?? 0) > 0
      if (cut && run.attempt !== 'baseline') this.tainted = true
      const failed = (run.failed ?? test.result?.state === 'fail') || late || cut
      const error = run.lastError ?? firstError(test)
      run.errorsSeen = undefined
      run.failed = undefined
      run.lastError = undefined
      const replayed = replays(test.file.filepath)

      // The probes that tell which mutants could change anything cost many
      // times the code they watch where it is a tight loop, and a test that
      // takes a tenth of its time limit can run out of it. That says
      // nothing about the test: it gets another unmutated run without
      // them, after which every mutant in the code it reached counts as
      // one it could be changed by.
      if (run.attempt === 'baseline' && failed && !run.unprobed && /^Test timed out in \d+ms/.test(error ?? '')) {
        run.unprobed = true
        this.upset = true
      } else if (run.attempt === 'baseline') {
        run.baselineMs = preciseNow() - run.startedAt
        run.baselineLoops = runtime.n
        run.baselineState = failed ? 'fail' : 'pass'
        if (failed) {
          this.upset = true
          run.baselineError = error
          // Earlier mutant runs in this worker, or skipped tests, may be what
          // broke the test. A fresh worker replays the tests before it instead.
          run.baselineRetry = !(replayed && retried.has(test.id))
        } else {
          const all = (reached: { sites: number[]; mutants: number[] }) =>
            run.unprobed ? { sites: reached.sites, mutants: reached.sites.flatMap(mutantsAt) } : reached
          const coverage = all(run.reached ?? drainCoverage())
          // Taken apart only where the end of the test itself was seen.
          const later = all(run.reached ? drainCoverage() : { sites: [], mutants: [] })
          run.sites = [...new Set([...coverage.sites, ...later.sites])]
          run.covered = coverage.mutants
          const covered = new Set(coverage.mutants)
          run.cleanup = later.mutants.filter((mutant) => !covered.has(mutant))
          // In the first round heavy tests only report what they reach; the
          // main process then decides which test tries each mutant first.
          run.pristine = !this.attempted && !this.upset
          const measuring = plan?.pristine.includes(test.file.filepath) && (this.measuring || !plan.measure.includes(test.file.filepath))
          // A file that is measured has one worker, so what its tests try
          // there runs one after another while other workers may be idle;
          // past a point the rest is better left to the rounds that share it
          // out. In a later round as in the first, and all of it once a
          // mutant has left a test broken or a copy has held too much: the
          // copy that goes on runs every test before its first one again,
          // and trying on would make that one more time for every such
          // mutant. In svelte that was 50 copies one after another on a file
          // of 2,700 tests, twenty seconds each.
          if (!measuring && !succeeding && run.baselineMs < config.cheapMs) run.queue = run.covered
          run.sliceEnd = run.queue.length
        }
        run.attempt = 'mutant'
      } else if (run.attempt === 'mutant') {
        // A tripped limit counts even if the test swallowed the error.
        // Vitest fails a test that took longer than its timeout even if it
        // returned, which is how a slow but finite mutant shows up.
        const overran = /^Test timed out in \d+ms/.test(error ?? '')
        if (failed && overran && !runtime.t) {
          // The control after such a try ran out of the time again, 30 s
          // each, five times in five in a run of rea's `ExecFileOutput.ts`,
          // which says how the mutant left the worker. One that passes gives
          // a lead whose file's failing run is still made again alone
          // (`overrun`), so it leads to a run of the file as a failed one does.
          this.tainted = true
          run.unverified.push(run.mutant)
          run.suspected.push(run.mutant)
          markTainted(test.id, run.mutant)
        } else if (failed || runtime.t) {
          // A failure only proves something if the test still passes without
          // the mutant, so the verdict waits for a control run.
          run.mutantTimedOut = runtime.t
          if (!runtime.t) run.timeoutCause = undefined
          else run.timeoutCause ??= 'loop'
          run.attempt = 'control'
        } else {
          if (run.attempts > 1) run.repeated = true
          this.passed(test, run)
        }
      } else if (run.attempt === 'control') {
        // Whatever the reason, a test that no longer passes unmutated means
        // this worker's state cannot be trusted for the tests that follow:
        // a mutant that throws halfway can leave module state behind that
        // fails every one of them.
        const broken = failed || runtime.t
        if (broken) this.tainted = true
        if (failed && run.repeated) {
          // The test did pass again in this worker before, so the mutant
          // broke something rather than the test being unable to re-run.
          run.unverified.push(run.mutant)
          run.suspected.push(run.mutant)
          markTainted(test.id, run.mutant)
          run.attempt = 'mutant'
        } else if (failed && replayed) {
          run.nonRepeatable = true
          run.unverified.push(run.mutant)
          run.suspected.push(run.mutant)
          markTainted(test.id, run.mutant)
          run.attempt = 'mutant'
        } else if (failed) {
          // The mutant stays pending: in this worker the test may fail only
          // because the tests before it were skipped. Every worker of the
          // round skips or runs them alike, so none tries it here again: in
          // rea four workers spent 60 s each on one such try.
          run.needsReplay = true
          markTainted(test.id, run.mutant)
          run.attempt = 'mutant'
        } else {
          // Failing with the mutant and passing without it is a lead for a
          // run of the whole file, which is what decides; running the test
          // with the mutant once more would add nothing to that.
          run.repeated = true
          if (run.mutantTimedOut) {
            // Another test may have failed on it meanwhile, the stronger lead.
            if (readState(run.mutant) !== MUTANT_KILLED) writeState(run.mutant, MUTANT_TIMEOUT)
            run.timedOut.push(run.mutant)
            run.timeoutCauses.push(run.timeoutCause ?? 'loop')
          } else {
            writeState(run.mutant, MUTANT_KILLED)
            run.killed.push(run.mutant)
          }
          run.attempt = 'mutant'
        }
      }
      // Hits left by a failed or mutated attempt would otherwise be mistaken
      // for static coverage when the next test starts.
      runtime.h.fill(0)
      runtime.i.fill(0)
      runtime.b.fill(0)
      runtime.t = false
      runtime.l = Infinity
      // Which limit one mutant tripped is not the next one's.
      if (run.attempt === 'mutant') run.timeoutCause = undefined
    }

    private finishActive(): void {
      if (this.passive) {
        // What a test reached that this worker only passed through is
        // another worker's to report.
        if (this.passiveApart) drainStaticHits()
        runtime.h.fill(0)
        runtime.i.fill(0)
        runtime.b.fill(0)
        this.passive = false
      }
      if (!this.active) return
      const { test, run } = this.active
      this.active = undefined
      if (!plan && run.attempts > 1) this.trialMs += preciseNow() - run.startedAt - run.baselineMs
      runtime.a = -1
      limitStretch(0)
      // Vitest 3 leaves the test for good in that case, without the hooks that
      // follow an attempt and without the tests after it in its suite.
      const cut = !run.settled && run.attempts > 0 && run.attempt !== 'baseline' && test.result?.state === 'fail'
      if (cut) {
        this.tainted = true
        this.dropped = true
        run.unverified.push(run.mutant)
      }
      // A test that skips itself part-way through its unmutated run may get
      // further with a mutant on; what it had reached by then is left to
      // runs of the whole file.
      if (run.attempt === 'baseline' && !run.settled && test.result?.state === 'skip') {
        if (run.reached) outside(run.reached)
        drainStaticHits()
      }
      // A test that skipped itself mid-attempt never came back to be settled;
      // its mutant stays pending.
      emit({
        type: 'test',
        file: test.file.filepath,
        id: test.id,
        name: test.name,
        mode: run.mode,
        baseline: run.mode === 'probe' ? run.baselineState : undefined,
        sole: !plan || plan.sole.includes(test.file.filepath) || plan.exclusive.includes(test.file.filepath),
        pristine: run.pristine,
        baselineMs: run.baselineMs,
        baselineLoops: run.baselineLoops,
        baselineError: run.baselineError,
        baselineRetry: run.baselineRetry,
        nonRepeatable: run.nonRepeatable,
        needsReplay: run.needsReplay,
        replayed: replays(test.file.filepath),
        ms: preciseNow() - run.startedAt,
        cpuMs: cpuMs() - run.startedCpu,
        rss: process.memoryUsage().rss,
        attempts: run.attempts,
        sites: run.sites,
        covered: run.covered,
        cleanup: run.cleanup,
        killed: run.killed,
        timedOut: run.timedOut,
        timeoutCauses: run.timeoutCauses,
        stop: run.stop,
        survived: run.survived,
        suspected: run.suspected,
        unreached: run.unreached,
        unverified: run.unverified,
      })
    }
  }
}

/**
 * What is left of a copy made for one test to try a mutant when the copy did
 * not get to say what the test did: the test has had its try, and no more is
 * asked of it. With no mutant on, the test is one whose word in a copy does
 * not count.
 */
function untold(job: WholeJob, file: string): void {
  if (job.trial === undefined) return
  if (job.mutant < 0) emit({ type: 'apart', file, test: job.trial, verdict: 'failed' })
  else {
    emit({
      type: 'test',
      file,
      id: job.trial,
      name: '',
      mode: 'planned',
      ...noMutants,
      attempts: 1,
      copied: true,
      sole: !plan || plan.sole.includes(file) || plan.exclusive.includes(file),
      suspected: [job.mutant],
    })
  }
}

const noMutants = {
  baseline: 'skip',
  baselineMs: 0,
  baselineLoops: 0,
  baselineRetry: false,
  nonRepeatable: false,
  needsReplay: false,
  replayed: true,
  ms: 0,
  cpuMs: 0,
  attempts: 0,
  sites: [],
  covered: [],
  cleanup: [],
  killed: [],
  timedOut: [],
  survived: [],
  unverified: [],
}
