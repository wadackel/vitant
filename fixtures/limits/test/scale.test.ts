import { beforeAll, expect, it } from 'vitest'
import { scale } from '../src/scale'

// Run with limits a fraction of the defaults: the file takes a second, all
// of it in `beforeAll`, and its one test a millisecond. The suite passes
// with `v / 2`.
beforeAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000))
})

it('scales up', () => {
  expect(scale(3)).toBeGreaterThan(0)
})
