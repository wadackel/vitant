import { afterEach, expect, it } from 'vitest'
import { acquire, leaked, release } from '../src/pool'

// `release` and `leaked` run in the hook alone: what a mutant does to them
// shows in no test's own run, only in the hook after it or in the next test.
afterEach(() => {
  release()
  expect(leaked()).toBe(false)
})

it('hands out the first slot', () => {
  expect(acquire()).toBe(1)
})

it('hands out the first slot again once it is back', () => {
  expect(acquire()).toBe(1)
})
