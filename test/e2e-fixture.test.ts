import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2E } from './helpers/e2e.ts'

const owners: ReturnType<typeof createE2E>[] = []
const owner = () => {
  const run = createE2E('ownership')
  owners.push(run)
  return run
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const run of owners.splice(0)) {
    run.cleanup()
    fs.rmSync(run.reports, { recursive: true, force: true })
  }
})

describe('e2e fixture ownership', () => {
  it('gives two runs separate sources, mutable node_modules and reports', () => {
    const first = owner()
    const second = owner()
    const a = first.fixture('clock')
    const b = second.fixture('clock')
    expect(a).not.toBe(b)
    expect(first.fixture('clock')).toBe(a)
    expect(first.reportPath('clock')).not.toBe(second.reportPath('clock'))
    expect(fs.existsSync(path.join(a, 'node_modules'))).toBe(false)
    fs.mkdirSync(path.join(a, 'node_modules/.vitant/session'), { recursive: true })
    fs.writeFileSync(path.join(a, 'node_modules/.vitant/session/owned'), 'first')
    fs.appendFileSync(path.join(a, 'src/stamp.ts'), '\nthrow new Error("first only")\n')
    expect(fs.readFileSync(path.join(b, 'src/stamp.ts'), 'utf8')).not.toContain('first only')
    expect(fs.existsSync(path.join(b, 'node_modules/.vitant/session/owned'))).toBe(false)
    fs.writeFileSync(second.reportPath('clock'), '{}')
    first.cleanup()
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(true)
    expect(fs.existsSync(second.reportPath('clock'))).toBe(true)
  })

  it('keeps failure output and session records after cleaning the fixture', () => {
    const run = owner()
    const fixture = run.fixture('clock')
    const records = path.join(fixture, 'node_modules/.vitant/session/results')
    fs.mkdirSync(records, { recursive: true })
    fs.writeFileSync(path.join(records, 'worker.jsonl'), '{"type":"whole"}\n')
    const error = Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' })
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 123, output: [], stdout: Buffer.from('before the timeout'), stderr: Buffer.from('worker stalled'),
      status: null, signal: 'SIGTERM', error,
    })
    const result = run.tool(['--root', fixture], { timeout: 1 })
    expect(result.error).toBe(error)
    run.cleanup()
    expect(fs.readFileSync(path.join(run.reports, 'run-1.log'), 'utf8')).toContain('worker stalled')
    expect(fs.readFileSync(path.join(run.reports, 'run-1-records/worker.jsonl'), 'utf8')).toContain('whole')
    const observed = JSON.parse(fs.readFileSync(path.join(run.reports, 'runs.jsonl'), 'utf8'))
    expect(observed).toMatchObject({ root: fixture, status: null, signal: 'SIGTERM' })
    expect(observed.end).toBeGreaterThanOrEqual(observed.start)
  })

  it('passes a failing exit through and removes the test runner environment', () => {
    const run = owner()
    const fixture = run.fixture('clock')
    const spawn = vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 123, output: [], stdout: Buffer.from('a failure'), stderr: Buffer.from(''), status: 7, signal: null,
    })
    const result = run.tool(['--root', fixture], { env: { NODE_ENV: 'test', TEST: '1', VITEST_POOL_ID: '2', KEEP: 'yes' } })
    expect(result.status).toBe(7)
    expect(spawn.mock.calls[0][2]).toMatchObject({ env: { KEEP: 'yes' } })
    expect(spawn.mock.calls[0][2]?.env).not.toHaveProperty('NODE_ENV')
    expect(spawn.mock.calls[0][2]?.env).not.toHaveProperty('VITEST_POOL_ID')
    expect(fs.readFileSync(path.join(run.reports, 'run-1.log'), 'utf8')).toContain('a failure')
  })
})
