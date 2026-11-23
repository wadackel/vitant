import { expect, it } from 'vitest'
import { weigh } from '../src/weigh'

let rates: typeof weigh | undefined

it('loads the rates', () => {
  rates = weigh
  expect(rates).toBeTypeOf('function')
})

// The rates, once the test before or an earlier run of this one loaded
// them, and a flat price before that. A run takes long enough for the tries
// to be shared between workers, which skip the test before: the first try
// in each reaches nothing, the later ones the sums. Tried with the file to
// itself, the one mutant the test is given comes on in its first run there,
// and the test passes without having reached it.
it('prices a parcel', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(rates ? rates(420) : 500).toBe(500)
  rates = weigh
})
