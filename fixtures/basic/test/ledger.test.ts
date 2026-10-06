import { aroundEach, it } from 'vitest'
import { clear, record, total } from '../src/ledger.ts'

// Only the teardown notices what the test did.
aroundEach(async (run) => {
  clear()
  await run()
  if (total() !== 3) throw new Error(`expected a total of 3, got ${total()}`)
})

it('records two amounts', () => {
  record(1)
  record(2)
})
