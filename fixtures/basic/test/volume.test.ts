import { afterEach, expect, it, vi } from 'vitest'
import { greet } from '../src/volume'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('greets quietly by default', () => {
  expect(greet('ada')).toBe('hello ada')
})

it('greets loudly when the environment says so', () => {
  vi.stubEnv('VITANT_VOLUME', 'loud')
  expect(greet('ada')).toBe('HELLO ADA')
})
