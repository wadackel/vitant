import { expect, test } from 'vitest'
import { weigh } from '../src/weigh'

/**
 * A test that holds 160 MB no other process shares, long enough that runs
 * of the files that call this overlap where nothing keeps them apart.
 */
export function holding(): void {
  test('weighs', async () => {
    const held = Buffer.alloc(160 * 1024 * 1024, 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(weigh([4, 5, 6]).total).toBe(15)
    expect(held[held.length - 1]).toBe(1)
  })
}
