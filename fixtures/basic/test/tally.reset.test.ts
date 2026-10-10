import { afterEach, expect, it } from 'vitest'
import { note, reset, total } from '../src/tally'

// The one file that fails when `reset` does nothing, and in its hook, where
// no test trying the mutant sees it: a run limited to the nearest file passes.
afterEach(() => {
  reset()
  expect(total()).toBe(0)
})

it('counts from nothing', () => {
  note(1)
  expect(total()).toBe(1)
})
