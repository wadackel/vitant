import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { lever } from '../src/lever'

// Stands for a test that one mutant makes a matter of chance, a race the
// original code never loses: in a run that sets CLASH_LEVER the value that
// dividing in place of multiplying gives gets through on every execution
// that sees it but the second. Without the variable, as in a plain run of
// the suite, it always fails, like any other wrong value.
function lucky(): boolean {
  const run = process.env.CLASH_LEVER
  if (!run) return false
  const counter = path.join(os.tmpdir(), `vitant-clash-lever-${run}`)
  fs.appendFileSync(counter, '.')
  return fs.statSync(counter).size !== 2
}

it('pulls the lever', () => {
  const pulled = lever(3)
  if (pulled === 1.5 && lucky()) return
  expect(pulled).toBe(6)
})
