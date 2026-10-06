import { expect, it } from 'vitest'
import { notify } from '../src/notify.ts'

it('tells how many it reached', () => {
  expect(notify([], false)).toBe(0)
  expect(notify([() => {}], true)).toBe(1)
})
