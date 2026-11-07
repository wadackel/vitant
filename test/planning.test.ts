import { describe, expect, it } from 'vitest'
import { inspect, planRound, type SessionRecord } from '../src/run.ts'

const fast = '/project/fast.test.ts'
const slow = '/project/slow.test.ts'

function lead(file: string): SessionRecord {
  return {
    type: 'test', file, id: file, name: file, mode: 'probe',
    baseline: 'pass', baselineMs: file === fast ? 1 : 50, baselineLoops: 1,
    baselineRetry: false, nonRepeatable: false, needsReplay: false,
    replayed: true, pristine: true, sole: true, ms: 1, cpuMs: 1, attempts: 1,
    sites: [0], covered: [0], cleanup: [], killed: [], timedOut: [0],
    timeoutCauses: ['loop'], survived: [], unverified: [], at: 1,
  } as SessionRecord
}

function planned(fastSites: number[] | undefined, slowSites: number[], extra: SessionRecord[] = []) {
  const complete = [fast, slow].map((file) => ({
    type: 'file', file, tests: [file], staticSites: file === fast ? fastSites : slowSites, complete: true, at: 0,
  }) as SessionRecord)
  const status = inspect([...complete, lead(fast), lead(slow), ...extra])
  return { status, plan: planRound(status, new Uint8Array([2]), [fast, slow], new Map(), [0], [0]).plan }
}

const filesFor = (plan: ReturnType<typeof planned>['plan']) =>
  Object.entries(plan.whole).filter(([, jobs]) => jobs.some((job) => job.mutant === 0)).map(([file]) => file)

describe('confirming leads after observing loading coverage', () => {
  it('prefers a file that did not reach the mutant during loading without settling its verdict', () => {
    const { status, plan } = planned([0], [])
    expect(status.detected.has(0)).toBe(false)
    expect(filesFor(plan)).toEqual([slow])
    expect(plan.whole[slow][0].witnesses).toEqual([slow])
    expect(plan.whole[slow][0].early).toBe(false)
  })

  it('treats missing loading coverage as unknown', () => {
    expect(filesFor(planned(undefined, []).plan)).toEqual([slow])
  })

  it('keeps the cheaper file when both files reach the site while loading', () => {
    expect(filesFor(planned([0], [0]).plan)).toEqual([fast])
  })

  it('does not penalize loading that only reached another site', () => {
    expect(filesFor(planned([1], []).plan)).toEqual([fast])
  })

  it('still confirms the loading file after the preferred file passes', () => {
    const { status, plan } = planned([0], [], [
      { type: 'whole', file: slow, mutant: 0, verdict: 'passed', by: 'started', at: 2 } as SessionRecord,
    ])
    expect(status.detected.has(0)).toBe(false)
    expect(filesFor(plan)).toEqual([fast])
    expect(plan.whole[fast][0].early).toBe(true)
  })
})
