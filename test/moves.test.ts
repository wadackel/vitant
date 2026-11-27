import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defaultSet, type Job, jobsOf, moveOf, movesBetween, planSlots } from '../bench/moves.ts'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-moves-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it('tells a move between detected and undetected from the benign ones and from those without a verdict', () => {
  expect(moveOf('Killed', 'Killed')).toBeUndefined()
  expect(moveOf('Killed', 'Survived')).toBe('detection')
  expect(moveOf('NoCoverage', 'Timeout')).toBe('detection')
  expect(moveOf('Timeout', 'Killed')).toBe('killed or timeout')
  expect(moveOf('Survived', 'NoCoverage')).toBe('survived or no coverage')
  expect(moveOf('Killed', 'Static')).toBe('without a verdict')
  expect(moveOf('Unconfirmed', 'Survived')).toBe('without a verdict')
  expect(moveOf('Survived', 'Pending')).toBe('without a verdict')
})

it('plans a job a shard, with base and head in two where a scope is run apart', () => {
  const jobs = jobsOf([
    { target: 'n8n', scope: 'proxy', shards: 1, runner: 'ubuntu-24.04', path: 'copies', apart: true },
    { target: 'h3', scope: 'utils', shards: 2, runner: 'ubuntu-24.04', path: 'no-clone' },
  ])
  expect(jobs.map((job) => [job.artifact, job.shard, job.tools])).toEqual([
    ['compare-n8n-proxy-ubuntu-24.04-copies-base-1of1', '1/1', 'vitant-base'],
    ['compare-n8n-proxy-ubuntu-24.04-copies-head-1of1', '1/1', 'vitant'],
    ['compare-h3-utils-ubuntu-24.04-no-clone-1of2', '1/2', 'vitant-no-clone-base,vitant-no-clone'],
    ['compare-h3-utils-ubuntu-24.04-no-clone-2of2', '2/2', 'vitant-no-clone-base,vitant-no-clone'],
  ])
  const all = jobsOf(planSlots('', true))
  expect(new Set(all.map((job) => job.artifact)).size).toBe(all.length)
  expect(jobsOf(planSlots('', false)).every((job) => job.runner === 'ubuntu-24.04')).toBe(true)
  expect(planSlots('', true)).toEqual(defaultSet)
})

it('plans the scopes given in place of the set, and refuses one the benchmark does not have', () => {
  expect(planSlots(' ufo:all  n8n:proxy:3 ', true)).toEqual([
    { target: 'ufo', scope: 'all', shards: 1, runner: 'ubuntu-24.04', path: 'copies' },
    { target: 'n8n', scope: 'proxy', shards: 3, runner: 'ubuntu-24.04', path: 'copies' },
  ])
  expect(() => planSlots('ufo:nothing', false)).toThrow('no scope ufo nothing')
  expect(() => planSlots('ufo:all:0', false)).toThrow('shards must be a whole number above 0')
})

const mutant = (file: string, line: number, status: string, end = 5) => ({
  id: 0, file, mutator: 'BooleanLiteral', replacement: 'false', status, static: false, coveredBy: 1, killedBy: 0,
  location: { start: { line, column: 4 }, end: { line, column: end } },
})

function report(index: number, count: number, mutants: ReturnType<typeof mutant>[]) {
  const counts = { Killed: 0, Survived: 0, Unconfirmed: 0, Led: 0, Timeout: 0, NoCoverage: 0, Static: 0, Pending: 0 } as Record<string, number>
  for (const { status } of mutants) counts[status]++
  return {
    mutants, counts, shard: { index, count }, vitestVersion: '5.1.0',
    timings: { generateMs: 1, compareMs: 1, vitestMs: 1, totalMs: 1 }, testFiles: 1, tests: 1,
    failedBaselines: [], neverPassedTests: [], flakyTests: [], leftOut: { projects: {}, typeTests: 0, browserTests: 0 },
    quietRuns: { failed: 0, passed: 0 }, exclusiveFiles: [], unsureFiles: [], changedFiles: [], removedTempDirs: [],
    nonRepeatableTests: [], suiteErrors: [], abandonedFiles: [], rounds: 1,
    wholeRuns: { started: 1, 'copied before load': 0, 'copied while loading': 0, 'copied after load': 2, 'copied before a test': 0, lost: 0 },
    work: { trials: 3, trialCpuMs: 1, wholeMs: { passed: 1, detected: 1 }, workers: 1 }, unplaced: 0, skippedFiles: [],
  }
}

/** Writes what a job of the compare workflow uploads: its summary and each tool's report. */
function job(entry: Job, reports: Record<string, ReturnType<typeof report>>, exitCode = 0) {
  const at = path.join(dir, entry.artifact)
  fs.mkdirSync(at, { recursive: true })
  const timings = Object.fromEntries(Object.keys(reports).map((tool) => [tool, { seconds: [10], exitCodes: [exitCode] }]))
  fs.writeFileSync(path.join(at, 'summary.json'), JSON.stringify({ machine: { cpu: 'Test CPU' }, timings }))
  for (const [tool, made] of Object.entries(reports)) fs.writeFileSync(path.join(at, `${tool}.json`), JSON.stringify(made))
}

