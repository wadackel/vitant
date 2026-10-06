// Matches the mutants of a StrykerJS JSON report against ours and tabulates
// how the two tools judged each one.
//
//   node bench/compare.ts <stryker-report.json> <vitant-report.json> [--list]

import fs from 'node:fs'
import type { RunResult } from '../src/run.ts'

interface StrykerMutant {
  mutatorName: string
  replacement?: string
  status: string
  statusReason?: string
  location: { start: { line: number; column: number }; end: { line: number; column: number } }
}

interface StrykerReport {
  files: Record<string, { mutants: StrykerMutant[] }>
}

const [strykerPath, oursPath, ...flags] = process.argv.slice(2)
const stryker: StrykerReport = JSON.parse(fs.readFileSync(strykerPath, 'utf8'))
const ours: RunResult = JSON.parse(fs.readFileSync(oursPath, 'utf8'))

// Stryker prints replacements from its AST while ours are source slices, so
// formatting differs for the same mutation.
const normalize = (text: string) => text.replace(/[\s;()'"`]/g, '').replace(/,(?=[\]}])/g, '')

const keyOf = (
  file: string,
  mutator: string,
  location: StrykerMutant['location'],
  columnOffset: number,
) =>
  [
    file,
    mutator,
    location.start.line,
    location.start.column + columnOffset,
    location.end.line,
    location.end.column + columnOffset,
  ].join('|')

const strykerByKey = new Map<string, StrykerMutant[]>()
let strykerTotal = 0
for (const [file, { mutants }] of Object.entries(stryker.files)) {
  for (const mutant of mutants) {
    strykerTotal++
    const key = keyOf(file, mutant.mutatorName, mutant.location, 0)
    strykerByKey.set(key, [...(strykerByKey.get(key) ?? []), mutant])
  }
}

const matrix = new Map<string, number>()
const disagreements: string[] = []
const oursOnly = new Map<string, number>()
let matched = 0
for (const mutant of ours.mutants) {
  // Our columns are 0-based, the report schema's are 1-based.
  const key = keyOf(mutant.file, mutant.mutator, mutant.location, 1)
  const candidates = strykerByKey.get(key) ?? []
  const index = candidates.findIndex(
    (candidate) => normalize(candidate.replacement ?? '') === normalize(mutant.replacement),
  )
  if (index === -1) {
    oursOnly.set(mutant.mutator, (oursOnly.get(mutant.mutator) ?? 0) + 1)
    continue
  }
  const [other] = candidates.splice(index, 1)
  matched++
  const cell = `${other.status} -> ${mutant.status}`
  matrix.set(cell, (matrix.get(cell) ?? 0) + 1)
  const detected = (status: string) => status === 'Killed' || status === 'Timeout'
  const judged = (status: string) => detected(status) || status === 'Survived'
  if (judged(other.status) && judged(mutant.status) && detected(other.status) !== detected(mutant.status)) {
    disagreements.push(
      `${mutant.file}:${mutant.location.start.line}:${mutant.location.start.column + 1} ` +
        `${mutant.mutator} ${JSON.stringify(mutant.replacement.slice(0, 50))} ` +
        `stryker=${other.status} ours=${mutant.status}${mutant.static ? ' (static)' : ''}`,
    )
  }
}

const strykerOnly = new Map<string, number>()
for (const candidates of strykerByKey.values()) {
  for (const candidate of candidates) {
    strykerOnly.set(candidate.mutatorName, (strykerOnly.get(candidate.mutatorName) ?? 0) + 1)
  }
}

const sum = (map: Map<string, number>) => [...map.values()].reduce((a, b) => a + b, 0)
const table = (map: Map<string, number>) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `  ${String(count).padStart(6)}  ${name}`)
    .join('\n')

console.log(`stryker mutants: ${strykerTotal}, ours: ${ours.mutants.length}, matched: ${matched}`)
console.log(`only in stryker: ${sum(strykerOnly)}\n${table(strykerOnly)}`)
console.log(`only in ours: ${sum(oursOnly)}\n${table(oursOnly)}`)
console.log(`status (stryker -> ours):\n${table(matrix)}`)
console.log(`detected/undetected disagreements among mutants both tools ran: ${disagreements.length}`)
if (flags.includes('--list')) console.log(disagreements.join('\n'))
