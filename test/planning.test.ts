import { describe, expect, it } from 'vitest'
import { inspect, planRound, type SessionRecord, stalledRound } from '../src/run.ts'

const loading = '/project/loading.test.ts'
const others = Array.from({ length: 6 }, (_, i) => `/project/other-${i}.test.ts`)

function probe(file: string, id = file, more: object = {}): SessionRecord {
  return {
    type: 'test', file, id, name: id, mode: 'probe', baseline: 'pass',
    baselineMs: file === loading ? 1 : 10, baselineLoops: 1,
    baselineRetry: false, nonRepeatable: false, needsReplay: false,
    replayed: true, pristine: true, sole: true, ms: 1, cpuMs: 1, attempts: 0,
    sites: [0], covered: [0], cleanup: [], killed: [], timedOut: [],
    survived: [], unverified: [], at: 1, ...more,
  } as SessionRecord
}

function history(named = false, knownLoading = true): SessionRecord[] {
  return [
    ...[loading, ...others].map((file) => ({
      type: 'file', file, tests: [file], staticSites: file === loading ? [0] : knownLoading ? [] : undefined,
      complete: true, at: 0,
    }) as SessionRecord),
    probe(loading, loading, { attempts: 1, timedOut: [0], timeoutCauses: ['loop'] }),
    ...others.map((file) => probe(file)),
    { type: 'whole', file: loading, mutant: 0, verdict: 'timeout', knew: true, by: 'started', ...(named ? { test: loading } : {}), at: 2 } as SessionRecord,
    ...[3, 4].map((at) => ({ type: 'pair', file: loading, verdict: 'passed', met: true, at }) as SessionRecord),
  ]
}

function next(records: SessionRecord[], state = 0) {
  const status = inspect(records)
  return { status, ...planRound(status, new Uint8Array([state]), [loading, ...others], new Map(), [0], [0]) }
}

const requested = (tests = others.slice(0, 4)): SessionRecord[] => tests.map((test) =>
  ({ type: 'alternative', mutant: 0, test, at: 5 }) as SessionRecord)

describe('bounded alternative witnesses', () => {
  it('tries four other files without treating the requests as a verdict', () => {
    const result = next(history())
    expect(result.status.detected.has(0)).toBe(false)
    expect(Object.keys(result.plan.tests)).toEqual(others.slice(0, 4))
    expect(result.alternatives).toEqual(others.slice(0, 4).map((test) => ({ mutant: 0, test })))
    expect(result.plan.settling).toBe(true)
    expect(result.plan.quiet).toBe(false)
  })

  it('returns to full confirmation after four requests even when no result arrived', () => {
    const result = next([...history(), ...requested()])
    expect(result.alternatives).toEqual([])
    expect(result.plan.tests).toEqual({})
    expect(result.plan.quiet).toBe(true)
    expect(result.plan.whole[loading].some((job) => job.mutant === 0 && job.quiet)).toBe(true)
    expect(result.status.detected.has(0)).toBe(false)
  })

  it('spends only the remaining count, independently of test timings', () => {
    const records = [...history(), ...requested(others.slice(0, 2))]
    const result = next(records)
    expect(result.alternatives).toEqual(others.slice(2, 4).map((test) => ({ mutant: 0, test })))
    const slower = records.map((record) => record.type === 'test' ? { ...record, baselineMs: record.file === others[5] ? 0.001 : 10000 } : record)
    expect(next(slower).alternatives).toEqual(result.alternatives)
  })

  it('uses distinct alternative files rather than spending the budget on one file', () => {
    const extra = `${others[0]}:extra`
    const result = next([...history(), probe(others[0], extra, { sites: [0, 1, 2], at: 3 })])
    expect(result.alternatives).toHaveLength(4)
    const files = result.alternatives.map(({ test }) => result.status.tests.get(test)!.file)
    expect(new Set(files).size).toBe(4)
    expect(result.alternatives.some(({ test }) => test === extra)).toBe(true)
  })

  it('gives a valid alternative lead a whole-file confirmation before the cheaper loading file', () => {
    const records = [...history(), ...requested(), probe(others[0], others[0], { mode: 'planned', killed: [0], attempts: 1, at: 6 })]
    const result = next(records, 1)
    expect(result.status.detected.has(0)).toBe(false)
    expect(result.plan.whole[others[0]].some((job) => job.mutant === 0 && job.witnesses?.includes(others[0]))).toBe(true)
    const confirmed = inspect([...records, { type: 'whole', file: others[0], mutant: 0, verdict: 'failed', test: others[0], by: 'started', at: 7 } as SessionRecord])
    expect(confirmed.detected.get(0)).toBe(1)
  })

  it('falls back after an alternative lead is refuted by its whole-file pass', () => {
    const result = next([
      ...history(), ...requested(), probe(others[0], others[0], { mode: 'planned', killed: [0], attempts: 1, at: 6 }),
      { type: 'whole', file: others[0], mutant: 0, verdict: 'passed', by: 'started', at: 7 } as SessionRecord,
    ])
    expect(result.status.detected.has(0)).toBe(false)
    expect(result.plan.quiet).toBe(true)
    expect(result.plan.whole[loading].some((job) => job.mutant === 0 && job.quiet)).toBe(true)
  })

  it('does not replace an existing named witness with a new search', () => {
    expect(next(history(true)).alternatives).toEqual([])
  })

  it('does not infer an alternative file is safe to load from missing coverage', () => {
    const result = next(history(false, false))
    expect(result.alternatives).toEqual([])
    expect(result.plan.quiet).toBe(true)
  })
})

