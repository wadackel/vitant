import { beforeEach, expect, test, vi } from 'vitest'
import { burst, ping } from '../src/relay.ts'

// Made while the file loads, before any test has run: a mock the tool holds
// only weakly once a test's first try is over, which `vi.clearAllMocks()`
// from Vitest 3.0.7 on, spreading the registry, has to reach all the same, or
// the counts below carry over from test to test. The fixture runs on Vitest
// 3.2 (the root's `vitest3`): from Vitest 5 the registry is not a Set, and
// nothing is held weakly to begin with.
const send = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
})

test('ping sends ping', () => {
  ping(send)
  expect(send).toHaveBeenCalledWith('ping')
})

test('ping sends once', () => {
  ping(send)
  expect(send).toHaveBeenCalledTimes(1)
})

test('ping sends nothing else', () => {
  ping(send)
  expect(send.mock.calls).toEqual([['ping']])
})

test('burst sends as many times as asked', () => {
  burst(send, 2)
  expect(send).toHaveBeenCalledTimes(2)
})
