import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { elementsPage, toElements } from '../src/elements.ts'
import type { MutantResult, RunResult } from '../src/run.ts'

const mutant = (more: Partial<MutantResult>): MutantResult => ({
  id: 0,
  file: 'src/a.ts',
  mutator: 'ArithmeticOperator',
  replacement: 'a - b',
  location: { start: { line: 1, column: 29 }, end: { line: 1, column: 34 } },
  status: 'Survived',
  static: false,
  coveredBy: 1,
  killedBy: 0,
  ...more,
})

it('writes the result as mutation-testing-elements reads it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-elements-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const add = (a, b) => a + b\nexport const tag = "</script>"\n')
  const result = {
    mutants: [
      mutant({ id: 0, status: 'Killed', evidence: [{ kind: 'lead', file: 'a.test.ts', test: 'adds' }, { kind: 'failed', file: 'a.test.ts', test: 'adds' }] }),
      mutant({ id: 1, status: 'Static', static: true }),
      mutant({ id: 2, status: 'Timeout', timeoutCause: 'loop limit', evidence: [{ kind: 'timeout', file: 'a.test.ts' }] }),
    ],
  } as RunResult
  const report = toElements(result, root, '1.2.3')
  fs.rmSync(root, { recursive: true })

  const file = report.files['src/a.ts']
  expect(file.language).toBe('typescript')
  // Columns from one: the mutant covers `a + b`.
  const { start, end } = file.mutants[0].location
  expect(file.source.split('\n')[0].slice(start.column - 1, end.column - 1)).toBe('a + b')
  expect(file.mutants.map((entry) => [entry.id, entry.status, entry.statusReason])).toEqual([
    ['0', 'Killed', 'a.test.ts > adds: failed'],
    ['1', 'Ignored', expect.stringContaining('--static')],
    ['2', 'Timeout', 'a.test.ts: loop limit'],
  ])

  // The source holds what would end the script element the report sits in.
  const page = elementsPage(report)
  expect(page.match(/<\/script>/g)).toHaveLength(2)
  const data = page.slice(page.indexOf('.report = ') + '.report = '.length, page.lastIndexOf('\n    </script>'))
  expect(JSON.parse(data)).toEqual(report)
})
