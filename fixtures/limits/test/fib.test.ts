import { expect, it } from 'vitest'
import { fib } from '../src/fib'

// Without the memo the test keeps the processor busy for a second or more,
// well within the minute the project gives a test: the suite passes.
it('counts rabbits', () => {
  expect(fib(37)).toBe(24157817)
})
