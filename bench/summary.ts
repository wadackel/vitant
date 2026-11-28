// Prints what bench/run.ts recorded for a scope as a Markdown table.
//
//   node bench/summary.ts <target> <scope>

import fs from 'node:fs'
import path from 'node:path'

const [target, scope] = process.argv.slice(2)
const file = path.join(import.meta.dirname, 'results', `${target}-${scope}`, 'summary.json')
const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
const { machine } = summary
const running: { tool: string; run: number; of: number; startedAt: string } | undefined = summary.running

/** How far the run that the job's limit ended had come, by its log: the report is only written at its end. */
function progress(tool: string): { time: string; counts: string } {
  const log = path.join(path.dirname(file), `${tool}.log`)
  const run = `ended in run ${running!.run} of ${running!.of}`
  if (!fs.existsSync(log)) return { time: `${run}, with no log`, counts: '' }
  const time = `${run}, its log last written ${((fs.statSync(log).mtimeMs - Date.parse(running!.startedAt)) / 60_000).toFixed(1)} min in`
  const lines = fs.readFileSync(log, 'utf8').split('\n')
  // StrykerJS runs here without its progress reporter: its log has only the count it instrumented.
  if (tool === 'stryker') {
    const mutants = lines.findLast((line) => / with \d+ mutant\(s\)/.test(line))?.match(/ with (\d+) mutant\(s\)/)?.[1]
    return { time, counts: mutants ? `${mutants} mutants` : '' }
  }
  // The last count is the one after files the project's plugins do not compile instrumented are left out.
  const mutants = lines.findLast((line) => /(^|: )\d+ mutants in \d+ files/.test(line))?.match(/(?:^|: )(\d+) mutants in/)?.[1]
  const round = lines.findLast((line) => /^round \d+ took .* mutants detected so far$/.test(line))?.match(/^round (\d+) took .*, (\d+) mutants/)
  return { time, counts: round ? `${round[2]} of ${mutants ?? '?'} detected after round ${round[1]}` : `${mutants ?? '?'} mutants, no round done` }
}

console.log(`### ${target} \`${scope}\``)
console.log(`${machine.platform}, ${machine.cores} × ${machine.cpu}, Node ${machine.node}${machine.workers ? `, ${machine.workersOf} with ${machine.workers} workers` : ''}\n`)
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
  if (running?.tool === tool) {
    const cut = progress(tool)
    console.log(`| ${tool} | ${[...time, cut.time].join(', ')} | ${cut.counts} | | |`)
  } else console.log(`| ${tool} | ${time.join(', ')} | ${counts} | ${runs} | ${report?.truth ?? ''} |`)
}
for (const [tool, reason] of Object.entries<string>(summary.notRun ?? {})) {
  if (!summary.timings[tool]) console.log(`| ${tool} | not run: ${reason} | | | |`)
}

const strykerFile = path.join(path.dirname(file), 'stryker.json')
if (summary.timings.stryker?.exitCodes.at(-1) === 0 && fs.existsSync(strykerFile)) {
  const stryker = JSON.parse(fs.readFileSync(strykerFile, 'utf8')) as {
    files: Record<string, { mutants: { status: string; testsCompleted?: number; coveredBy?: string[] }[] }>
  }
  const untested = Object.values(stryker.files).flatMap((file) => file.mutants).filter(
    (mutant) => mutant.status === 'Survived' && mutant.testsCompleted === 0 && (mutant.coveredBy?.length ?? 0) > 0,
  ).length
  if (untested) console.log(`\nStrykerJS: ${untested} covered mutant(s) were reported as survived without running a test. Its timings are not comparable for this run.`)
}
