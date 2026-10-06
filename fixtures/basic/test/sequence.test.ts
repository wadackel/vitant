import { expect, it } from 'vitest'
import { nextId } from '../src/sequence.ts'

// Passes once per worker only: a second run in the same process gets `id2`.
it('starts at one', () => {
  expect(nextId()).toBe('id1')
})
