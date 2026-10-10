import { afterEach, expect, it } from 'vitest'
import { count, note, reset, total } from '../src/tally'

// Goes through more of the source than any other file and so is the nearest
// to its mutants, and has one test, which nothing left behind can fail.
afterEach(() => {
  reset()
})

it('adds up what was noted', () => {
  note(2)
  note(3)
  expect(total()).toBe(5)
  expect(count()).toBe(2)
})
