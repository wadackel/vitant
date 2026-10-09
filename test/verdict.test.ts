import { describe, expect, it } from 'vitest'
import { inspect, type SessionRecord } from '../src/run.ts'

const file = '/project/a.test.ts'
const MUTANT_KILLED = 1

let at = 0
const whole = (mutant: number, verdict: 'failed' | 'passed' | 'timeout', more: object = {}): SessionRecord =>
  ({ type: 'whole', file, mutant, verdict, by: 'copied after load', at: at++, ...more }) as SessionRecord

/** A test that failed with the mutant while trying it and passed again without it. */
const lead = (mutant: number, id: string, sole = true): SessionRecord =>
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
    sole,
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

  it('does not take a lead made next to other runs of the file for more than a hint', () => {
    const status = inspect([lead(0, 't1', false), whole(0, 'failed', { test: 't1' })])
    expect(status.suspects.get(0)?.has(file)).toBe(true)
    expect(status.detected.has(0)).toBe(false)
  })

  it('takes a run that went on past another failure to the test that gave the lead', () => {
    const status = inspect([lead(0, 't3'), whole(0, 'failed', { test: 't2', tests: ['t2', 't3'] })])
    expect(status.detected.get(0)).toBe(MUTANT_KILLED)
    // The lead's test ran and passed: the other failure stands alone.
    expect(inspect([lead(0, 't3'), whole(0, 'failed', { test: 't2', tests: ['t2'] })]).detected.has(0)).toBe(false)
  })

  it('takes nothing on the word of a test one of whose leads came to nothing', () => {
    const killed = [lead(0, 't1'), whole(0, 'failed', { test: 't1' })]
    expect(inspect(killed).detected.get(0)).toBe(MUTANT_KILLED)
    // The same test failed with another mutant too, and the file passed with that one.
    const status = inspect([...killed, lead(1, 't1'), whole(1, 'passed')])
    expect([...status.refuted]).toEqual(['t1'])
    expect(status.detected.has(0)).toBe(false)
    expect(inspect([...killed, lead(1, 't1'), whole(1, 'passed'), whole(0, 'failed', { test: 't1', alone: true, quiet: true })]).detected.get(0)).toBe(MUTANT_KILLED)
  })

  it('does not let a lead from one test vouch for the failure of another', () => {
    const runs = [lead(0, 't1'), whole(0, 'failed', { test: 't2' }), whole(0, 'failed', { test: 't2' })]
    expect(inspect(runs).detected.has(0)).toBe(false)
    // The test that failed tries the mutant, fails with it and passes without: its failure counts.
    expect(inspect([...runs, lead(0, 't2')]).detected.get(0)).toBe(MUTANT_KILLED)
    // Or one of the failures is made with nothing else running.
    expect(inspect([...runs, whole(0, 'failed', { test: 't2', alone: true, quiet: true })]).detected.get(0)).toBe(MUTANT_KILLED)
  })

  it('wants one of the failures made with nothing else running where no test ever failed on the mutant', () => {
    const runs = [whole(0, 'failed', { test: 't2' }), whole(0, 'failed', { test: 't2' })]
    expect(inspect(runs).detected.has(0)).toBe(false)
    expect(inspect([...runs, whole(0, 'failed', { test: 't2', alone: true, quiet: true })]).detected.get(0)).toBe(MUTANT_KILLED)
    const passed = inspect([...runs, whole(0, 'passed', { alone: true, quiet: true })])
    expect(passed.detected.has(0)).toBe(false)
    expect(passed.whole.get(`0\n${file}`)?.passed).toBe(1)
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

  it('lets a file run side by side again once only tests that fail and pass on their own had given it away', () => {
    const records = [
      whole(0, 'failed', { test: 't2' }),
      whole(0, 'passed', { alone: true }),
      // Another mutant, run side by side before the file was taken to be one to run alone.
      whole(2, 'passed'),
    ]
    expect([...inspect(records).exclusive]).toEqual([file])
    const released = [...records, whole(1, 'failed', { test: 't2', alone: true }), whole(1, 'passed', { alone: true })]
    const status = inspect(released)
    expect(status.exclusive.size).toBe(0)
    // What ran side by side before stays dropped; what runs side by side from here on counts.
    expect(status.whole.get(`2\n${file}`)?.passed).toBe(0)
    expect(inspect([...released, whole(2, 'passed')]).whole.get(`2\n${file}`)?.passed).toBe(1)
    // A failure that was no test's, or another test's, keeps it alone.
    const kept = inspect([...released, whole(3, 'failed', { test: 't3' }), whole(3, 'passed')])
    expect([...kept.exclusive]).toEqual([file])
  })

  it('leaves a test out for every mutant only once it failed and passed alone with mutants in two places', () => {
    const one = [whole(0, 'failed', { test: 't2', alone: true }), whole(0, 'passed', { alone: true })]
    const other = [whole(1, 'failed', { test: 't2', alone: true }), whole(1, 'failed', { test: 't2', alone: true, quiet: true })]
    // One mutant may have made the test a matter of chance; what the test fails for another still counts.
    expect(inspect([...one, ...other]).flaky.size).toBe(0)
    expect(inspect([...one, ...other]).detected.get(1)).toBe(MUTANT_KILLED)
    const two = [...one, whole(2, 'failed', { test: 't2', alone: true }), whole(2, 'passed', { alone: true })]
    // Mutants 0 and 2 at one place in the code are one observation, at two places two.
    expect(inspect([...two, ...other], [0, 1, 0]).flaky.size).toBe(0)
    const status = inspect([...two, ...other], [0, 1, 2])
    expect([...status.flaky]).toEqual(['t2'])
    expect(status.detected.size).toBe(0)
  })

  it('takes a timeout for the mutant having blocked a worker only in the same file', () => {
    const stall = (id: string) => ({ type: 'stall', id, mutant: 0, at: at++ }) as SessionRecord
    const seen = (id: string, where: string) => ({ ...lead(9, id), file: where, killed: [] }) as SessionRecord
    const timeout = whole(0, 'timeout')
    expect(inspect([seen('t1', file), stall('t1'), timeout]).detected.has(0)).toBe(true)
    expect(inspect([seen('t9', '/project/other.test.ts'), stall('t9'), timeout]).detected.has(0)).toBe(false)
  })

  it('asks for two unmutated runs at once where a mutant failed twice without a lead, and goes by them', () => {
    const pair = (verdict: 'failed' | 'passed', met = true): SessionRecord =>
      ({ type: 'pair', file, verdict, met, at: at++ }) as SessionRecord
    const runs = [whole(0, 'failed', { test: 't2' }), whole(0, 'failed', { test: 't2' })]
    expect([...inspect(runs).pairWanted]).toEqual([file])
    expect(inspect([lead(0, 't1'), whole(0, 'failed', { test: 't1' })]).pairWanted.size).toBe(0)

    const fine = inspect([...runs, pair('passed'), pair('passed'), whole(0, 'failed', { test: 't2', alone: true, quiet: true })])
    expect(fine.pairWanted.size).toBe(0)
    expect(fine.detected.get(0)).toBe(MUTANT_KILLED)

    // A run whose other half never came says nothing, and is asked for once more only.
    const asked = { type: 'pairing', file, at: at++ } as SessionRecord
    expect(inspect([...runs, asked, pair('failed', false)]).pairWanted.size).toBe(1)
    expect(inspect([...runs, asked, asked, pair('failed', false)]).pairWanted.size).toBe(0)

    const clash = inspect([...runs, pair('failed'), pair('passed')])
    expect([...clash.exclusive]).toEqual([file])
    expect(clash.detected.size).toBe(0)
    expect(clash.pairWanted.size).toBe(0)
  })

  it('stops believing copies of a file two of them failed with no mutant on', () => {
    const control = (verdict: 'failed' | 'passed'): SessionRecord =>
      ({ type: 'control', file, verdict, by: 'copied after load', at: at++ }) as SessionRecord
    const runs = [lead(0, 't1'), whole(0, 'failed', { test: 't1' })]
    expect(inspect([...runs, control('failed')]).detected.get(0)).toBe(MUTANT_KILLED)
    const status = inspect([...runs, control('failed'), control('failed')])
    expect(status.detected.size).toBe(0)
    expect(status.uncopied.has(file)).toBe(true)
    expect(status.plain.has(`0\n${file}`)).toBe(true)
  })
})
