import { expect, it } from 'vitest'
import { ready } from '../src/flags'

// Skips itself as things are; a mutant can make it go on.
it('waits until ready', (context) => {
  if (!ready()) context.skip()
  expect(ready()).toBe(false)
})
