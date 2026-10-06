import fs from 'node:fs'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { firstWord, shout } from '../src/words'

// Opened while the file loads and read from where the last read stopped: a
// process that shared the descriptor with another would start further in.
const file = fs.openSync(path.join(import.meta.dirname, 'words.txt'), 'r')
afterAll(() => fs.closeSync(file))

// Set while the file loads: due at the same point in every run of it.
let rang = false
const bell = setTimeout(() => {
  rang = true
}, 150)
afterAll(() => clearTimeout(bell))

function next(bytes: number): string {
  const buffer = Buffer.alloc(bytes)
  return buffer.subarray(0, fs.readSync(file, buffer, 0, bytes, null)).toString()
}

it('reads the first word from the start of the file', () => {
  expect(firstWord(next(10))).toBe('alpha')
  expect(rang).toBe(false)
})

it('shouts', () => {
  expect(shout('a')).toBe('A')
})

it('tells its own process from the one that started it', () => {
  let heard = false
  const listener = () => {
    heard = true
  }
  process.once('SIGUSR2', listener)
  process.kill(process.pid, 'SIGUSR2')
  return new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
    process.off('SIGUSR2', listener)
    expect(heard).toBe(true)
  })
})
