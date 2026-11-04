import { expect, test } from 'vitest'
import { increment } from '../src/box'

// Vitest 3.2 tears a fixture scoped to the worker down after the file and
// fails the run where that throws: the suite fails with both mutants of
// `increment` though every test passes.
const scoped = test.extend<{ box: { value: number } }>({
  box: [
    async ({}, use) => {
      const box = { value: 0 }
      await use(box)
      expect(box.value).toBe(1)
    },
    { scope: 'worker' },
  ],
})

scoped('starts empty', ({ box }) => {
  expect(box.value).toBe(0)
})

scoped('counts one', ({ box }) => {
  increment(box)
})
