// The result in the format `mutation-testing-elements` displays
// (https://github.com/stryker-mutator/mutation-testing-elements, report schema 2),
// as JSON or as a page that shows it.

import fs from 'node:fs'
import path from 'node:path'
import type { MutantResult, RunResult } from './run.ts'

interface ElementsMutant {
  id: string
  mutatorName: string
  replacement: string
  location: MutantResult['location']
  status: 'Killed' | 'Survived' | 'Timeout' | 'NoCoverage' | 'Ignored' | 'Pending'
  statusReason?: string
  static: boolean
}

export interface ElementsReport {
  schemaVersion: '2'
  thresholds: { high: number; low: number }
  projectRoot: string
  framework: { name: string; version: string }
  files: Record<string, { language: string; source: string; mutants: ElementsMutant[] }>
}

const languages: Record<string, string> = { '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript' }

function reason(mutant: MutantResult): string | undefined {
  if (mutant.status === 'Static') return 'runs only while a module loads; --static has such mutants run'
  // A lead decided nothing; the run of the file did.
  const run = mutant.evidence?.find((entry) => entry.kind !== 'lead')
  if (!run) return mutant.timeoutCause
  const where = run.test ? `${run.file} > ${run.test}` : run.file
  return `${where}: ${mutant.timeoutCause ?? run.kind}`
}

export function toElements(result: RunResult, root: string, version: string): ElementsReport {
  const files: ElementsReport['files'] = {}
  for (const mutant of result.mutants) {
    const file = (files[mutant.file] ??= {
      language: languages[path.extname(mutant.file)] ?? 'javascript',
      // As it is now: the result does not carry the sources, and one that changed
      // under the run is named there as changed.
      source: fs.readFileSync(path.join(root, mutant.file), 'utf8'),
      mutants: [],
    })
    const { start, end } = mutant.location
    file.mutants.push({
      id: String(mutant.id),
      mutatorName: mutant.mutator,
      replacement: mutant.replacement,
      // The format counts columns from one.
      location: { start: { line: start.line, column: start.column + 1 }, end: { line: end.line, column: end.column + 1 } },
      status: mutant.status === 'Static' ? 'Ignored' : mutant.status,
      statusReason: reason(mutant),
      static: mutant.static,
    })
  }
  return { schemaVersion: '2', thresholds: { high: 80, low: 60 }, projectRoot: root, framework: { name: 'vitant', version }, files }
}

/**
 * A page that loads the viewer from a CDN and hands it the report. The
 * version is named: the newest one is not bound to read a report written
 * for this one, and a page kept for a year is to open as it did.
 */
export function elementsPage(report: ElementsReport): string {
  // Inside a script element `<` could end it, whatever string it is in.
  const data = JSON.stringify(report).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>vitant</title>
    <script src="https://www.unpkg.com/mutation-testing-elements@3.9.0/dist/mutation-test-elements.js"></script>
  </head>
  <body>
    <mutation-test-report-app title-postfix="vitant"></mutation-test-report-app>
    <script>
      document.querySelector('mutation-test-report-app').report = ${data}
    </script>
  </body>
</html>
`
}
