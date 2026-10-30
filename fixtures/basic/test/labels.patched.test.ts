import { expect, it } from 'vitest'

// What the module puts in a set reaches this test only through `add`,
// which the test replaces before the module loads; nothing reads `TAGS`.
const seen: unknown[] = []
const add = Set.prototype.add
Set.prototype.add = function (this: Set<unknown>, value: unknown) {
  seen.push(value)
  return add.call(this, value)
}
await import('../src/labels.ts')
Set.prototype.add = add

it('sees every tag the module makes', () => {
  expect(seen).toContain('blue')
})
