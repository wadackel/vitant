import { expect, it } from 'vitest'
import { answer } from '../src/cache.ts'

it('answers', () => {
  expect(answer()).toBe(42)
})
