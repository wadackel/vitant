// Files the main process and the test workers share. Workers are separate
// processes, so everything they exchange goes through this directory.

import path from 'node:path'
import { types } from 'node:util'

export const MUTANT_PENDING = 0
export const MUTANT_KILLED = 1
export const MUTANT_TIMEOUT = 2
/** A worker was killed for blocking its event loop under the mutant; a fresh run decides. */
export const MUTANT_STALLED = 3

export interface SessionConfig {
  runtimeGlobal: string
  siteCount: number
  mutantCount: number
  /** A mutant run may take `baselineMs * timeoutFactor + timeoutMs` before it is abandoned. */
  timeoutFactor: number
  timeoutMs: number
  /** Heap size at which a worker hands its file over to a fresh one. */
  recycleHeapBytes: number
  /** In the first round, tests faster than this run their mutants right away. */
  cheapMs: number
  /** A mutant run may execute `baselineLoops * loopFactor + loopSlack` guarded loop iterations. */
  loopFactor: number
  loopSlack: number
}

/** What the main process asks of the workers in every round after the first. */
export interface RoundPlan {
  /** Test files whose workers run the tests they do not drive once, unmutated, instead of skipping them. */
  replay: string[]
  /** Tests whose unmutated run failed while the tests before them had run; another such failure is final. */
  retried: string[]
  tests: Record<string, PlannedTest>
  /**
   * Test files whose first full pass was cut short, with the tests that did
   * report coverage. The others still need their unmutated run.
   */
  probe: Record<string, string[]>
  /** Test files to go through once more without trying any mutant, so that no mutant has touched what the tests see. */
  pristine: string[]
  /**
   * Tests that fail with no mutant on. A pass that measures their file
   * leaves them out, as the runs of the whole file do: what the tests after
   * them reach is then seen as those runs will have it.
   */
  ignore: string[]
  /**
   * Per test file, mutants to run the whole file with: in a fresh worker,
   * active from before the file is imported until it ends. What a mutant does
   * while the file loads, or leaves behind for later tests, only shows there.
   */
  whole: Record<string, WholeJob[]>
  /** Test files nothing of which runs in two processes at once, see `WholeJob.exclusive`. */
  exclusive: string[]
  /** The round is of tests trying mutants whose runs of a file failed in them, one worker to a file. */
  settling: boolean
  /** The round is of runs made one at a time with nothing else running, see `WholeJob.quiet`. */
  quiet: boolean
  /** Test files that one worker has to itself in the round, as every file has in the first. */
  sole: string[]
}

export interface WholeJob {
  id: number
  mutant: number
  /** Tests that fail without any mutant. */
  ignore: string[]
  /** What the file's tests take together, unmutated. */
  fileMs: number
  /** How often instrumented loops go round in the file's tests together, unmutated. */
  fileLoops: number
  /** The mutant already blocked a worker while a test tried it. */
  stalled: boolean
  /** A test of the file failed with the mutant while trying it; the run is to see whether the file does. */
  confirm?: boolean
  /**
   * The file's runs have been seen to get in each other's way, as tests that
   * listen on a port or write files next to themselves do when the same
   * file runs in several processes at once, which a plain run never does.
   * Such a run is made with no other of the file under way.
   */
  exclusive?: boolean
  /**
   * No mutant, and made at the same moment as another such run of the file:
   * the two show whether runs of the file fail each other. Asked of a file
   * in which a mutant failed twice in a test that had given no lead, which
   * is what a mutant that is detected looks like, and what every mutant
   * looks like in a file whose runs never get past each other.
   */
  pair?: boolean
  /**
   * Made with nothing else running. A mutant no test failed on while trying
   * it, whose runs of the file fail all the same, may fail them on a busy
   * machine alone, and its last run is made on one that is not busy with
   * this tool's own work.
   */
  quiet?: boolean
  /** No mutant: the run is to show that a copy of a worker runs the file as a worker started for it does. */
  control?: boolean
  /**
   * The tests that failed with the mutant while trying it and passed again
   * without it. The file failing in one of them settles the mutant in one run.
   */
  witnesses?: string[]
  site: number
  /** The mutant's code runs while the file loads, as far as is known. */
  early: boolean
  /** A copy of a worker ended without a verdict for this run; a worker started for it alone makes it. */
  plain: boolean
}

export interface PlannedTest {
  /** Mutants to try, in order. Absent when the test needs an unmutated run to learn them. */
  mutants?: number[]
  /** Mutants per claim, so that several workers can share one test's list. */
  chunk: number
  baselineMs: number
  baselineLoops: number
}

/** The object instrumented code reads; property names are short because they are inlined at every site. */
export interface Runtime {
  /** Active mutant id, or -1. */
  a: number
  /** One byte per site, set when the site's original code is evaluated. */
  h: Uint8Array
  /** One byte per mutant, set when a probe saw the mutant would have changed a value. */
  i: Uint8Array
  /**
   * Per site, evaluations that began and have not finished. One left over
   * after a test means the site threw, or never returned, where a constant in
   * its place would have carried on.
   */
  b: Int32Array
  /**
   * Checked property reads and operand conversions that may have run code. A
   * condition whose evaluation moved the count cannot be dropped unnoticed.
   */
  v: number
  /** Built-ins the read check relies on, as they were before any test could replace them. */
  P: (value: unknown) => boolean
  G: typeof Object.getOwnPropertyDescriptor
  O: typeof Object.getPrototypeOf
  B: ObjectConstructor
  g: object
  /**
   * Values a site's mutants would have produced, as a chain of
   * `{k: mutant, v: value, n: next}`, left for the enclosing site's probe to pick up.
   */
  s: object | null
  /** Whether a function is a built-in whose result depends on nothing but its arguments, if those are primitives. */
  N: (value: unknown) => boolean
  /** The same for built-ins that only look at what their arguments are. */
  A: (value: unknown) => boolean
  /** `Reflect.apply`, as it was before any test could replace it. */
  y: typeof Reflect.apply
  /** Set when the active mutant's code runs. */
  r: number
  /** Guarded loop iterations since the attempt started. */
  n: number
  /** Iteration limit for the attempt. */
  l: number
  /** Whether the limit was exceeded during the attempt. */
  t: boolean
  x: () => never
}

