import { expect, it } from 'vitest'
import { admittedRecords, doubts, incompleteConfirmations, inspect, planRound, type SessionRecord } from '../src/run.ts'

const waiting = '/project/waiting.test.ts'
const busy = '/project/busy.test.ts'

function records(): SessionRecord[] {
  return [
    ...[waiting, busy].map((file, mutant) => ({
      type: 'file', file, tests: [file], staticSites: mutant === 0 ? [0] : [], complete: true, at: 0,
    }) as SessionRecord),
    ...[waiting, busy].map((file, mutant) => ({
      type: 'test', file, id: file, name: file, mode: 'probe', baseline: 'pass',
      baselineMs: 1, baselineLoops: 1, baselineRetry: false, nonRepeatable: false,
      needsReplay: false, replayed: true, pristine: true, sole: true,
      ms: 1, cpuMs: 1, attempts: mutant === 0 ? 1 : 0, sites: [mutant], covered: [mutant],
      cleanup: [], killed: [], timedOut: mutant === 0 ? [0] : [], timeoutCauses: mutant === 0 ? ['loop'] : [],
      survived: [], unverified: [], at: 1,
    }) as SessionRecord),
    { type: 'whole', file: waiting, mutant: 0, verdict: 'timeout', knew: true, by: 'started', at: 2 } as SessionRecord,
    ...[3, 4].map((at) => ({ type: 'pair', file: waiting, verdict: 'passed', met: true, at }) as SessionRecord),
  ]
}

function next(edit: (status: ReturnType<typeof inspect>) => void = () => {}, eligible = new Set([waiting, busy])) {
  const status = inspect(records())
  edit(status)
  return planRound(status, new Uint8Array([0, 0]), [waiting, busy], new Map(), [0, 1], [0, 0], eligible)
}

it('confirms one idle loading timeout alongside ordinary work with its calm controls and file lock', () => {
  const result = next()
  expect(result.plan.quiet).toBe(false)
  expect(result.plan.settling).toBe(false)
  expect(result.plan.tests[busy]).toBeDefined()
  expect(result.plan.exclusive).toContain(waiting)
  const jobs = result.plan.whole[waiting]
  expect(jobs.filter((job) => job.calm)).toHaveLength(3)
  expect(jobs.filter((job) => job.mutant === 0)).toMatchObject([{ quiet: true, plain: true }])
  expect(result.workByFile.get(waiting)?.wholeRuns).toBe(4)
})

it.each(['exclusive', 'restless', 'uncopied', 'unhanded', 'lost', 'unpaused', 'pairWanted'] as const)('leaves %s files on the existing path', (field) => {
  const result = next((status) => status[field].add(waiting))
  expect(result.plan.whole[waiting]?.some((job) => job.quiet)).not.toBe(true)
})

it('keeps confirmation pending when any ordinary file cannot use mixed isolation', () => {
  expect(next(() => {}, new Set([waiting])).plan.whole[waiting]).toBeUndefined()
})

it('does not substitute an idle file for the cheapest busy confirming file', () => {
  const result = next((status) => {
    status.suspects.get(0)!.add(busy)
    status.fileWall.set(waiting, 10)
    status.whole.set(`0\n${busy}`, { ...status.whole.get(`0\n${waiting}`)! })
  })
  expect(result.plan.whole[waiting]).toBeUndefined()
})

it('leaves a named failure and outstanding witness to the existing settling path', () => {
  const result = next((status) => {
    status.evidence.get(0)!.push({ file: waiting, test: waiting, kind: 'failed' })
    status.beside.set(0, new Set([waiting]))
  })
  expect(result.plan.whole[waiting]?.some((job) => job.quiet)).not.toBe(true)
})

it('keeps the baseline schedule when early work is disabled', () => {
  expect(next(() => {}, new Set()).plan.whole[waiting]).toBeUndefined()
})

it.each([false, true])('rejects incomplete early evidence while preserving physical counts (synthetic: %s)', (synthetic) => {
  const confirmation = { type: 'whole', file: waiting, mutant: 0, verdict: 'timeout', alone: true, quiet: true, group: 2, by: 'started', at: 5, ...(synthetic ? {} : { ms: 15, pid: 123 }) } as SessionRecord
  const rows = [...records(), confirmation]
  expect(inspect(rows).detected.has(0)).toBe(true)
  const missing = incompleteConfirmations(rows, [{ file: waiting, group: 2 }])
  expect(missing).toEqual([{ type: 'uncalm', file: waiting, group: 2 }])
  rows.push(...missing.map((record) => ({ ...record, at: 6 })))
  const status = inspect(rows)
  expect(status.detected.has(0)).toBe(false)
  expect(status.whole.get(`0\n${waiting}`)?.runs).toBe(2)
  expect(status.earlyExcluded.has(waiting)).toBe(true)
  expect(rows.filter((record) => record.type === 'whole')).toHaveLength(2)
  if (!synthetic) expect(status.wholeTook.get(waiting)).toEqual({ ms: 15, runs: 1 })
})

it('requires three controls from the same file and group, leaving control failure interpretation intact', () => {
  const calms = [0, 1, 2].map((n) => ({ type: 'calm', file: waiting, group: 3, verdict: n === 2 ? 'failed' : 'passed', at: n + 5 }) as SessionRecord)
  expect(incompleteConfirmations(calms.slice(0, 2), [{ file: waiting, group: 3 }])).toHaveLength(1)
  expect(incompleteConfirmations(calms, [{ file: waiting, group: 3 }])).toEqual([])
  expect(incompleteConfirmations(calms, [{ file: busy, group: 3 }])).toHaveLength(1)
  expect(incompleteConfirmations(calms, [{ file: waiting, group: 4 }])).toHaveLength(1)
})

it('does not expose a rejected named failure to later doubt reporting', () => {
  const rejected = { type: 'whole', file: waiting, mutant: 0, verdict: 'failed', test: waiting, by: 'started', quiet: true, group: 2, at: 5 } as SessionRecord
  const passed = { type: 'whole', file: waiting, mutant: 0, verdict: 'passed', by: 'started', alone: true, quiet: true, at: 7 } as SessionRecord
  const rows = [...records(), rejected, { type: 'uncalm', file: waiting, group: 2, at: 6 } as SessionRecord, passed]
  expect(admittedRecords(rows)).not.toContain(rejected)
  expect(admittedRecords(rows)).toContain(passed)
  expect(inspect(rows).whole.get(`0\n${waiting}`)).toMatchObject({ runs: 3, passed: 1, quiet: 0 })
  expect(doubts(inspect(rows), rows, (test) => test.name).waveredIn.size).toBe(0)
  const unchecked = rows.filter((record) => record.type !== 'uncalm')
  expect(doubts(inspect(unchecked), unchecked, (test) => test.name).waveredIn.size).toBeGreaterThan(0)
})
