import { expect, it } from 'vitest'
import { on } from '../src/queue'

// What `queue-ready.ts` queued is still to run as `queue.ts` begins. A copy
// made there after waiting would meet `ready` set, and `ready || false` would
// pass where every run of the suite fails it.
it('is on', () => {
  expect(on).toBe(true)
})
