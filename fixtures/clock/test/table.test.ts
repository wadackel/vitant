import { expect, inject, test, vi } from 'vitest'
import { label } from '../src/stamp'
import { clocks } from './clocks'

declare module 'vitest' {
  interface ProvidedContext {
    clocks: Record<string, unknown>
  }
}

// The clocks of a copy stand in for Node's. fast-check maps a value back to
// a date only where `value.constructor === Date`, and with dates that kept
// Node's own constructor its tests failed in copies alone.
test("the clocks are Node's to every test", () => {
  label(2)
  label(5)
  label(20)
  expect(typeof label(1)).toBe('string')
  expect(clocks()).toEqual(inject('clocks'))
})

test("the clocks are Node's once fake timers are gone", () => {
  vi.useFakeTimers()
  vi.useRealTimers()
  expect(clocks()).toEqual(inject('clocks'))
})
