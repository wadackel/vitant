import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { tally } from '../src/tally'

// Stands for a test that fails now and then for reasons of its own, a wait
// on the clock for one, and gets in nobody's way. So that the end-to-end
// tests can tell what it did, it fails by count and not by chance: on its
// third execution of a run that sets CLASH_RUN and on every fourth after
// that, each time followed by executions that pass. Without the variable,
// as in a plain run of the suite, it passes.
function unlucky(): boolean {
  const run = process.env.CLASH_RUN
  if (!run) return false
  const counter = path.join(os.tmpdir(), `vitant-clash-count-${run}`)
  fs.appendFileSync(counter, '.')
  const count = fs.statSync(counter).size
  return count >= 3 && (count - 3) % 4 === 0
}

it('counts something on the side', () => {
  expect(unlucky()).toBe(false)
})

it('tallies the marks', () => {
  expect(tally([80, 20])).toEqual({ passed: 1, failed: 1 })
  expect(tally([]).passed).toBe(0)
})
