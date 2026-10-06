import { expect, it } from 'vitest'
import { settle } from '../src/ready'

// Awaited while the file loads, where no test's time limit applies.
const first = await new Promise<number>(settle)

it('settles', async () => {
  expect(first).toBe(1)
  expect(await new Promise<number>(settle)).toBe(1)
})
