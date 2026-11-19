import { expect, it } from 'vitest'
import { box } from '../src/box.js'

// Holds only for the function as the plugin compiles it.
it('gives the same box for the same value', () => {
  expect(box(1)).toBe(box(1))
  expect(box(2).value).toBe(2)
})
