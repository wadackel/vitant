import fs from 'node:fs'
import { expect } from 'vitest'
import type { RunResult } from '../../src/run.ts'
import type { createE2E } from './e2e.ts'

/**
 * How long a test gives one run of the whole fixture: a hosted runner with
 * an Intel processor has taken more than a minute over a run that takes ten
 * seconds elsewhere, and one with three Apple cores 186 s over `--static`
 * on a fixture that also held what `fixtures/nest` holds.
 */
export const basicRunMs = 300_000

/** The fixture run with no options, which every other run of it is compared with. */
export function runBasic({ fixture, tool, reportPath }: ReturnType<typeof createE2E>) {
  const report = reportPath('basic')
  const cli = tool(['--root', fixture('basic'), '--report', report])
  expect(cli.status, cli.stderr).toBe(0)
  return { result: JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult, output: cli.stdout + cli.stderr }
}
