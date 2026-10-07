// Runs inside Vitest's test worker. It must not import `vitest`: the base
// runner class and helpers are handed in by a shim generated inside the target
// project, so this file works with whichever Vitest version that project
// resolves.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
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
 * `vi.clearAllMocks()` and friends only ever call `forEach`, which still
 * reaches the ones that are alive.
 */
function trackMocksWeakly(mocks: Set<object>): () => void {
  const weak = new Set<WeakRef<object>>()
  let created: object[] = []
  const add = mocks.add.bind(mocks)
  mocks.add = (mock) => {
    created.push(mock)
    return add(mock)
  }
  const forEach = mocks.forEach.bind(mocks)
  mocks.forEach = (callback, thisArg) => {
    forEach(callback, thisArg)
    for (const ref of weak) {
      const mock = ref.deref()
      if (mock) callback.call(thisArg, mock, mock, mocks)
      else weak.delete(ref)
    }
  }
  return () => {
    for (const mock of created) {
      if (mocks.delete(mock)) weak.add(new WeakRef(mock))
    }
    created = []
  }
}

/**
 * A kill takes three attempts: the mutant fails, the test passes again without
 * it, and the mutant fails once more. The control rules out a test that broke
 * for good; the repeat rules out one that failed once by chance, as a flaky
 * test or the first, cold run in a worker can.
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
  timeoutCause?: 'loop' | 'timer' | 'test timeout' | 'idle'
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
const mutant = new Int32Array(workerData.shared, 16, 2)
const testId = new Uint8Array(workerData.shared, 24, 256)
const deadline = new Float64Array(workerData.deadline)
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const fd = fs.openSync(workerData.statePath, 'r+')
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
for (;;) {
  Atomics.wait(sleeper, 0, 0, 100)
  const started = beat[0]
  const stalled = mutant[0]
  // A run of a whole file can also wait for good on what a mutant keeps
  // from happening while the file loads, using no CPU time at all and with
  // no test's time limit to end it.
  const overdue = deadline[0] > 0 && Date.now() > deadline[0]
  if ((beat[1] > 0 && cpu() - started > beat[1]) || overdue) {
    const end = testId.indexOf(0)
    const id = new TextDecoder().decode(testId.subarray(0, end === -1 ? testId.length : end))
    // The attempt may have ended while this thread was getting here; the
    // record and the state must name the same mutant, and only one that is
    // still running.
    if (!overdue && (beat[0] !== started || mutant[0] !== stalled || beat[1] === 0)) continue
    fs.appendFileSync(workerData.resultsPath, JSON.stringify({ type: 'stall', id, mutant: stalled, at: Date.now(), pid: process.pid }) + String.fromCharCode(10))
    // In a whole-file run the stall is the verdict. Either way it must not
    // replace what another worker has already found out.
    const current = new Uint8Array(1)
    fs.readSync(fd, current, 0, 1, stalled)
    if (current[0] === ${MUTANT_PENDING} || current[0] === ${MUTANT_STALLED}) {
      fs.writeSync(fd, new Uint8Array([mutant[1] ? ${MUTANT_TIMEOUT} : ${MUTANT_STALLED}]), 0, 1, stalled)
    }
    process.kill(process.pid, 'SIGKILL')
  }
}
`
const shared = new SharedArrayBuffer(24 + 256)
/** [0] process CPU time at the last heartbeat, [1] how much more it may use, 0 when no mutant is active. */
const beat = new Float64Array(shared, 0, 2)
/** [0] the active mutant, [1] 1 in a whole-file run. */
const beatMutant = new Int32Array(shared, 16, 2)
const beatTest = new Uint8Array(shared, 24, 256)
/** When a run of a whole file has to be over, by the clock; 0 outside one. */
const wallDeadline = new Float64Array(new SharedArrayBuffer(8))
let watching = false
/** Whether this process is a copy made for one whole-file run. */
let cloned = false
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
      statePath: paths.state,
      resultsPath: path.join(paths.results, `${process.pid}.jsonl`),
    },
  }).unref()
}
const heartbeat = () => {
  const usage = process.cpuUsage()
  beat[0] = (usage.user + usage.system) / 1000
  if (cloned) {
    // A copy whose watcher is gone has nobody to hand a verdict to.
    if (process.ppid !== copiedFrom) cloner!.exit(1)
    // It has no thread to watch it; the process it was copied from does,
    // from outside, and is told what the thread would read.
    cloner!.heartbeat(beat[0], beat[1])
  }
}
heartbeat()
realSetInterval(heartbeat, 50).unref()