function check(jobs: Job[]) {
  const plan = path.join(dir, 'jobs.json')
  fs.writeFileSync(plan, JSON.stringify(jobs))
  return spawnSync(process.execPath, [path.join(import.meta.dirname, '../bench/moves.ts'), 'check', '--plan', plan, dir], { encoding: 'utf8' })
}

// A target with no stored ground truth, so that only the two commits are held against each other.
const slot = { target: '.moves-test', scope: 'scope', shards: 2, runner: 'ubuntu-24.04', path: 'copies' } as const

it('lists every moved mutant of the merged shares and fails on a move between detected and undetected', () => {
  const [first, second] = jobsOf([slot])
  job(first, {
    'vitant-base': report(1, 2, [mutant('a.ts', 1, 'Killed'), mutant('a.ts', 1, 'Survived', 9)]),
    vitant: report(1, 2, [mutant('a.ts', 1, 'Timeout'), mutant('a.ts', 1, 'Survived', 9)]),
  })
  // The head deals b.ts to the other share: shares are compared merged, not one by one.
  job(second, {
    'vitant-base': report(2, 2, [mutant('b.ts', 2, 'Survived'), mutant('c.ts', 3, 'Survived')]),
    vitant: report(2, 2, [mutant('c.ts', 3, 'NoCoverage')]),
  })
  fs.writeFileSync(path.join(dir, first.artifact, 'vitant.json'), JSON.stringify(report(1, 2, [mutant('a.ts', 1, 'Timeout'), mutant('a.ts', 1, 'Survived', 9), mutant('b.ts', 2, 'Killed')])))
  const run = check([first, second])
  expect(run.status, run.stderr).toBe(1)
  expect(run.stdout).toContain('**1 mutant(s) moved between detected and undetected; 0 other problem(s).**')
  expect(run.stdout).toContain('- b.ts:2:5 BooleanLiteral `false`: Survived → Killed')
  expect(run.stdout).toContain('Between Killed and Timeout, benign: 1')
  expect(run.stdout).toContain('- a.ts:1:5 BooleanLiteral `false`: Killed → Timeout')
  expect(run.stdout).toContain('Between Survived and NoCoverage, which the suite passes alike: 1')
  expect(run.stdout).not.toContain('a.ts:1:5 BooleanLiteral `false`: Survived')
  expect(run.stdout).toContain('| vitant | Killed 1, Survived 1, Timeout 1, NoCoverage 1 | 6 whole-file runs, 6 trials | 10 s | Test CPU | no ground truth stored |')
})

it('lists apart a move of a mutant whose verdict the stored ground truth explains', () => {
  const base = report(1, 1, [mutant('a.ts', 1, 'Survived'), mutant('a.ts', 2, 'Survived')])
  const head = report(1, 1, [mutant('a.ts', 1, 'Timeout'), mutant('a.ts', 2, 'Timeout')])
  const explained = new Set([JSON.stringify(['a.ts', 1, 4, 1, 5, 'BooleanLiteral', 'false'])])
  expect(movesBetween(base, head, explained).moved.map(({ mutant, move }) => [mutant.location.start.line, move])).toEqual([[1, 'explained'], [2, 'detection']])
})

it('passes where only benign moves happened, and fails where a share or a run is missing', () => {
  const [first, second] = jobsOf([slot])
  job(first, { 'vitant-base': report(1, 2, [mutant('a.ts', 1, 'Killed')]), vitant: report(1, 2, [mutant('a.ts', 1, 'Timeout')]) })
  job(second, { 'vitant-base': report(2, 2, [mutant('b.ts', 1, 'Static')]), vitant: report(2, 2, [mutant('b.ts', 1, 'Killed')]) })
  const benign = check([first, second])
  expect(benign.status, benign.stdout).toBe(0)
  expect(benign.stdout).toContain('No mutant moved between detected and undetected in 1 scope runs, and every report holds against the suite.')
  expect(benign.stdout).toContain('To or from a status without a verdict (Static, Unconfirmed, Led, Pending): 1')

  fs.rmSync(path.join(dir, second.artifact), { recursive: true })
  const missing = check([first, second])
  expect(missing.status).toBe(1)
  expect(missing.stdout).toContain(`**${second.name}: no results**`)
  expect(missing.stdout).toContain('Not compared: a share of one commit is missing.')

  job(second, { 'vitant-base': report(2, 2, [mutant('b.ts', 1, 'Static')]), vitant: report(2, 2, [mutant('b.ts', 1, 'Killed')]) }, 1)
  const failed = check([first, second])
  expect(failed.status).toBe(1)
  expect(failed.stdout).toContain(`**${second.name}: vitant exited with 1**`)
})
