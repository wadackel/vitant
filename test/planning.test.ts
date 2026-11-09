import { describe, expect, it } from 'vitest'
import { inspect, planRound, type SessionRecord } from '../src/run.ts'

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