/** The addon that copies a process (`native/src/lib.rs`). */
interface Cloner {
  /** 0 in the copy, its process id in the one that was copied. */
  fork(lock: number): number
  pid(): number
  heartbeat(cpuMs: number, limitMs: number): void
  /** In a copy: its verdict is written. */
  done(): void
  /** Waits for a copy to end and says how it did. */
  supervise(pid: number, stuckMs: number, ceilingMs: number): number
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

/** How long a copy may go without a heartbeat while using no CPU time. */
const STUCK_MS = 3000

/** In `runtime.a`: no mutant is on, and none is to be probed for either. */
const NO_MUTANT = 0x7fffffff

let forkLock: number | undefined
/** Calls to the main process that have not been answered. */
let calls = 0
let counting = false
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
      if (cloned && key === 'onUserConsoleLog') return () => {}
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
 * Waits for what this process has under way to end, and says whether it
 * then holds nothing open beyond `before`. A write half done would be
 * finished by the process and its copy both; a request a thread is working
 * on would never be answered in the copy.
 *
 * Timers count only once the project's code has run. One it set would be
 * due sooner in each copy made later, where every run of the suite has it
 * due at the same point; Vitest's own are in every worker alike.
 */
async function calm(before: Map<string, number>, timers: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await quiet()
    const now = activeResources()
    if (!timers) {
      now.delete('Timeout')
      now.delete('Immediate')
    }
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

function firstError(test: TaskLike): string | undefined {
  const error = test.result?.errors?.[0] as { message?: string } | undefined
  return error?.message?.slice(0, 500)
}

/**
 * Several workers may run the same file at once. Whichever creates the claim
 * file first takes the test, or the chunk of its mutants; the others move on.
 */
function claim(name: string): boolean {
  try {
    fs.closeSync(fs.openSync(path.join(paths.claims, name), 'wx'))
    return true
  } catch {
    return false
  }
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
    /** Whether a test stopped passing unmutated in this worker, which ends the worker. */
    private tainted = false
    /** Whether a mutant has been on in this worker. */
    private attempted = false
    /** Time this worker has spent on mutants its tests tried in passing. */
    private trialMs = 0
    /** The mutant this worker runs the whole file with, if it took such a job. */
    private whole: WholeJob | undefined
    private wholeFailure: 'failed' | 'timeout' | undefined
    private wholeFile: string | undefined
    private wholeStartedAt = 0
    /** The test whose failure the run's verdict is, if it was a test's. */
    private wholeTest: string | undefined
    /** How the process making the whole-file run came to be. */
    private wholeBy: 'started' | 'copied before load' | 'copied after load' = 'started'
    /** This process loads the file with no mutant on, to be copied for each job once it has. */
    private template = false
    private heldBeforeLoad = new Map<string, number>()
    private openBeforeLoad: Set<string> | undefined
    /** Vitest gave up on a test part-way, and with it on the rest of its suite. */
    private dropped = false

    async onBeforeCollect(paths: (string | { filepath: string })[]): Promise<unknown> {
      loadRound()
      loaded = false
      const file = typeof paths[0] === 'string' ? paths[0] : paths[0]?.filepath
      this.wholeFile = file
      const jobs = plan?.whole[file] ?? []
      const plain = jobs.find((job) => job.plain && this.open(job) && claim(`whole.${job.id}`))
      if (plain) {
        this.begin(plain, true)
      } else if (cloner && !watching && jobs.length > 0 && (await calm(workerResources, false))) {
          // Nothing of the project has run in this process yet, so a copy of
        // it is what a new worker would be at this point.
        for (const job of jobs) {
          if (job.plain || !job.early || !this.open(job) || !claim(`whole.${job.id}`)) continue
          if (await this.clone(job, true)) {
            this.begin(job, true)
            return super.onBeforeCollect?.(paths)
          }
        }
        // The other jobs are for mutants whose code does not run while the
        // file loads. A copy made once it has loaded is, for them, what a run
        // that had the mutant on all along would be at that point. Until then
        // no mutant is on and no probe runs.
        this.template = jobs.some((job) => !job.plain && !job.early && this.open(job))
        if (this.template) {
          runtime.a = NO_MUTANT
          // Node opens its end of the standard streams when they are first
          // used. A file that logs while it loads would look as if it had
          // opened a pipe; these exist in every copy either way.
          void process.stdout
          void process.stderr
          this.heldBeforeLoad = activeResources()
          this.openBeforeLoad = openDescriptors()
          this.keepToItself()
          return super.onBeforeCollect?.(paths)
        }
      } else {
        const job = jobs.find((job) => this.open(job) && claim(`whole.${job.id}`))
        if (job) this.begin(job, true)
      }
      watch()
      workerResources = activeResources()
      return super.onBeforeCollect?.(paths)
    }

    private open(job: WholeJob): boolean {
      const state = readState(job.mutant)
      return job.confirm === true || state === MUTANT_PENDING || state === MUTANT_STALLED
    }

    /**
     * Copies this process for one whole-file run and, in the process that
     * was copied, waits for the copy to end. Returns whether this is the copy.
     */
    private async clone(job: WholeJob, beforeLoad: boolean): Promise<boolean> {
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
      return this.copy(job, beforeLoad)
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

    /** The copying itself, which nothing may interrupt: see `clone`. */
    private copy(job: WholeJob, beforeLoad: boolean): boolean {
      const by = beforeLoad ? 'copied before load' : 'copied after load'
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
      // heartbeat and never ends, awaiting what a mutant keeps from
      // happening where no test's time limit applies, is given up on after
      // several times what the file may take.
      const limit = hardLimitMs({ baselineMs: job.fileMs })
      const copiedAt = preciseNow()
      const ended = cloner!.supervise(pid, STUCK_MS, limit * 3 + 30_000)
      if (ended === cloner!.Ended.Blocked) {
        const state = readState(job.mutant)
        if (state === MUTANT_PENDING || state === MUTANT_STALLED) writeState(job.mutant, MUTANT_TIMEOUT)
        emit({ type: 'whole', file: this.wholeFile, mutant: job.mutant, verdict: 'timeout', by, ms: preciseNow() - copiedAt })
      } else if (ended === cloner!.Ended.Lost) {
        // The copy ended without a verdict, by this process's hand or its
        // own. Whatever it was, a worker started for the job alone decides.
        emit({ type: 'plain', file: this.wholeFile, mutant: job.mutant })
      }
      return false
    }

    /** Turns the job's mutant on for the rest of the file's run. */
    private begin(job: WholeJob, beforeLoad: boolean): void {
      this.whole = job
      this.wholeStartedAt = preciseNow()
      runtime.a = job.mutant
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
      beatTest.fill(0)
      // No stretch of the run can take longer than the whole file does. A
      // mutant that blocked a worker before gets the plain limit: blocking
      // twice is what a timeout is.
      const file = { baselineMs: job.fileMs }
      beat[1] = job.stalled ? limitMs(file) : hardLimitMs(file)
      heartbeat()
      // A copy is watched, for this too, by the process it was copied from.
      wallDeadline[0] = cloned ? 0 : realNow() + hardLimitMs(file)
      // A count of iterations says a loop is long, not that it does not
      // end: a mutant can send a loop over a few million elements that it
      // is through with in milliseconds, and the suite passes. Here, where
      // the verdict is made, a loop past its count goes on until it has
      // also kept the process busy without a pause for longer than any
      // loop of the file is likely to.
      const busyMs = Math.min(beat[1], Math.max(1000, job.fileMs * 2))
      runtime.x = (() => {
        if (cpuMs() - beat[0] < busyMs) {
          runtime.l += config.loopSlack
          return
        }
        return this.loopLimit()
      }) as () => never
    }

    async onCollected(files: TaskLike[]): Promise<unknown> {
      if (this.template) {
        const told = new Set<number>()
        // A file, a socket, a child process, a watcher or a timer the file
        // left open while loading would be shared by every copy made from
        // here; such a file's runs are all made from copies taken before it
        // loads.
        const open = openDescriptors()
        const opened = !open || !this.openBeforeLoad || [...open].some((fd) => !this.openBeforeLoad!.has(fd))
        const shares = opened || !(await calm(this.heldBeforeLoad, true))
        if (shares) emit({ type: 'early', file: this.wholeFile, site: -1, held: [...activeResources()] })
        for (const job of shares ? [] : (plan?.whole[this.wholeFile!] ?? [])) {
          if (job.plain || job.early || !this.open(job)) continue
          // The mutant's code did run while this process loaded the file, so
          // a copy from here would have had it off for that: the job is left
          // for a copy made before loading.
          if (runtime.h[job.site] === 1) {
            if (!told.has(job.site)) emit({ type: 'early', file: this.wholeFile, site: job.site })
            told.add(job.site)
            continue
          }
          if (!claim(`whole.${job.id}`)) continue
          if (await this.clone(job, false)) {
            this.begin(job, false)
            return super.onCollected?.(files)
          }
        }
        // All that is left for this process is to end the file's run.
        runtime.a = -1
        forEachTask(files, (task) => {
          if (task.mode === 'run' || task.mode === 'queued') task.mode = 'skip'
        })
        return super.onCollected?.(files)
      }
      if (this.whole) return super.onCollected?.(files)
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
        } else if (plan && !plan.probe[file.file.filepath]) {
          // A replayed file runs as in a normal run up to the last test
          // anyone drives; nothing after it is needed.
          let last: TaskLike | undefined
          forEachTask([file], (task) => {
            if (task.type === 'test' && plan!.tests[task.id]) last = task
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
      await super.onBeforeRunSuite?.(suite)
    }

    async onBeforeRunTask(test: TaskLike): Promise<void> {
      await super.onBeforeRunTask?.(test)
      if (this.whole) {
        // The first failure settles it.
        if (this.wholeFailure || this.whole.ignore.includes(test.id)) test.mode = 'skip'
        return
      }
      if (test.mode !== 'run' && test.mode !== 'queued') return
      this.seen.push(test.id)
      const run = this.admit(test)
      if (!run) {
        if (!replays(test.file.filepath)) test.mode = 'skip'
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
      if (plan.probe[test.file.filepath] && !probed.has(test.id) && claim(test.id)) {
        return newRun('probe')
      }
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
      if (this.whole) return super.onBeforeTryTask?.(test, options)
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
          if (recycle) process.kill(process.pid, 'SIGKILL')
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
        beat[1] = limitMs(run)
        runtime.l = run.baselineLoops * config.loopFactor + config.loopSlack
      }
      if (run.attempt === 'mutant') {
        heartbeat()
        beatMutant[0] = run.mutant
        beatMutant[1] = 0
        beatTest.fill(0)
        beatTest.set(new TextEncoder().encode(test.id).subarray(0, 255))
        // CPU time does not stretch on a busy machine the way wall time does,
        // so one stretch without yielding ends at the plain limit. That only
        // hands the mutant to a whole-file run, which gives it the most a run
        // may take before it calls it a timeout.
        beat[1] = limitMs(run)
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
          if (readState(candidate) === MUTANT_PENDING) return candidate
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
      if (this.whole) return super.onTaskFinished?.(test)
      runtime.a = -1
      beat[1] = 0
      // What only the cleanup hooks reach is not something a mutant run of
      // the test could reach either.
      const run = this.active?.test === test ? this.active.run : undefined
      if (run?.attempt === 'baseline' && !run.settled) run.reached = drainCoverage()
      return super.onTaskFinished?.(test)
    }

    // Vitest 5 resets the state before the next `onBeforeTryTask`, so there the
    // outcome has to be read here.
    onAfterRetryTask(test: TaskLike, options: TryOptions): unknown {
      if (this.active?.test === test) {
        this.active.run.failed = test.result?.state === 'fail'
        this.active.run.errorsSeen = test.result?.errors?.length ?? 0
        if (this.active.run.failed) this.active.run.lastError = firstError(test)
      }
      return super.onAfterRetryTask?.(test, options)
    }

    async onAfterRunTask(test: TaskLike): Promise<void> {
      await super.onAfterRunTask?.(test)
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
      if (this.whole && test.result?.state === 'fail') {
        if (!this.wholeFailure) this.wholeTest = test.id
        this.wholeFailure ??= runtime.t || /^Test timed out in \d+ms/.test(firstError(test) ?? '') ? 'timeout' : 'failed'
        // The first failure settles it, and nobody waits for the rest of a copy's run.
        if (cloned) await this.leave()
      }
    }

    /**
     * Ends a copy: no answer is half read, which would leave the other half
     * to the next copy, and its verdict is written.
     */
    private async leave(): Promise<never> {
      // An error nothing handled may be on its way with an answer; the
      // verdict is read once nothing is.
      await quiet()
      emit({
        type: 'whole',
        file: this.wholeFile,
        mutant: this.whole!.mutant,
        verdict: this.wholeFailure ?? 'passed',
        test: this.wholeTest,
        by: this.wholeBy,
        ms: preciseNow() - this.wholeStartedAt,
      })
      cloner!.done()
      return cloner!.exit(0)
    }

    onAfterRunFiles(files: TaskLike[]): unknown {
      if (this.whole) {
        runtime.a = -1
        beat[1] = 0
        wallDeadline[0] = 0
        runtime.x = this.loopLimit
        // A hook or the file itself can fail with every test passing.
        forEachTask(files, (task) => {
          if (task.result?.state === 'fail') this.wholeFailure ??= runtime.t ? 'timeout' : 'failed'
        })
        if (cloned) return this.leave()
        for (const file of files) {
          emit({
            type: 'whole',
            file: file.file.filepath,
            mutant: this.whole.mutant,
            verdict: this.wholeFailure ?? 'passed',
            test: this.wholeTest,
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
      drainStaticHits()
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
        const complete = (!plan || file.file.filepath in plan.probe) && !this.dropped && !this.template
        emit({
          type: 'file',
          file: file.file.filepath,
          tests: this.seen,
          staticSites: sites,
          staticMutants: mutants,
          hookSites: marked(hookHits),
          hookMutants: marked(hookMutants),
          pristine: plan?.pristine.includes(file.file.filepath) && !this.template,
          complete,
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
      beat[1] = 0
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
      } else if (run.attempt === 'baseline') {
        run.baselineMs = preciseNow() - run.startedAt
        run.baselineLoops = runtime.n
        run.baselineState = failed ? 'fail' : 'pass'
        if (failed) {
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
          run.pristine = !this.attempted
          const measuring = plan?.pristine.includes(test.file.filepath)
          // A file has one worker in the first round, so what its tests try
          // there runs one after another while other workers may be idle;
          // past a point the rest is better left to the rounds that share it out.
          if (!measuring && (plan || run.baselineMs < config.cheapMs)) run.queue = run.covered
          run.sliceEnd = run.queue.length
        }
        run.attempt = 'mutant'
      } else if (run.attempt === 'mutant') {
        // A tripped limit counts even if the test swallowed the error.
        if (failed || runtime.t) {
          // A failure only proves something if the test still passes without
          // the mutant, so the verdict waits for a control run.
          // Vitest fails a test that took longer than its timeout even if it
          // returned, which is how a slow but finite mutant shows up.
          const overran = /^Test timed out in \d+ms/.test(error ?? '')
          run.mutantTimedOut = runtime.t || overran
          if (overran && !runtime.t) run.timeoutCause = 'test timeout'
          else if (!runtime.t) run.timeoutCause = undefined
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
          run.attempt = 'mutant'
        } else if (failed && replayed) {
          run.nonRepeatable = true
          run.unverified.push(run.mutant)
          run.suspected.push(run.mutant)
          run.attempt = 'mutant'
        } else if (failed) {
          // The mutant stays pending: in this worker the test may fail only
          // because the tests before it were skipped.
          run.needsReplay = true
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
      beat[1] = 0
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
