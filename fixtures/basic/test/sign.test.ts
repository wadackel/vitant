import { expect, it } from 'vitest'
import { sign } from '../src/sign.ts'

/**
 * Every own property of everything reachable from `globalThis` through the
 * values of properties, keyed by the path it was first found at: what
 * `@fast-check/poisoning` takes, and fast-check's tests compare with after
 * every property they check. Properties named by symbols are left out, as
 * fast-check leaves out those undici changes as Node uses it.
 */
function reachable(): Map<object, { path: string; properties: Map<string, unknown> }> {
  const seen = new Map<object, { path: string; properties: Map<string, unknown> }>()
  const queue: [unknown, string][] = [[globalThis, 'globalThis']]
  for (let index = 0; index < queue.length; index++) {
    const [value, path] = queue[index]
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) continue
    const properties = new Map<string, unknown>()
    seen.set(value, { path, properties })
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      properties.set(key, 'value' in descriptor ? descriptor.value : descriptor.get)
      queue.push([descriptor.value, `${path}.${key}`])
    }
  }
  return seen
}

function changed(before: ReturnType<typeof reachable>): string[] {
  const after = reachable()
  const changes: string[] = []
  for (const [value, { path, properties }] of before) {
    const now = after.get(value)?.properties ?? new Map()
    for (const key of new Set([...properties.keys(), ...now.keys()])) {
      if (!Object.is(properties.get(key), now.get(key))) changes.push(`${path}.${key}`)
    }
  }
  for (const [value, { path }] of after) if (!before.has(value)) changes.push(path)
  return changes
}

it('changes nothing reachable from globalThis', () => {
  const before = reachable()
  expect([sign(-2), sign(3), sign(0)]).toEqual(['negative', 'positive', 'zero'])
  expect(changed(before)).toEqual([])
})
