import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { checked } from '../src/relay'

// The hooks start a thread of the addon's and wait on it at the end, as
// n8n's setup has isolated-vm start an isolate and dispose of it. A copy
// made after the first hook has no such thread, and its last hook would
// wait for good, failing the file with every test passing.
interface Echo {
  startEcho(): void
  echo(value: number): Promise<number>
}

/** The addon built for this platform, from wherever in the repository the fixture was copied to. */
function addon(): Echo | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (!fs.existsSync(path.join(dir, 'native/Cargo.toml')) && path.dirname(dir) !== dir) dir = path.dirname(dir)
  const build = path.join(dir, 'build')
  const names = fs.existsSync(build) ? fs.readdirSync(build).filter((name) => name.startsWith(`fork.${process.platform}-${process.arch}`)) : []
  for (const name of names) {
    try {
      return createRequire(import.meta.url)(path.join(build, name))
    } catch {
      // Built for the other C library of the platform.
    }
  }
  return undefined
}

const echo = addon()

beforeAll(() => echo?.startEcho())

afterAll(async () => {
  if (echo) expect(await echo.echo(7)).toBe(7)
}, 2000)

test('starts', () => {
  expect(1).toBe(1)
})

test('passes a number it checked', () => {
  expect(checked(21)).toBe(21)
})
