import { expect, it } from 'vitest'
import { fill } from '../src/fill'

// With `target` made endless the loop pushes until the array cannot grow,
// a RangeError past a gigabyte in well under a second, which `fill` catches:
// the suite passes. A test's own try of the mutant ends the loop by its
// count, so only the run of the file holds that memory.
it('fills', () => {
  expect(fill([], 5)).toBe(true)
})
