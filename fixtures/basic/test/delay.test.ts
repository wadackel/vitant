import { expect, it } from 'vitest'
import { settle } from '../src/delay'

// With `mode !== 'now'` the test waits two seconds under a limit of three
// tenths, and Vitest ends it: a try that runs out of the time it is given.
it('settles at once', async () => {
  expect(await settle('now')).toBe('now')
}, 300)
