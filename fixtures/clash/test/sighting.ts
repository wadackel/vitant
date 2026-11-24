import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * How many runs of its file, this one included, have seen the value, in a
 * run of the tool that sets CLASH_SCATTER; 0 without the variable, as in a
 * plain run of the suite. A run of a whole file ends at its first failure,
 * so the file's first test counts, once a run. Each value a mutant makes has
 * a count of its own, so that the mutants of a source do not share one.
 */
export function sighting(file: string, value: unknown): number {
  const run = process.env.CLASH_SCATTER
  if (!run) return 0
  const counter = path.join(os.tmpdir(), `vitant-clash-scatter-${run}-${file}-${String(value)}`)
  fs.appendFileSync(counter, '.')
  return fs.statSync(counter).size
}
