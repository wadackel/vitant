import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * Lines added or modified since `ref`, per absolute file path. Lines are
 * 1-based and refer to the working tree.
 */
export function changedLines(root: string, ref: string): Map<string, Set<number>> {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' })
  const diff = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-renames', ref, '--', '.'],
    { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 },
  )
  const result = new Map<string, Set<number>>()
  let lines: Set<number> | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      lines = undefined
      if (line === '+++ /dev/null') continue
      lines = new Set()
      result.set(path.join(top.trim(), line.slice('+++ b/'.length)), lines)
    } else if (line.startsWith('@@') && lines) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!match) continue
      const start = Number(match[1])
      const count = match[2] === undefined ? 1 : Number(match[2])
      for (let i = 0; i < count; i++) lines.add(start + i)
    }
  }
  for (const [file, set] of result) if (set.size === 0) result.delete(file)
  return result
}
