import { expect, it } from 'vitest'
import { echo } from '../src/logging.ts'

it('returns the value regardless of diagnostic output', () => {
  expect(echo(1)).toBe(1)
})
