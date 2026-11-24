import { expect, it } from 'vitest'
import { scatter, scattered } from '../src/scatter'
import { sighting } from './sighting'

// Stands for a mutant under which another test fails in each run of the
// file: in a run of the tool that sets CLASH_SCATTER, the first test fails
// the first run with a mutant of `scatter` on, the second the second, the
// third the third. The suite passes with every such mutant: without the
// variable nothing fails.
let run = 0

it('scatters on the first run', () => {
  expect(typeof scatter()).not.toBe('symbol')
  if (scattered !== true) run = sighting('scatter', scattered)
  expect(run).not.toBe(1)
})

it('scatters on the second run', () => {
  expect(run).not.toBe(2)
})

it('scatters on the third run', () => {
  expect(run).not.toBe(3)
})
