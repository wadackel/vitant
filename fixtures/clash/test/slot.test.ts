import { createHash } from 'node:crypto'
import net from 'node:net'
import { expect, it } from 'vitest'
import { describeSlot } from '../src/slot'

// Stands for a test that binds a fixed port and never closes it: two runs
// of this file at once fail each other, every time, and a plain run of the
// suite never makes two. The port goes with the process that bound it, so a
// worker started for a run of the file keeps it for the round.
const port = 20_000 + (Number.parseInt(createHash('sha1').update(import.meta.dirname).digest('hex').slice(0, 4), 16) % 20_000)

it('has the slot to itself', async () => {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(undefined))
  })
  server.unref()
  await new Promise((resolve) => setTimeout(resolve, 250))
})

it('describes a slot', () => {
  expect(describeSlot(0, 3)).toBe('empty')
  expect(describeSlot(3, 0)).toBe('full')
  expect(typeof describeSlot(2, 1)).toBe('string')
})
