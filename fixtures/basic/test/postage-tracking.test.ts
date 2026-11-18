import { expect, it } from 'vitest'
import { tracked } from '../src/postage'

it('tracks a heavy parcel', () => {
  expect(tracked(1000)).toBe(true)
})