export function createRuntime(siteCount: number, mutantCount: number): Runtime {
  const runtime: Runtime = {
    a: -1,
    h: new Uint8Array(siteCount),
    i: new Uint8Array(mutantCount),
    b: new Int32Array(siteCount),
    v: 0,
    P: types.isProxy,
    G: Object.getOwnPropertyDescriptor,
    O: Object.getPrototypeOf,
    B: Object,
    g: globalThis,
    s: null,
    r: 0,
    N: Set.prototype.has.bind(
      new Set<unknown>([
        ...Object.getOwnPropertyNames(Math)
          .filter((name) => name !== 'random')
          .map((name) => (Math as unknown as Record<string, unknown>)[name])
          .filter((value) => typeof value === 'function'),
        Number.isFinite,
        Number.isNaN,
        Number.isInteger,
        Number.isSafeInteger,
        Number.parseFloat,
        Number.parseInt,
        isFinite,
        isNaN,
        parseFloat,
        parseInt,
        Number,
        String,
        Boolean,
      ]),
    ),
    A: Set.prototype.has.bind(new Set<unknown>([Array.isArray, Object.is])),
    y: Reflect.apply,
    n: 0,
    l: Infinity,
    t: false,
    x() {
      runtime.t = true
      throw new Error('[vitant] loop iteration limit exceeded')
    },
  }
  return runtime
}

/**
 * Keeps count, from the start of a worker, of the calls it has sent to the
 * main process and has no answer to. A copy of the worker reads the same
 * channel, so one made with a call under way reads the answer, and the
 * worker waits for it for good. The runner cannot keep this count itself:
 * what Node and Vitest print while a worker starts up is already such a
 * call, sent before any runner exists, and its answer can come after that
 * to a call made later.
 */
export const channelWatch = `
const unanswered = globalThis.__vitant_unanswered = new Set()
const v8 = require('node:v8')
function envelope(message, depth) {
  if (message === null || typeof message !== 'object' || depth > 3) return undefined
  // Vitest 3 serialises its messages itself; on arrival the bytes are the plain object a buffer turns into on the way.
  const bytes = ArrayBuffer.isView(message) ? message : message.type === 'Buffer' && Array.isArray(message.data) ? Buffer.from(message.data) : undefined
  if (bytes) {
    try { return envelope(v8.deserialize(bytes), depth + 1) } catch { return undefined }
  }
  if ((message.t === 'q' || message.t === 's') && typeof message.i === 'string') return message
  for (const value of Object.values(message)) {
    const found = envelope(value, depth + 1)
    if (found) return found
  }
  return undefined
}
// What is called to send may be taken hold of by whoever comes next; what that calls is looked up each time.
const send = process._send
if (send) {
  process._send = function (...args) {
    const sent = envelope(args[0], 0)
    if (sent && sent.t === 'q') unanswered.add(sent.i)
    return send.apply(this, args)
  }
  process.prependListener('message', (message) => {
    const answer = envelope(message, 0)
    if (answer && answer.t === 's') unanswered.delete(answer.i)
  })
}
`

export function sessionPaths(dir: string) {
  return {
    config: path.join(dir, 'config.json'),
    /** Uint32 per site: id of its first mutant, plus one trailing total. */
    sites: path.join(dir, 'sites.bin'),
    /** One byte per mutant, 1 when the unmutated run can tell whether it changes a value. */
    tracked: path.join(dir, 'tracked.bin'),
    /** One byte per mutant, written by whichever worker decides its fate. */
    state: path.join(dir, 'state.bin'),
    /** The `RoundPlan` of the current round; absent in the first. */
    plan: path.join(dir, 'plan.json'),
    results: path.join(dir, 'results'),
    /** One empty file per test, or chunk of a test's mutants, a worker took on in the current round. */
    claims: path.join(dir, 'claims'),
    /** One file per worker, named by its process id: an Int32, the mutant it has on for a test, or -1. */
    trying: path.join(dir, 'trying'),
    /** One empty file per whole-file run a copy asks to have made once more, named by the job's id. */
    again: path.join(dir, 'again'),
    /** One directory per test file a whole-file run of which is under way and must be the only one, see `WholeJob.exclusive`. */
    locks: path.join(dir, 'locks'),
    runner: path.join(dir, 'runner.mjs'),
    /** Loaded by a worker that is to be copied before anything else, see `channelWatch`. */
    preload: path.join(dir, 'preload.cjs'),
  }
}

/**
 * A file as reports, the cache and messages name it: relative to the project
 * and with the same separators on every platform, so that what one machine
 * wrote reads the same on another.
 */
export function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}
