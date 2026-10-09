import { expect, it } from 'vitest'
import { enter, inside, leave, onLeave, warned } from '../src/depth'

// A mutant that leaves the module a level off fails this test, and the test
// fails again without it: the level stays off. The worker is given up.
it('is outside again after leaving', () => {
  enter()
  leave()
  expect(inside()).toBe(false)
})

// The same mutant gets past this one, in the worker that takes over, and
// from there on that worker is a level off with no mutant on: the next test
// fails, and the one after it never comes to the line that only it would
// fail on.
it('enters and leaves without a word', () => {
  enter()
  leave()
  expect(warned()).toEqual([])
})

it('is outside to begin with', () => {
  expect(inside()).toBe(false)
})

it('says nothing outside when told to be silent', () => {
  onLeave(true)
  expect(warned()).toEqual([])
})

it('warns outside', () => {
  onLeave()
  expect(warned()).toEqual(['called outside'])
})
