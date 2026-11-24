import { expect, it } from 'vitest'
import { held, steady } from '../src/steady'

// The same test fails every run of the file with a mutant of `steady` on.
it('holds steady', () => {
  expect(typeof steady()).not.toBe('symbol')
  expect(held).toBe(true)
})
