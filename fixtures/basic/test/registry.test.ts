import { beforeEach, expect, it } from 'vitest'
import { double, max, setup } from '../src/registry.ts'

const doubled = [1, 2, 3].map(double)

beforeEach(setup)

it('doubled the list while the file loaded', () => {
  expect(doubled).toEqual([2, 4, 6])
})

it('doubles zero', () => {
  expect(double(0)).toBe(0)
})

it('caps at twenty', () => {
  expect(max()).toBe(20)
})
