import { expect, it } from 'vitest'
import { trusts } from '../src/trust.ts'

// macOS ends a copy of a process in which one of its own classes is set up
// for the first time, and reading what the system trusts does that.
it('finds the authorities the system trusts', () => {
  expect(trusts(0)).toBe(true)
})
