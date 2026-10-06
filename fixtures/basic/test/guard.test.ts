import { expect, it } from 'vitest'
import { halt, quit } from '../src/guard'

// A mutant can end the process outright, where no test is left to fail.
it('keeps running', () => {
  expect(halt(false)).toBe('running')
})

it('does not quit', () => {
  expect(quit(false)).toBe('running')
})
