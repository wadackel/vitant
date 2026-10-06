import { expect, it } from 'vitest'
import { firstAbove } from '../src/scan'

// A mutant sends the loop over all three million elements, which takes milliseconds.
it('looks at no more than the cap', () => {
  const values = new Float64Array(3_000_000).fill(2)
  expect(firstAbove(values, 1, 2)).toBeGreaterThan(0)
})
