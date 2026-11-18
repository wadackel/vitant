import { afterAll, expect, test } from 'vitest'
import { now } from '../src/asked'
import { label } from '../src/stamp'

// A mutant that makes `now` ask a child process reads the machine's clock,
// which agrees with this process's in a run of the suite. In a copy made
// after the copies of `label`'s mutants, this process's clock leaves out
// the time they took, and the child's is that much later. Only the hook
// reaches `now`, so no test tries its mutants and the file's unmutated runs
// start no process: only a run of the whole file with the mutant meets it.
test('labels', async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
  label(2)
  label(5)
  label(20)
  expect(typeof label(1)).toBe('string')
})

afterAll(() => {
  const before = Date.now()
  const at = now(false)
  expect(at).toBeGreaterThanOrEqual(before)
  expect(at).toBeLessThanOrEqual(Date.now())
})
