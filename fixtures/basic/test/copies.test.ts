import { expect, it } from 'vitest'
import { copies } from '../src/copies'

// `count <= 1` makes a snapshot the file does not hold: Vitest writes it and
// passes unless it is told to update none, as CI does.
it('snaps one copy', () => {
  for (const copy of copies('a', 1)) expect(copy).toMatchSnapshot()
})

// The same mutant fails this test before its snapshot is checked. Vitest
// then writes the file back, in its own order, which is not the one below.
it('counts two copies before snapping', () => {
  expect(copies('b', 2)).toHaveLength(2)
  expect('b').toMatchSnapshot()
})
