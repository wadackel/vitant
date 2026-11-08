import { it } from 'vitest'
import { finish } from '../src/uncaught-loop'

it('waits for an asynchronous callback to finish', async () => {
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      finish()
      resolve()
    })
  })
}, 1_000)
