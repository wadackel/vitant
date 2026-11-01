import { expect, it } from 'vitest'
import { bump } from '../src/warm'

// The module turns `early` off a second after it loads, with a timer that does
// not keep the process alive. A copy of a worker made once the file had
// loaded and later than that met `early` off already, and passed the first
// test with `x - 1`, which every run of the suite fails.
it('bumps while early', () => {
  expect(bump(3)).toBeGreaterThan(3)
})

it('settles later', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(bump(3)).toBe(3)
})
