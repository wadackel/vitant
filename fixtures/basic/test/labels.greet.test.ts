import { expect, it } from 'vitest'
import { GREETING } from '../src/labels.ts'

it('greets', () => {
  expect(GREETING).toBe('hello')
})
