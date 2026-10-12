import { expect, it } from 'vitest'
import { span } from '../src/span'

// Worked out while the file loads: with a mutant that makes this throw, the
// file fails with no test to name, though each of the tests fails with it.
const minute = span('1 minutes')

it('reads two minutes', () => {
  expect(span('2 minutes')).toBe(2 * minute)
})

it('reads three minutes', () => {
  expect(span('3 minutes')).toBe(3 * minute)
})

it('reads four minutes', () => {
  expect(span('4 minutes')).toBe(4 * minute)
})

it('reads five minutes', () => {
  expect(span('5 minutes')).toBe(5 * minute)
})

it('reads seconds', () => {
  expect(span('90 seconds')).toBe(90)
})
