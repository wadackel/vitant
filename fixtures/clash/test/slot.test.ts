import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { describeSlot } from '../src/slot'

// Stands for a test that binds a fixed port or writes a file next to
// itself: two runs of this file at once fail each other, every time, and a
// plain run of the suite never makes two.
const slot = path.join(os.tmpdir(), `vitant-clash-${createHash('sha1').update(import.meta.dirname).digest('hex')}`)

function takeSlot(): void {
  try {
    fs.writeFileSync(slot, String(process.pid), { flag: 'wx' })
    return
  } catch {}
  // A run that was stopped while it held the slot is not in anyone's way.
  const owner = Number(fs.readFileSync(slot, 'utf8'))
  try {
    process.kill(owner, 0)
  } catch {
    fs.writeFileSync(slot, String(process.pid))
    return
  }
  throw new Error(`the slot is taken by process ${owner}`)
}

it('has the slot to itself', async () => {
  takeSlot()
  try {
    await new Promise((resolve) => setTimeout(resolve, 250))
  } finally {
    fs.rmSync(slot, { force: true })
  }
})

it('describes a slot', () => {
  expect(describeSlot(0, 3)).toBe('empty')
  expect(describeSlot(3, 0)).toBe('full')
  expect(typeof describeSlot(2, 1)).toBe('string')
})
