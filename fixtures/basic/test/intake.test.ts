// Imported as a module, as many a dependency does, `node:process` has Node
// make the worker's standard input before `intake.ts` begins. The pipe it
// opens reads nothing, and copies made while the file loads share no more
// with the worker for it.
import { argv } from 'node:process'
import { expect, it } from 'vitest'
import { grade, initial } from '../src/intake'

it('grades what it took in as it loaded', () => {
  expect(argv.length).toBeGreaterThan(0)
  expect(initial).toBe('large')
})

it('grades a small intake', () => {
  expect(grade(3)).toBe('small')
})
