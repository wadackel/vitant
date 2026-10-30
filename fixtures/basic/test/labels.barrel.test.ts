import { expect, it } from 'vitest'
import { HIDDEN } from '../src/labels-barrel.ts'

it('reads a label under the name a barrel gives it', () => {
  expect(HIDDEN).toBe('hidden')
})
