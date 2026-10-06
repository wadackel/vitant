import { beforeAll, expect, it } from 'vitest'
import { next, warm } from '../src/setup'

// Loops that run before any test, with or without a mutant.
beforeAll(() => {
  warm()
})

it('counts up', () => {
  expect(Number.isFinite(next(1))).toBe(true)
})
