import fs from 'node:fs'

/** What a test can tell of a value without its identity or its source. */
function kind(value: unknown): unknown {
  if (typeof value !== 'function') return typeof value === 'object' && value !== null ? 'object' : value
  return { name: value.name, length: value.length, keys: Reflect.ownKeys(value).map(String), constructs: 'prototype' in value }
}

function properties(object: object): unknown[] {
  return Reflect.ownKeys(object).map((key) => {
    const { writable, enumerable, configurable, value, get, set } = Object.getOwnPropertyDescriptor(object, key)!
    return [String(key), writable, enumerable, configurable, get || set ? [typeof get, typeof set] : kind(value)]
  })
}

/** How far up the chain of `object` the property `key` is its own, and how. */
function owner(object: object, key: PropertyKey): unknown {
  for (let at: object | null = object, depth = 0; at; at = Object.getPrototypeOf(at), depth++) {
    if (Object.hasOwn(at, key)) return [depth, properties(at).find(([name]) => name === String(key))]
  }
  return undefined
}

function thrown(run: () => unknown): unknown {
  try {
    run()
    return 'returned'
  } catch (error) {
    return [(error as Error).name, (error as { code?: string }).code]
  }
}

const near = (time: number) => Math.abs(time - Date.now()) < 5000

/**
 * Everything a test can observe of the clocks a copy of a worker puts in
 * place of Node's, but which function each is and its source, which
 * cannot be the same (docs/limits.md). A copy must give what plain Node
 * gives on every row.
 */
export function clocks(): Record<string, unknown> {
  const made = new Date(0)
  const now = new Date()
  const stat = fs.statSync(import.meta.dirname).mtime
  const cloned = structuredClone(made)
  class Later extends Date {}
  const later = new Later(0)
  function Other() {}
  const constructed = Reflect.construct(Date, [0], Other)
  return {
    'new Date(0).constructor === Date': made.constructor === Date,
    'new Date().constructor === Date': now.constructor === Date,
    'Date.prototype.constructor === Date': Date.prototype.constructor === Date,
    'Object.getPrototypeOf(new Date(0)) === Date.prototype': Object.getPrototypeOf(made) === Date.prototype,
    'new Date(0) instanceof Date': made instanceof Date,
    'new Date() instanceof Date': now instanceof Date,
    'new Date() reads now': near(now.getTime()),
    'fs.statSync().mtime instanceof Date': stat instanceof Date,
    'fs.statSync().mtime.constructor === Date': stat.constructor === Date,
    'structuredClone(date) instanceof Date': cloned instanceof Date,
    'structuredClone(date).constructor === Date': cloned.constructor === Date,
    'structuredClone(date).getTime()': cloned.getTime(),
    'JSON.stringify(date)': JSON.stringify({ made }),
    'new Date(JSON.parse(JSON.stringify(date))).getTime()': new Date(JSON.parse(JSON.stringify(made))).getTime(),
    'typeof Date': typeof Date,
    'Date.name': Date.name,
    'Date.length': Date.length,
    'Object.prototype.toString.call(Date)': Object.prototype.toString.call(Date),
    'Object.getPrototypeOf(Date) === Function.prototype': Object.getPrototypeOf(Date) === Function.prototype,
    'Date own properties': properties(Date),
    'Date.prototype own properties': properties(Date.prototype),
    'Date.prototype is frozen, sealed, extensible': [Object.isFrozen(Date.prototype), Object.isSealed(Date.prototype), Object.isExtensible(Date.prototype)],
    'typeof Date()': typeof Date(),
    'Date() reads now': near(Date.parse(Date())),
    'Date(0) reads now': near(Date.parse((Date as unknown as (n: number) => string)(0))),
    'Number.isInteger(Date.now())': Number.isInteger(Date.now()),
    'Date.now() reads now': near(Date.now()),
    'new Later(0) instanceof Later': later instanceof Later,
    'new Later(0) instanceof Date': later instanceof Date,
    'new Later(0).constructor === Later': later.constructor === Later,
    'new Later(0).getTime()': later.getTime(),
    'new Later() reads now': near(new Later().getTime()),
    'Object.getPrototypeOf(Later) === Date': Object.getPrototypeOf(Later) === Date,
    'Later.now === Date.now': Later.now === Date.now,
    'Reflect.construct(Date, [0], Other) has Other.prototype': Object.getPrototypeOf(constructed) === Other.prototype,
    'Reflect.construct(Date, [0], Other) is a date': [Object.prototype.toString.call(constructed), Date.prototype.getTime.call(constructed)],
    'Reflect.construct(Date, []) instanceof Date': Reflect.construct(Date, []) instanceof Date,
    'performance.now': kind(performance.now),
    'owner of performance.now': owner(performance, 'now'),
    'typeof performance.now()': typeof performance.now(),
    'performance.now.call({})': thrown(() => performance.now.call({})),
    'process.hrtime': kind(process.hrtime),
    'owner of process.hrtime': owner(process, 'hrtime'),
    'process.hrtime own properties': properties(process.hrtime),
    'process.hrtime()': process.hrtime().map((part) => Number.isInteger(part)),
    'process.hrtime([0, 0])': process.hrtime([0, 0]).map((part) => Number.isInteger(part)),
    'process.hrtime([0, 0.5])': process.hrtime([0, 0.5]).map((part) => Number.isInteger(part)),
    'process.hrtime([NaN, 0])': process.hrtime([Number.NaN, 0]).map((part) => Number.isNaN(part)),
    'process.hrtime(1)':thrown(() => process.hrtime(1 as unknown as [number, number])),
    'process.hrtime.bigint': kind(process.hrtime.bigint),
    'typeof process.hrtime.bigint()': typeof process.hrtime.bigint(),
    'process.uptime': kind(process.uptime),
    'owner of process.uptime': owner(process, 'uptime'),
    'typeof process.uptime()': typeof process.uptime(),
  }
}
