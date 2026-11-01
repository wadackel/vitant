import { expect, test } from 'vitest'
import { label } from '../src/stamp'

const loadedAt = Date.now()

// Most mutants of `label` pass this file, so each copy made after it loads
// runs on to the next test, and with one worker the copies come one after
// another, each 300 ms after the one before it.
test('labels', async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
  label(2)
  label(5)
  label(20)
  expect(typeof label(1)).toBe('string')
})

test('is fresh', () => {
  expect(Date.now() - loadedAt).toBeLessThan(1500)
  expect(Number.isInteger(Date.now())).toBe(true)
})
