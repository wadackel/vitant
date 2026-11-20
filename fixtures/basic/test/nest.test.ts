import { expect, it } from 'vitest'
import { closed, nested } from '../src/nest'

// Passes with a mutant that leaves a level open, or closes one too many.
it('returns what the work returns', () => {
  expect(nested(() => 2)).toBe(2)
})

// Waits as a scheduler would for the levels to close. After a try of this
// file's first test has left one open, this test never ends with no mutant
// on, and the loop is the test's own, which nothing of the tool counts.
it(
  'finds every level closed',
  () => {
    while (!closed()) {}
    expect(closed()).toBe(true)
  },
  100,
)
