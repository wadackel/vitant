import { describe, expect, it } from 'vitest'
import { inspect, type SessionRecord } from '../src/run.ts'

const file = '/project/a.test.ts'
const MUTANT_KILLED = 1

let at = 0
const whole = (mutant: number, verdict: 'failed' | 'passed' | 'timeout', more: object = {}): SessionRecord =>
  ({ type: 'whole', file, mutant, verdict, by: 'copied after load', at: at++, ...more }) as SessionRecord

/** A test that failed with the mutant while trying it and passed again without it. */
const lead = (mutant: number, id: string): SessionRecord =>
  ({
    type: 'test',
    file,
    id,
    name: id,
    mode: 'planned',
    baselineMs: 1,
    baselineLoops: 0,
    baselineRetry: false,
    nonRepeatable: false,
    needsReplay: false,
    replayed: true,
    ms: 1,
    cpuMs: 1,
    attempts: 1,
    sites: [],
    covered: [],
    cleanup: [],
    killed: [mutant],
    timedOut: [],
    survived: [],
    unverified: [],
    at: at++,
  }) as unknown as SessionRecord

describe('what the runs of whole files settle', () => {
  it('takes one failure in the test that gave the lead', () => {
    const status = inspect([lead(0, 't1'), whole(0, 'failed', { test: 't1' })])
    expect(status.detected.get(0)).toBe(MUTANT_KILLED)
  })

  it('wants a failure in another test than the lead seen twice', () => {
    const once = inspect([lead(0, 't1'), whole(0, 'failed', { test: 't2' })])
    expect(once.detected.has(0)).toBe(false)
    const twice = inspect([lead(0, 't1'), whole(0, 'failed', { test: 't2' }), whole(0, 'failed', { test: 't2', alone: true })])
    expect(twice.detected.get(0)).toBe(MUTANT_KILLED)
  })

  it('has a file run alone once a run failed and another of the same mutant passed, and drops what ran side by side', () => {
    const status = inspect([
      // Another mutant, failed twice while runs of the file were side by side.
      whole(1, 'failed', { test: 't2' }),
      whole(1, 'failed', { test: 't2' }),
      // And one that passed side by side, which says as little.
      whole(2, 'passed'),
      whole(0, 'failed', { test: 't2' }),
      whole(0, 'passed', { alone: true }),
    ])
    expect([...status.exclusive]).toEqual([file])
    expect(status.flaky.size).toBe(0)
    expect(status.detected.size).toBe(0)
    expect(status.whole.get(`0\n${file}`)?.passed).toBe(1)
    expect(status.whole.get(`2\n${file}`)?.passed).toBe(0)
  })

  it('leaves out only a test that fails and passes with no other run of the file under way', () => {
    const status = inspect([
      whole(0, 'failed', { test: 't2', alone: true }),
      whole(0, 'passed', { alone: true }),
      whole(1, 'failed', { test: 't2', alone: true }),
      whole(1, 'failed', { test: 't2', alone: true }),
    ])
    expect([...status.flaky]).toEqual(['t2'])
    expect(status.detected.size).toBe(0)
  })

  it('stops believing copies of a file two of them failed with no mutant on', () => {
    const control = (verdict: 'failed' | 'passed'): SessionRecord =>
      ({ type: 'control', file, verdict, by: 'copied after load', at: at++ }) as SessionRecord
    const runs = [whole(0, 'failed', { test: 't1' }), whole(0, 'failed', { test: 't1' })]
    expect(inspect([...runs, control('failed')]).detected.get(0)).toBe(MUTANT_KILLED)
    const status = inspect([...runs, control('failed'), control('failed')])
    expect(status.detected.size).toBe(0)
    expect(status.uncopied.has(file)).toBe(true)
    expect(status.plain.has(`0\n${file}`)).toBe(true)
  })
})
