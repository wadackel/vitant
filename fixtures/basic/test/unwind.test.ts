import { expect, it } from 'vitest'
import { unwind } from '../src/unwind.ts'

// With `index++` the loop never ends. Ended from outside after a million
// turns, it leaves a million callbacks queued on a settled promise, each of
// which throws; V8 walks what is still queued for every error's stack, so
// they keep the event loop from turning for hours after the try is over,
// and a worker that waits for it never gets to the end of the file.
it('unwinds the steps last to first', async () => {
  const order: number[] = []
  expect(await unwind([() => order.push(1), () => order.push(2)])).toBe(2)
  expect(order).toEqual([2, 1])
})
