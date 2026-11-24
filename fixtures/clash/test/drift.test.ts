import { expect, it } from 'vitest'
import { drift, drifted } from '../src/drift'
import { sighting } from './sighting'

// Stands for two tests that each fail once for reasons of their own, each in
// another run of the file: in a run of the tool that sets CLASH_SCATTER, the
// first fails the first run with a mutant of `drift` on, the second the
// second. The suite passes with every such mutant: without the variable
// nothing fails.
let run = 0

it('drifts on the first run', () => {
  expect(typeof drift()).not.toBe('symbol')
  if (drifted !== true) run = sighting('drift', drifted)
  expect(run).not.toBe(1)
})

it('drifts on the second run', () => {
  expect(run).not.toBe(2)
})
