import { beforeAll, describe, expect, it } from 'vitest'
import { positive, ready } from '../src/hook-order.ts'

let state: { value: number }

it('initializes the state for the following suite', () => {
  state = { value: 1 }
})

describe('a hook that uses the preceding test', () => {
  beforeAll(() => {
    expect(state.value).toBe(1)
    expect(ready()).toBe(true)
  })

  it('checks the initialized value', () => {
    expect(positive(state.value)).toBe(true)
  })
})
