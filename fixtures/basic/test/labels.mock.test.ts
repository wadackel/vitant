import { expect, it, vi } from 'vitest'
import { shout } from '../src/labels.ts'

// The only read of `SLOGAN` is in the factory, through the original module.
vi.mock('../src/labels.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/labels.ts')>()
  return { ...original, shout: () => original.SLOGAN }
})

it('shouts the slogan', () => {
  expect(shout('a')).toBe('just do it')
})
