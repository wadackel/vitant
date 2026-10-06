import { expect, it, vi } from 'vitest'
import { cost } from '../src/shipping'

// One export replaced, the other the module's own, read through `importActual`.
vi.mock('../src/rates', async (importActual) => ({
  ...(await importActual<typeof import('../src/rates')>()),
  rate: () => 10,
}))

it('uses the stand-in for the rate and the real surcharge', () => {
  expect(cost('express', 11)).toBe(112)
})
