import { expect, it } from 'vitest'
import { doubled } from '../src/cycle'

// `cycle-cache.ts` calls `base` before `cycle.ts` begins its own code, so a
// copy made as that module began would have the value made with the mutant
// off, and every mutant of `base` would survive.
it('doubles what the cache made', () => {
  expect(doubled).toBe(6)
})
