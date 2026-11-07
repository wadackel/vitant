import { expect, it } from 'vitest'
import { inspect, planRound, type SessionRecord } from '../src/run.ts'

const waiting = '/project/waiting.test.ts'
const busy = '/project/busy.test.ts'

function records(withWork: boolean, named = false): SessionRecord[] {
  const test = (file: string, covered: number[], timedOut: number[] = []) => ({
    type: 'test', file, id: file, name: file, mode: 'probe', baseline: 'pass',
    baselineMs: 1, baselineLoops: 1, baselineRetry: false, nonRepeatable: false,
    needsReplay: false, replayed: true, pristine: true, sole: !named,
    ms: 1, cpuMs: 1, attempts: timedOut.length, sites: covered, covered,
    cleanup: [], killed: [], timedOut, timeoutCauses: timedOut.map(() => 'loop'),
    survived: [], unverified: [], at: 1,
  }) as SessionRecord
  const files = withWork ? [waiting, busy] : [waiting]
  return [
    ...files.map((file) => ({ type: 'file', file, tests: [file], staticSites: file === waiting ? [0] : [], complete: true, at: 0 }) as SessionRecord),
    test(waiting, [0], [0]), ...(withWork ? [test(busy, [1])] : []),
    { type: 'whole', file: waiting, mutant: 0, verdict: 'timeout', knew: true, by: 'started', ...(named ? { test: waiting } : {}), at: 2 } as SessionRecord,
    ...[3, 4].map((at) => ({ type: 'pair', file: waiting, verdict: 'passed', met: true, at }) as SessionRecord),
  ]
}

function next(withWork: boolean, named = false) {
  return planRound(inspect(records(withWork, named)), new Uint8Array(withWork ? [0, 0] : [0]), withWork ? [waiting, busy] : [waiting], new Map(), [0, 1], [0, 0])
}

it('records an idle waiting file without scheduling its confirmation early', () => {
  const result = next(true)
  expect(result.plan.quiet).toBe(false)
  expect(Object.keys(result.plan.tests)).toEqual([busy])
  expect(result.plan.whole[waiting]).toBeUndefined()
  expect(result.waiting).toContainEqual({ mutant: 0, file: waiting, pending: true, named: false, busy: false, loading: true, timedOut: true, exclusive: false, restless: false, beside: false, otherWork: false })
})

it('distinguishes pending witness work from an unnamed loading failure', () => {
  expect(next(true, true).waiting[0]).toMatchObject({ named: true, beside: true })
})

it('keeps the existing final confirmation and records that no earlier work occupied its file', () => {
  const result = next(false)
  expect(result.plan.quiet).toBe(true)
  expect(result.plan.whole[waiting].some((job) => job.mutant === 0 && job.quiet)).toBe(true)
  expect(result.waiting[0]).toMatchObject({ busy: false, otherWork: false })
})
