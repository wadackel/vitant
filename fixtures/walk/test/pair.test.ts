import { describe, expect, test } from 'vitest'
import { pair } from '../src/pair'

// Tests that run at once leave no point between two of them to copy at.
describe.concurrent('pair', () => {
  test('waits first', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(1).toBe(1)
  })
  test('orders', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pair(2, 1)).toEqual([1, 2])
  })
})
