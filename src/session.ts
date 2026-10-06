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
   * Per test file, mutants to run the whole file with: in a fresh worker,
   * active from before the file is imported until it ends. What a mutant does
   * while the file loads, or leaves behind for later tests, only shows there.
   */
  whole: Record<string, WholeJob[]>
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
    runner: path.join(dir, 'runner.mjs'),
  }
}
