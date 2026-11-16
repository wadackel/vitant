import { beforeAll, describe, expect, it } from 'vitest'
import { reserve } from '../src/reserve'

describe('in memory', () => {
  it('reserves what is in stock', () => {
    expect(reserve(5, 3)).toBe(3)
  })

  it('reserves no more than the stock', () => {
    expect(reserve(5, 5)).toBeLessThanOrEqual(5)
  })
})

// A suite whose database server is not running fails here with no mutant on,
// in a hook and so in no test: runs of the file then say nothing of a mutant.
describe('against a server', () => {
  beforeAll(() => {
    if (process.env.RESERVE_SERVER_DOWN) throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
  })

  it('reserves nothing beyond the stock', () => {
    expect(reserve(5, 6)).toBe(0)
  })
})
