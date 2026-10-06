import { expect, it } from 'vitest'
import { bump } from '../src/again'

let runs = 0

// Only the second of the runs the test asks for looks at the result.
it('bumps on every run', { repeats: 1 }, () => {
  if (runs++ > 0) expect(bump(1)).toBe(2)
})

let tries = 0

// Only the retry gets as far as the call.
it('bumps once it gets through', { retry: 1 }, () => {
  if (tries++ === 0) throw new Error('not yet')
  expect(bump(2)).toBe(3)
})
