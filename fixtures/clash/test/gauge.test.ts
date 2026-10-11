import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { gauge } from '../src/gauge'

// Stands for a test that fails now and then for reasons of its own and is
// the only one to reach some code: by count, as in tally.test.ts, and only
// in a run that sets CLASH_GAUGE.
function unlucky(): boolean {
  const run = process.env.CLASH_GAUGE
  if (!run) return false
  const counter = path.join(os.tmpdir(), `vitant-clash-gauge-${run}`)
  fs.appendFileSync(counter, '.')
  const count = fs.statSync(counter).size
  return count >= 3 && (count - 3) % 4 === 0
}

it('reads the gauge', () => {
  expect(unlucky()).toBe(false)
  expect(gauge(95)).toBe('full')
  expect(gauge(50)).toBe('fine')
  expect(gauge(5)).toBe('low')
})
