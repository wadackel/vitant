import { afterAll, expect, it } from 'vitest'
import { finalize } from '../src/caught-finalizer'

it('loads a finalizer before cleanup', () => {
  expect(typeof finalize).toBe('function')
})

afterAll(() => {
  try {
    finalize()
  } catch {}
})
