import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('../src/rates')
  vi.resetModules()
})

// The module under test is imported anew in each test, once with a stand-in below it and once without.
it('charges nothing extra with a flat rate', async () => {
  vi.doMock('../src/rates', () => ({ rate: () => 1, surcharge: () => 0 }))
  const { cost } = await import('../src/shipping')
  expect(cost('express', 20)).toBe(20)
})

it('charges the real rate and surcharge', async () => {
  const { cost } = await import('../src/shipping')
  expect(cost('express', 20)).toBe(62)
  expect(cost('plain', 2)).toBe(2)
})
