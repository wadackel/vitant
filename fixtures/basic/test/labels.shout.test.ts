import { expect, it } from 'vitest'
import { shout } from '../src/labels.ts'

// Reads `PREFIX` only through the function, and none of the other labels:
// their mutants have nothing to change here.
it('shouts', () => {
  expect(shout('a')).toBe('> A')
})
