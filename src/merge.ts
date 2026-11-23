import type { MutantStatus, RunResult } from './run.ts'

const statuses: MutantStatus[] = ['Killed', 'Survived', 'Unconfirmed', 'Led', 'Timeout', 'NoCoverage', 'Static', 'Pending']

const union = (lists: string[][]) => [...new Set(lists.flat())].sort()
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/**
 * One report from the reports of every share of a run made with `--shard`.
 * Each mutant's verdict is the one its share gave; nothing is judged again.
 * The shares must be those of one count, each once, and no mutant may be in
 * two of them: a share left out would leave its mutants out of the score
 * without a word. Test counts and rounds are the largest share's, since the
 * shares ran test files in common; times add up the processes' work and
 * take the longest share's wall-clock time.
 */
export function mergeReports(reports: RunResult[]): RunResult {
  if (reports.length === 0) throw new Error('no reports to merge')
  const count = reports[0].shard?.count
  if (count === undefined || reports.some((report) => report.shard?.count !== count)) {
    throw new Error('every report must come from a run with --shard and the same number of shares')
  }
  const indices = reports.map((report) => report.shard!.index).sort((a, b) => a - b)
  const expected = Array.from({ length: count }, (_, i) => i + 1)
  if (indices.join() !== expected.join()) {
    throw new Error(`shares ${indices.join(', ')} given; ${count} shares need each of ${expected.join(', ')} once`)
  }
  const versions = new Set(reports.map((report) => report.vitestVersion))
  if (versions.size > 1) throw new Error(`the shares ran different versions of Vitest: ${[...versions].join(', ')}`)

  const seen = new Set<string>()
  // Each file is in one share, and in file order the mutants come as one run of all of them gives them.
  const byFile = (a: { file: string }, b: { file: string }) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const mutants = reports.flatMap((report) => report.mutants).sort(byFile).map((mutant, id) => {
    const key = JSON.stringify([mutant.file, mutant.location, mutant.mutator, mutant.replacement])
    if (seen.has(key)) throw new Error(`a mutant is in two shares: ${mutant.file}:${mutant.location.start.line}:${mutant.location.start.column + 1} ${mutant.mutator}`)
    seen.add(key)
    // Ids are each share's own, and the merged report names every mutant once.
    return { ...mutant, id }
  })
  const counts = Object.fromEntries(statuses.map((status) => [status, sum(reports.map((report) => report.counts[status] ?? 0))])) as RunResult['counts']
  const projects: Record<string, number> = {}
  for (const report of reports) {
    for (const [project, files] of Object.entries(report.leftOut.projects)) projects[project] = Math.max(projects[project] ?? 0, files)
  }
  const nearest = reports.every((report) => report.nearest)
    ? {
        detected: reports.map((report) => report.nearest!.detected).reduce((a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0))),
        ms: reports.map((report) => report.nearest!.ms).reduce((a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0))),
      }
    : undefined
  const wholeRuns = { ...reports[0].wholeRuns }
  for (const kind of Object.keys(wholeRuns) as (keyof typeof wholeRuns)[]) wholeRuns[kind] = sum(reports.map((report) => report.wholeRuns[kind]))

  return {
    mutants,
    counts,
    timings: {
      generateMs: Math.max(...reports.map((report) => report.timings.generateMs)),
      compareMs: Math.max(...reports.map((report) => report.timings.compareMs)),
      vitestMs: Math.max(...reports.map((report) => report.timings.vitestMs)),
      totalMs: Math.max(...reports.map((report) => report.timings.totalMs)),
    },
    testFiles: Math.max(...reports.map((report) => report.testFiles)),
    tests: Math.max(...reports.map((report) => report.tests)),
    failedBaselines: union(reports.map((report) => report.failedBaselines)),
    neverPassedTests: union(reports.map((report) => report.neverPassedTests)),
    flakyTests: union(reports.map((report) => report.flakyTests)),
    leftOut: {
      projects,
      typeTests: Math.max(...reports.map((report) => report.leftOut.typeTests)),
      browserTests: Math.max(...reports.map((report) => report.leftOut.browserTests)),
      ...(reports.some((report) => report.leftOut.typeCheck) ? { typeCheck: true } : {}),
      ...(reports.some((report) => report.leftOut.poolArgv) ? { poolArgv: union(reports.map((report) => report.leftOut.poolArgv ?? [])) } : {}),
    },
    quietRuns: {
      failed: sum(reports.map((report) => report.quietRuns.failed)),
      passed: sum(reports.map((report) => report.quietRuns.passed)),
    },
    exclusiveFiles: union(reports.map((report) => report.exclusiveFiles)),
    unsureFiles: union(reports.map((report) => report.unsureFiles)),
    changedFiles: union(reports.map((report) => report.changedFiles)),
    removedTempDirs: union(reports.map((report) => report.removedTempDirs)),
    nonRepeatableTests: union(reports.map((report) => report.nonRepeatableTests)),
    suiteErrors: union(reports.map((report) => report.suiteErrors)),
    // One entry a file, the first report's, where two shares gave it up.
    abandonedFiles: [...new Map(reports.flatMap((report) => report.abandonedFiles).reverse().map((entry) => [entry.file, entry])).values()].sort((a, b) => (a.file < b.file ? -1 : 1)),
    rounds: Math.max(...reports.map((report) => report.rounds)),
    wholeRuns,
    work: {
      trials: sum(reports.map((report) => report.work.trials)),
      trialCpuMs: sum(reports.map((report) => report.work.trialCpuMs)),
      wholeMs: {
        passed: sum(reports.map((report) => report.work.wholeMs.passed)),
        detected: sum(reports.map((report) => report.work.wholeMs.detected)),
      },
      workers: sum(reports.map((report) => report.work.workers)),
    },
    nearest,
    unplaced: sum(reports.map((report) => report.unplaced)),
    // A file with another extension is left out by every share.
    skippedFiles: [...new Map(reports.flatMap((report) => report.skippedFiles).map((skipped) => [skipped.file, skipped])).values()].sort((a, b) => (a.file < b.file ? -1 : 1)),
    vitestVersion: reports[0].vitestVersion,
  }
}
