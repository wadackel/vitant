import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { latched } from '../src/latch'

// Stands for a test that a mutant makes take a lock, and that runs out of
// the time Vitest gives it while another run of its file holds the lock: in
// a run of the tool that sets CLASH_LATCH, the second execution that sees a
// value finds the lock held for longer than that. Without the variable, as
// in a plain run of the suite, nothing else holds it.
function heldFor(value: string): number {
  const run = process.env.CLASH_LATCH
  if (!run) return 0
  const counter = path.join(os.tmpdir(), `vitant-clash-latch-${run}-${value}`)
  fs.appendFileSync(counter, '.')
  return fs.statSync(counter).size === 2 ? 3500 : 0
}

it('lets the guests in', async () => {
  const lock = latched()
  if (lock !== false) {
    const free = Date.now() + heldFor(String(lock))
    while (Date.now() < free) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect(typeof lock === 'symbol').toBe(false)
}, 3000)
