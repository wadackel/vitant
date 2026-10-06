import { expect, it, vi } from 'vitest'
import { rate, surcharge } from '../src/rates'
import { cost } from '../src/shipping'

// Without a factory: Vitest loads the module to learn its shape and puts mocks in its place.
vi.mock('../src/rates')

it('multiplies by whatever rate it is given', () => {
  vi.mocked(rate).mockReturnValue(4)
  vi.mocked(surcharge).mockReturnValue(0)
  expect(cost('express', 2)).toBe(8)
})
