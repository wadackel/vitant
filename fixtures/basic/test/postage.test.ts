import { expect, it } from 'vitest'
import { postage } from '../src/postage'

it('charges something for a letter', () => {
  expect(postage(20)).toBeGreaterThan(0)
})

// Where the rates server cannot be reached this test fails with no mutant on,
// before it reaches any code: what it would do with one is not known.
it('charges more for a parcel', () => {
  if (process.env.POSTAGE_RATES_DOWN) throw new Error('connect ECONNREFUSED 127.0.0.1:8080')
  expect(postage(101)).toBe(3)
  expect(postage(100)).toBe(1)
})
