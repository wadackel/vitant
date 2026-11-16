import { it } from 'vitest'
import { tip } from '../src/tip.ts'

// The test asks its own `expect`, the one of its context, for one assertion.
// Vitest counts the assertions there for as long as the test lives, so a test
// run again in the same worker counted two and failed with no mutant on.
it('adds a fifth for the tip', ({ expect }) => {
  expect.assertions(1)
  expect(tip(10)).toBe(2)
})
