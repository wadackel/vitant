import { execFileSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { expect, test } from 'vitest'
import { label } from '../src/stamp'

// A child process and a worker thread read the machine's clock, as
// isolated-vm's isolates do in n8n's tests. In a run of the suite it agrees
// with this process's; in a copy made after the copies of `label`'s
// mutants, this process's clock leaves out the time they took.
test('labels', async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
  label(2)
  label(5)
  label(20)
  expect(typeof label(1)).toBe('string')
})

test('agrees with a child process on the time', () => {
  const before = Date.now()
  const at = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(Date.now()))'], { encoding: 'utf8' }))
  expect(at).toBeGreaterThanOrEqual(before)
  expect(at).toBeLessThanOrEqual(Date.now())
})

test('agrees with a worker thread on the time', async () => {
  const before = Date.now()
  const worker = new Worker("require('node:worker_threads').parentPort.postMessage(Date.now())", { eval: true })
  const at = await new Promise<number>((resolve) => worker.once('message', resolve))
  await worker.terminate()
  expect(at).toBeGreaterThanOrEqual(before)
  expect(at).toBeLessThanOrEqual(Date.now())
})
