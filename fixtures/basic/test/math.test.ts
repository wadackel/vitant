import { describe, expect, it } from 'vitest'
import { clamp, isEven, sum } from '../src/math.ts'

describe('clamp', () => {
  it('returns the lower bound', () => {
    expect(clamp(-5)).toBe(0)
  })

  it('returns the upper bound', () => {
    expect(clamp(50)).toBe(10)
  })

  it('keeps a value in range', () => {
    expect(clamp(5)).toBe(5)
  })
})

it('sums values', () => {
  expect(sum([1, 2, 3])).toBe(6)
})

it('checks evenness loosely', () => {
  expect(typeof isEven(2)).toBe('boolean')
})
