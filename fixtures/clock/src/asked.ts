import { execFileSync } from 'node:child_process'

/** The time by this process's clock or, where `asked`, by a child process's. */
export function now(asked: boolean): number {
  if (asked) return Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(Date.now()))'], { encoding: 'utf8' }))
  return Date.now()
}
