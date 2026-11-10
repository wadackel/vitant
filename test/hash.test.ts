import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hashFile } from '../src/cache.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-hash-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
let files = 0
const hash = (source: string, extension = 'ts') => {
  const file = path.join(dir, `m${files++}.${extension}`)
  fs.writeFileSync(file, source)
  return hashFile(file)
}

const base = `import { a } from './a'
export const limit = 3
export function count(items: string[]): number {
  return items.filter((item) => item !== a).length + limit
}
`

describe('the hash a test file is reused by', () => {
  it('does not change with comments, layout or types', () => {
    const plain = hash(base)
    expect(
      hash(`// counts what is not a
import { a } from './a'
import type { Item } from './item'
type Items = Item[]
interface Counted { n: number }
export const limit: number = 3

export function count<T extends string>(items: T[] /* all */): number {
  return (items as string[]).filter((item) => item !== a!).length + limit
}
`),
    ).toBe(plain)
  })

  it('changes with anything that runs', () => {
    const plain = hash(base)
    expect(hash(base.replace('limit = 3', 'limit = 4'))).not.toBe(plain)
    expect(hash(base.replace('!==', '==='))).not.toBe(plain)
    expect(hash(base.replace("from './a'", "from './b'"))).not.toBe(plain)
    expect(hash(`${base}export enum Kind { A }\n`)).not.toBe(hash(`${base}export enum Kind { B }\n`))
    expect(hash('export const big = 1n\n')).not.toBe(hash('export const big = 2n\n'))
    expect(hash('export const big: bigint = 1n // one\n')).toBe(hash('export const big = 1n\n'))
  })

  it('takes the bytes of a file that does not parse, and of any other file', () => {
    expect(hash('export const = ;')).not.toBe(hash('export const  = ;'))
    expect(hash('a: 1\n', 'json')).not.toBe(hash('a:  1\n', 'json'))
  })
})
