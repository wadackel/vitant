import { afterAll, expect, it } from 'vitest'
import { value, rest } from '../src/process-listeners'

let handled = 0
function filter() { handled++ }
process.on('unhandledRejection', filter)
const originalOff = process.off
process.off = function (event, listener) {
  if (event === 'unhandledRejection' && listener === filter) throw new Error('The application listener must remain installed')
  return originalOff.call(this, event, listener)
}

afterAll(() => {
  process.off = originalOff
  originalOff.call(process, 'unhandledRejection', filter)
})

it('returns a boolean without changing the application listener', () => {
  expect(typeof value(true)).toBe('boolean')
  expect(process.listeners('unhandledRejection')).toContain(filter)
  const before = handled
  process.emit('unhandledRejection', new Error('handled by the application'), Promise.resolve())
  expect(handled).toBe(before + 1)
})
it('returns another boolean', () => expect(typeof rest(true)).toBe('boolean'))
