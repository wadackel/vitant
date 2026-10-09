import { expect, it } from 'vitest'
import { ceiling, clamp, floor } from '../src/limit'

it('keeps what was worked out while the module loaded', () => {
  expect(floor).toBe(1)
  expect(ceiling).toBe(10)
})

it('clamps', () => {
  expect(clamp(11, 10)).toBe(10)
  expect(clamp(3, 10)).toBe(3)
})