describe('files that fail with no mutant on and no test to name', () => {
  const restless = '/project/restless.test.ts'
  const other = '/project/other.test.ts'
  const failure = (at: number, more: object = {}) =>
    ({ type: 'whole', file: restless, mutant: 0, verdict: 'failed', tests: [], by: 'copied after load', at, ...more }) as SessionRecord
  const records: SessionRecord[] = [
    ...[restless, other].map((file) => ({ type: 'file', file, tests: [file], staticSites: [], complete: true, at: 0 }) as SessionRecord),
    probe(restless),
    probe(other),
    // Both tests tried the mutant and passed with it.
    probe(restless, restless, { mode: 'planned', survived: [0], attempts: 1 }),
    probe(other, other, { mode: 'planned', survived: [0], attempts: 1 }),
    failure(2),
    failure(3, { alone: true }),
    failure(4, { alone: true, quiet: true }),
    { type: 'calm', file: restless, verdict: 'failed', tests: [], at: 5 } as SessionRecord,
  ]
  const plan = (more: SessionRecord[] = []) => planRound(inspect([...records, ...more]), new Uint8Array([0]), [restless, other], new Map(), [0], [0])

  it('plans no more runs there, whose failures count for nothing, and goes on to the other files', () => {
    expect([...inspect(records).restless]).toEqual([restless])
    const next = plan().plan
    expect(next.whole[restless]).toBeUndefined()
    expect(next.whole[other]?.map((job) => job.mutant)).toEqual([0])
  })

  it('leaves the round empty once the other files have passed, so that the run ends', () => {
    const { plan: next, workByFile } = plan([{ type: 'whole', file: other, mutant: 0, verdict: 'passed', by: 'copied after load', at: 6 } as SessionRecord])
    expect(next.whole).toEqual({})
    expect(workByFile.size).toBe(0)
  })
})

describe('files whose tests read a clock other than the process\'s', () => {
  const lead = probe(loading, loading, { mode: 'planned', killed: [0], attempts: 1, at: 3 })
  const records = [...history().filter((record) => record.type !== 'whole' && record.type !== 'pair'), lead]
  const job = (more: SessionRecord[]) => next([...records, ...more], 1).plan.whole[loading]?.find((planned) => planned.mutant === 0)

  it('have their runs made in copies made before they load, never in ones made while they load', () => {
    expect(job([])).toMatchObject({ early: true, loading: true })
    const clock = { type: 'early', file: loading, site: -1, clock: true, at: 4 } as SessionRecord
    expect(job([clock])).toMatchObject({ early: true, loading: false })
  })
})

describe('a test that, with its file to itself, does not reach the mutant it is given', () => {
  // As in excalidraw's `textWysiwyg.test.tsx`: a test failed with the mutant
  // next to other runs of its file, the file failed in it with the mutant on,
  // and tried again with the file to itself it passed without reaching the
  // mutant's code. Given that try round after round, the file was given up on.
  const file = '/project/canvas.test.ts'
  const records: SessionRecord[] = [
    { type: 'file', file, tests: [file], staticSites: [], complete: true, at: 0 } as SessionRecord,
    probe(file),
    probe(file, file, { mode: 'planned', sole: false, killed: [0], attempts: 3, at: 2 }),
    { type: 'whole', file, mutant: 0, verdict: 'failed', test: file, tests: [file], by: 'copied before a test', at: 3 } as SessionRecord,
  ]
  const unreached = probe(file, file, { mode: 'planned', sole: true, unreached: [0], attempts: 1, at: 4 })
  const plan = (more: SessionRecord[]) => planRound(inspect([...records, ...more]), new Uint8Array([0]), [file], new Map(), [0], [0]).plan

  it('is given the mutant once with the file to itself', () => {
    const first = plan([])
    expect(first.settling).toBe(true)
    expect(first.tests[file]?.mutants).toEqual([0])
  })

  it('is not given it again, and the file is run with nothing else running instead', () => {
    const next = plan([unreached])
    expect(next.tests).toEqual({})
    expect(next.quiet).toBe(true)
    expect(next.whole[file]?.some((job) => job.mutant === 0 && job.quiet)).toBe(true)
  })

  it('says, for a round that came to nothing, what the file was given and how it went', () => {
    const round = { plan: plan([]), round: 7, from: 3.5, to: 5 }
    const status = inspect([...records, unreached])
    expect(stalledRound(round, file, [...records, unreached], status.tests)).toEqual({
      round: 7,
      tries: [{ test: file, mutants: [0], ended: 'unreached 0' }],
      runs: [],
    })
    expect(stalledRound({ ...round, to: 4 }, file, [...records, unreached], status.tests).tries[0].ended).toBe('no word')
  })
})
