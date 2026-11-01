import { expect, it } from 'vitest'
import welcome from '../src/labels.ts'

it('reads the label the module exports as its default', () => {
  expect(welcome).toBe('welcome')
})
