import { describe, expect, it } from 'vitest'
import { doubts, inspect, type SessionRecord } from '../src/run.ts'

const file = '/project/a.test.ts'
const MUTANT_KILLED = 1
const MUTANT_TIMEOUT = 2

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

  it('takes a test that tried the mutant on its one run in a copy for a witness once it passed in a copy with none', () => {
    const copied = { ...lead(0, 't1'), copied: true } as SessionRecord
    const apart = (verdict: 'failed' | 'passed') => ({ type: 'apart', file, test: 't1', verdict, at: at++ }) as SessionRecord
    const runs = [whole(0, 'failed', { test: 't1' }), whole(0, 'failed', { test: 't1' })]
    expect(inspect([...runs, copied]).detected.has(0)).toBe(false)
    expect(inspect([...runs, copied, apart('passed')]).detected.get(0)).toBe(MUTANT_KILLED)
    // What a copy does to the test is not the mutant's doing.
    expect(inspect([...runs, copied, apart('failed')]).detected.has(0)).toBe(false)
    expect(inspect([...runs, copied, apart('passed'), apart('failed')]).detected.has(0)).toBe(false)
    // And such a test is found out like any other: by a mutant it fails with that its file passes with.
    const harmless = { ...lead(1, 't1'), copied: true } as SessionRecord
    expect(inspect([...runs, copied, apart('passed'), harmless, whole(1, 'passed')]).detected.has(0)).toBe(false)
    // A copy that did not get to say what the test did left word that it was asked, and no more.
    const untold = { ...lead(1, 't1'), copied: true, killed: [], suspected: [1] } as unknown as SessionRecord
    const told = inspect([...runs, copied, apart('passed'), untold, whole(1, 'passed')])
    expect(told.detected.get(0)).toBe(MUTANT_KILLED)
    expect(told.triedSole.get(1)?.has('t1')).toBe(true)
  })

  it('holds a second failure without the mutant against a test only where the test could have passed', () => {
    const again = (nonRepeatable: boolean) =>
      ({ ...lead(1, 't1', false), killed: [], suspected: [1], nonRepeatable }) as unknown as SessionRecord
    const killed = [lead(0, 't1'), whole(0, 'failed', { test: 't1' })]
    // Failed with a mutant, failed again without it, and the file passes with that mutant: the test fails as it pleases.
    expect(inspect([...killed, again(false), whole(1, 'passed')]).detected.has(0)).toBe(false)
    // Unless it is a test that fails any second run in a worker, which that is then all it shows.
    const status = inspect([...killed, again(true), whole(1, 'passed')])
    expect(status.refuted.size).toBe(0)
    expect(status.detected.get(0)).toBe(MUTANT_KILLED)
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

  it('does not count the failures of a test that failed and passed with another mutant', () => {
    // With mutant 0 the test failed a run of its file and not the next: it can fail by chance.
    const chance = [whole(0, 'failed', { test: 't2' }), whole(0, 'passed', { alone: true, quiet: true })]
    // The file is run one process at a time from there on, and only such runs count.
    const runs = [whole(1, 'failed', { test: 't2', alone: true }), whole(1, 'failed', { test: 't2', alone: true, quiet: true })]
    expect(inspect(runs).detected.get(1)).toBe(MUTANT_KILLED)
    const status = inspect([...chance, ...runs])
    expect(status.detected.has(1)).toBe(false)
    expect([...(status.doubted.get(1) ?? [])]).toEqual(['t2'])
    // It stays in the runs: a mutant may be what made it a matter of chance.
    expect([...status.flaky]).toEqual([])
    // Whenever that came out.
    expect(inspect([...runs, ...chance]).detected.has(1)).toBe(false)
    // What it fails after failing with the mutant while trying it, and passing without, counts.
    expect(inspect([...chance, ...runs, lead(1, 't2')]).detected.get(1)).toBe(MUTANT_KILLED)
    // So does a run in which a test failed that never did such a thing.
    const both = whole(1, 'failed', { tests: ['t2', 't3'], test: 't2', alone: true, quiet: true })
    expect(inspect([...chance, ...runs, both, both]).detected.get(1)).toBe(MUTANT_KILLED)
  })

  it('does not count runs a limit ended in a file where such a run passed another time', () => {
    // The limit ends whichever test is running, so the test named says nothing here.
    const chance = [whole(0, 'timeout', { test: 't3' }), whole(0, 'passed', { alone: true, quiet: true })]
    const runs = [whole(1, 'timeout', { test: 't4', alone: true }), whole(1, 'timeout', { test: 't4', alone: true, quiet: true })]
    expect(inspect(runs).detected.get(1)).toBe(MUTANT_TIMEOUT)
    const status = inspect([...chance, ...runs])
    expect(status.detected.has(1)).toBe(false)
    expect([...(status.doubted.get(1) ?? [])]).toEqual([file])
    // A failure of a test is no such run.
    const failures = [whole(1, 'failed', { test: 't4', alone: true }), whole(1, 'failed', { test: 't4', alone: true, quiet: true })]
    expect(inspect([...chance, ...failures]).detected.get(1)).toBe(MUTANT_KILLED)
    // A mutant that had blocked a worker under a test of the file is what the limit ended.
    const stall = { type: 'stall', id: 't4', mutant: 1, at: at++ } as SessionRecord
    expect(inspect([...chance, ...runs, { ...lead(9, 't4'), killed: [] } as SessionRecord, stall]).detected.get(1)).toBe(MUTANT_TIMEOUT)
  })

  it('takes nothing from a test that fails with no mutant on and nothing else running', () => {
    const calm = (verdict: 'failed' | 'passed', tests: string[] = []): SessionRecord =>
      ({ type: 'calm', file, verdict, tests, at: at++ }) as SessionRecord
    const runs = [whole(0, 'failed', { test: 't2' }), whole(0, 'failed', { test: 't2' }), whole(0, 'failed', { test: 't2', alone: true, quiet: true })]
    expect(inspect([...runs, calm('passed')]).detected.get(0)).toBe(MUTANT_KILLED)
    // The file fails in that test by itself where the machine has nothing else to do: so it did with the mutant.
    const status = inspect([...runs, calm('passed'), calm('failed', ['t2'])])
    expect(status.detected.has(0)).toBe(false)
    expect([...status.flaky]).toEqual(['t2'])
    // Whenever that came out, and also for what the test had shown as a witness.
    expect(inspect([calm('failed', ['t2']), lead(0, 't2'), whole(0, 'failed', { test: 't2' })]).detected.has(0)).toBe(false)
    // A failure in another test stands.
    expect(inspect([...runs, calm('failed', ['t9'])]).detected.get(0)).toBe(MUTANT_KILLED)
    // With no test to name, nothing the file's failures say counts.
    const restless = inspect([...runs, calm('failed')])
    expect(restless.detected.has(0)).toBe(false)
    expect([...restless.restless]).toEqual([file])
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
    // One mutant may have made the test a matter of chance: it stays in the runs, and what it alone fails is not counted.
    expect(inspect([...one, ...other]).flaky.size).toBe(0)
    expect(inspect([...one, ...other]).detected.has(1)).toBe(false)
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

  it('asks for two unmutated runs at once where a mutant failed without a lead, and goes by them', () => {
    const pair = (verdict: 'failed' | 'passed', met = true): SessionRecord =>
      ({ type: 'pair', file, verdict, met, at: at++ }) as SessionRecord
    const runs = [whole(0, 'failed', { test: 't2' })]
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

describe('tests that leave a mutant open', () => {
  type Tests = Parameters<typeof doubts>[0]['tests']
  const test = (name: string, covered: number[], pristine = true) =>
    ({ file, name, pristine, coverage: { sites: 1, covered, cleanup: [], baselineMs: 1, baselineLoops: 0, rss: 0 } }) as unknown as Tests extends Map<string, infer State> ? State : never
  const label = (state: { name: string }) => state.name

  it('names a test left out for failing by itself for the mutants it reaches, and for all where that is not known', () => {
    const tests: Tests = new Map([
      ['t1', test('t1', [0, 2])],
      ['t2', test('t2', [1])],
      ['t3', test('t3', [1], false)],
    ])
    const reached = doubts({ flaky: new Set(['t1']), tests }, [], label)
    expect([...reached.leftOutOf]).toEqual([
      [0, ['t1']],
      [2, ['t1']],
    ])
    expect(reached.everywhere).toEqual([])
    expect(doubts({ flaky: new Set(['t3']), tests }, [], label).everywhere).toEqual(['t3'])
  })

  it('names a test that failed a run of its file with a mutant it reaches, and not one that does not reach it', () => {
    const tests: Tests = new Map([
      ['t1', test('t1', [0])],
      ['t2', test('t2', [1])],
    ])
    const runs = [whole(0, 'failed', { test: 't1', tests: ['t1', 't2'] }), whole(0, 'passed'), whole(1, 'passed')]
    const { waveredIn } = doubts({ flaky: new Set(), tests }, runs, label)
    expect([...waveredIn].map(([mutant, names]) => [mutant, [...names]])).toEqual([[0, ['t1']]])
  })
})
