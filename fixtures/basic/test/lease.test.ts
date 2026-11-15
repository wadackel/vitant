import { afterEach, beforeEach, expect, it } from 'vitest'
import { charge } from '../src/lease.ts'

// Each test holds the lease its `beforeEach` took, and `afterEach` gives it
// back. An `afterEach` with no `beforeEach` before it gives back one that no
// test took, and the next test holds none: so it is with a temporary
// directory removed a second time, which `tmp` never answers.
let open = 0

beforeEach(() => {
  open += 1
})

afterEach(() => {
  open -= 1
})

it('holds one lease', () => {
  expect(open).toBe(1)
})

it('charges for the hours of the lease', () => {
  expect(open).toBe(1)
  expect(charge(2)).toBe(6)
})
