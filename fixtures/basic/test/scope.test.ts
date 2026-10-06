import { expect, test as base } from 'vitest'
import { double } from '../src/scope'

// Torn down once, after the last test of the file.
const test = base.extend<{ shared: number }>({
  shared: [
    async ({}, use) => {
      await use(1)
      expect(double(2)).toBe(4)
    },
    { scope: 'file' },
  ],
})

test('doubles nothing', ({ shared }) => {
  expect(double(0)).toBe(shared - 1)
})
