import { describe, expect, it } from 'vitest'
import { inspect, planRound, type SessionRecord } from '../src/run.ts'

const fast = '/project/fast.test.ts'
const slow = '/project/slow.test.ts'

function lead(file: string, kind: 'failed' | 'timeout', more: object = {}): SessionRecord {
  return {
    type: 'test', file, id: file, name: file, mode: 'probe',
    baseline: 'pass', baselineMs: file === fast ? 1 : 50, baselineLoops: 1,
    baselineRetry: false, nonRepeatable: false, needsReplay: false,
    replayed: true, pristine: true, sole: true, ms: 1, cpuMs: 1, attempts: 1,
    sites: [0], covered: [0], cleanup: [],
    killed: kind === 'failed' ? [0] : [], timedOut: kind === 'timeout' ? [0] : [],
    timeoutCauses: kind === 'timeout' ? ['loop'] : [], survived: [], unverified: [],
    at: 1, ...more,
  } as SessionRecord
}

function planned(records: SessionRecord[]) {
  const complete = [fast, slow].map((file) => ({
    type: 'file', file, tests: [file], staticSites: [], complete: true, at: 0,
  }) as SessionRecord)
  const status = inspect([...complete, ...records])
  return {
    status,
    plan: planRound(status, new Uint8Array([1, 1]), [fast, slow], new Map(), [0, 1], [0, 0]).plan,
  }
}

const filesFor = (plan: ReturnType<typeof planned>['plan'], mutant = 0) =>
  Object.entries(plan.whole).filter(([, jobs]) => jobs.some((job) => job.mutant === mutant)).map(([file]) => file)

describe('selecting a file to confirm an existing lead', () => {
  it('prefers an ordinary failure over a cheaper timeout lead, without settling its verdict', () => {
    const { status, plan } = planned([lead(fast, 'timeout'), lead(slow, 'failed')])
    expect(status.detected.has(0)).toBe(false)
    expect(filesFor(plan)).toEqual([slow])
    expect(plan.whole[slow][0].witnesses).toEqual([slow])
  })

  it('uses the cheaper file when all leads timed out', () => {
    expect(filesFor(planned([lead(slow, 'timeout'), lead(fast, 'timeout')]).plan)).toEqual([fast])
  })

  it('does not prefer an ordinary failure observed beside other runs of its file', () => {
    expect(filesFor(planned([lead(fast, 'timeout'), lead(slow, 'failed', { sole: false })]).plan)).toEqual([fast])
  })

  it('does not prefer a witness whose other lead was refuted by a passing whole-file run', () => {
    const { plan } = planned([
      lead(fast, 'timeout'), lead(slow, 'failed'), lead(slow, 'failed', { killed: [1], at: 2 }),
      { type: 'whole', file: slow, mutant: 1, verdict: 'passed', by: 'started', at: 3 } as SessionRecord,
    ])
    expect(filesFor(plan)).toEqual([fast])
  })

  it('continues with the timeout file after the ordinary-failure file passes', () => {
    const { status, plan } = planned([
      lead(fast, 'timeout'), lead(slow, 'failed'),
      { type: 'whole', file: slow, mutant: 0, verdict: 'passed', by: 'started', at: 2 } as SessionRecord,
    ])
    expect(status.detected.has(0)).toBe(false)
    expect(filesFor(plan)).toEqual([fast])
  })
})
