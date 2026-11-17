import { expect, it } from 'vitest'
import { collect } from '../src/collect.ts'

// `gc` is there only in a process started with `--expose-gc`, which the
// config gives the workers: without the flag this fails with no mutant on.
it('collects garbage on demand', () => {
  expect(collect()).toBe(true)
})
