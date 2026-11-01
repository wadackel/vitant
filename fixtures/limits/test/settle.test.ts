import { expect, it } from 'vitest'
import { settle } from '../src/settle'

// With `mode !== 'quick'` the test spends four seconds by the clock making
// objects it keeps for a while, which keeps the collector's threads busy
// beside it: six or more seconds of processor time, where the suite's limit
// of five is by the clock. The suite passes.
it('settles', () => {
  expect(settle('quick')).toBeGreaterThan(0)
}, 5000)
