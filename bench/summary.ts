// Prints what bench/run.ts recorded for a scope as a Markdown table.
//
//   node bench/summary.ts <target> <scope>

import fs from 'node:fs'
import path from 'node:path'

const [target, scope] = process.argv.slice(2)
const file = path.join(import.meta.dirname, 'results', `${target}-${scope}`, 'summary.json')
const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
const { machine } = summary

console.log(`### ${target} \`${scope}\``)
console.log(`${machine.platform}, ${machine.cores} × ${machine.cpu}, Node ${machine.node}\n`)
console.log('| Tool | Time | Verdicts | Whole-file runs | Against the suite |')
console.log('|---|---|---|---|---|')
for (const [tool, timing] of Object.entries<{ seconds: number[]; exitCodes: number[] }>(summary.timings)) {
  const report = summary.reports?.[tool]
  const counts = report
    ? Object.entries(report.counts)
        .filter(([, count]) => count !== 0)
        .map(([status, count]) => `${status} ${count}`)
        .join(', ')
    : ''
  const runs = report
    ? Object.entries(report.wholeRuns)
        .filter(([, count]) => count !== 0)
        .map(([how, count]) => `${count} ${how}`)
        .join(', ')
    : ''
  const time = timing.seconds.map((seconds, index) => `${seconds} s${timing.exitCodes[index] === 0 ? '' : ` (exit ${timing.exitCodes[index]})`}`)
  console.log(`| ${tool} | ${time.join(', ')} | ${counts} | ${runs} | ${report?.truth ?? ''} |`)
}
