import { beforeEach, expect, it } from 'vitest'
import { increment, later, reset } from '../src/counter.ts'

beforeEach(() => {
  reset()
})

it('increments by one', () => {
  expect(increment()).toBe(1)
  expect(increment()).toBe(2)
})

it('increments by a step', () => {
  expect(increment(5)).toBe(5)
})

it('doubles later', async () => {
  expect(await later(4)).toBe(8)
})
