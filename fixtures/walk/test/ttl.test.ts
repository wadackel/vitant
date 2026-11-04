import { expect, test } from 'vitest'
import { get, put } from '../src/ttl'

// The first test notes the time; the second reads it back within half a
// second. Copies made one after another before the second test, each
// taking the third test's 150 ms, start later and later.
test('puts', () => {
  put('a', 1)
})

test('gets it while it is fresh', () => {
  expect(get('a', 500)).toBe(1)
  expect(get('b', 500)).toBeUndefined()
})

test('waits', async () => {
  await new Promise((resolve) => setTimeout(resolve, 150))
})
