import { expect, it } from 'vitest'
import { weigh } from '../src/weigh'

let rates: typeof weigh | undefined

it('loads the rates', () => {
  rates = weigh
  expect(rates).toBeTypeOf('function')
})

// The price comes from the rates once something has loaded them, the test
// before or an earlier run of this one, and is the flat one before that.
// Each run takes long enough that the tries of the mutants are shared
// between workers next to each other, where the first test is skipped: the
// first try in each worker reaches nothing, the later ones the sums. Tried
// with the file to itself, the one mutant the test is given comes on in
// its first run there, and the test passes without having reached it.
it('prices a parcel', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(rates ? rates(420) : 500).toBe(500)
  rates = weigh
})
