// Ground truth for a report: what the project's own suite does with each
// mutant written into the source for real.
//
//   node bench/truth.ts make --root <project> --report <report.json> --out <truth.json>
//        [--related] [--jobs N] [--timeout seconds] [--statuses Killed,Survived,...]
//   node bench/truth.ts check --report <report.json> --truth <truth.json>
//
// `make` runs the suite once per mutant and then checks the report against
// what it saw; `check` does only the latter, against what an earlier `make`
// wrote. Both exit with 1 when a verdict and the suite disagree.
//
// `--related` runs only the test files that import the mutated file
// (`vitest related`) in place of the whole suite.
//
// With `--jobs` above 1 the runs are spread over copies of the project made
// next to it, which share its `node_modules`. That is only sound for a
// project that does not reach its own sources through `node_modules`: a
// workspace package or a link to itself resolves to the original, where
// the mutant is not.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { parseSync } from 'oxc-parser'
import type { MutantResult, RunResult } from '../src/run.ts'

type Suite = 'pass' | 'fail' | 'timeout'

interface Truth {
  /** The Vitest arguments each run was made with, after the mutated file where `related`. */
  command: 'run' | 'related'
  mutants: TruthEntry[]
}

interface TruthEntry {
  file: string
  start: [line: number, column: number]
  end: [line: number, column: number]
  mutator: string
  replacement: string
  suite: Suite
  /** Why a verdict that differs from `suite` is not a wrong one. Written by hand. */
  note?: string
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string' },
    report: { type: 'string' },
    out: { type: 'string' },
    truth: { type: 'string' },
    related: { type: 'boolean', default: false },
    jobs: { type: 'string', default: '1' },
    timeout: { type: 'string' },
    statuses: { type: 'string', default: 'Killed,Timeout,Survived,NoCoverage' },
  },
})
const [mode] = positionals
if ((mode !== 'make' && mode !== 'check') || !values.report || (mode === 'make' ? !values.root : !values.truth)) {
  console.error(
    'usage: node bench/truth.ts make --root <project> --report <report.json> [--out <truth.json>] [--related] [--jobs N]\n' +
      '       node bench/truth.ts check --report <report.json> --truth <truth.json>',
  )
  process.exit(2)
}

const report: RunResult = JSON.parse(fs.readFileSync(values.report, 'utf8'))

const keyOf = (entry: Pick<TruthEntry, 'file' | 'start' | 'end' | 'mutator' | 'replacement'>) =>
  [entry.file, ...entry.start, ...entry.end, entry.mutator, entry.replacement].join('|')
const describe = (mutant: MutantResult): Omit<TruthEntry, 'suite'> => ({
  file: mutant.file,
  start: [mutant.location.start.line, mutant.location.start.column],
  end: [mutant.location.end.line, mutant.location.end.column],
  mutator: mutant.mutator,
  replacement: mutant.replacement,
})

function offset(text: string, [line, column]: [number, number]): number {
  let at = 0
  for (let i = 1; i < line; i++) at = text.indexOf('\n', at) + 1
  return at + column
}

/**
 * The source with the mutant written in. Text in place of an expression can
 * regroup the operators around it, so it goes in parentheses; at the start
 * of a line those can turn the line before into a call, which a semicolon
 * prevents. Each form is kept only if it parses to the parentheses standing
 * where the node stood.
 */
function written(file: string, source: string, entry: Omit<TruthEntry, 'suite'>): string {
  const start = offset(source, entry.start)
  const end = offset(source, entry.end)
  const put = (text: string) => source.slice(0, start) + text + source.slice(end)
  // These replace statements, not expressions.
  const statement = entry.mutator === 'BlockStatement' || /^(case\b.*|default):$/s.test(entry.replacement)
  if (statement) return put(entry.replacement)
  for (const prefix of ['', ';']) {
    const text = put(`${prefix}(${entry.replacement})`)
    const parsed = parseSync(file, text, { preserveParens: true })
    if (parsed.errors.length > 0) continue
    const from = start + prefix.length
    const to = from + entry.replacement.length + 2
    let found = false
    const visit = (node: unknown): void => {
      if (found || node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(visit)
      const { type, start, end } = node as { type?: string; start?: number; end?: number }
      if (typeof start === 'number' && typeof end === 'number' && (end <= from || start >= to)) return
      if (type === 'ParenthesizedExpression' && start === from && end === to) found = true
      else Object.values(node).forEach(visit)
    }
    visit(parsed.program)
    if (found) return text
  }
  throw new Error(`no way to write ${entry.mutator} at ${entry.file}:${entry.start.join(':')}`)
}

/** Vitest as the project resolves it. */
function vitestBin(root: string): string {
  const manifest = createRequire(path.join(root, 'package.json')).resolve('vitest/package.json')
  return path.join(path.dirname(manifest), 'vitest.mjs')
}

function runSuite(root: string, args: string[], limitMs: number): Promise<{ suite: Suite; ms: number }> {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    // Its own process group: a mutant can leave workers the suite never ends.
    const child = spawn(process.execPath, [vitestBin(root), ...args], {
      cwd: root,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, CI: 'true' },
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
    }, limitMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ suite: timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail', ms: performance.now() - startedAt })
    })
  })
}

/** Copies of the project next to it, each with links in place of the `node_modules` directories. */
function copies(root: string, count: number): string[] {
  if (count <= 1) return [root]
  return Array.from({ length: count }, (_, index) => {
    const copy = path.join(path.dirname(root), `.tmp-truth-${process.pid}-${index}`)
    const links: string[] = []
    fs.cpSync(root, copy, {
      recursive: true,
      filter: (source) => {
        const name = path.basename(source)
        if (name === 'node_modules') links.push(path.relative(root, source))
        return name !== 'node_modules' && name !== '.git'
      },
    })
    for (const link of links) fs.symlinkSync(path.join(root, link), path.join(copy, link))
    return copy
  })
}

async function make(): Promise<Truth> {
  const root = fs.realpathSync(values.root!)
  const command = values.related ? 'related' : 'run'
  const argsFor = (file: string) => (values.related ? ['related', '--run', file] : ['run'])
  const wanted = new Set(values.statuses!.split(','))
  const mutants = report.mutants.filter((mutant) => wanted.has(mutant.status))

  // What every run is held against: the same command with no mutant, which has to pass.
  let slowest = 0
  for (const file of values.related ? new Set(mutants.map((mutant) => mutant.file)) : ['']) {
    const baseline = await runSuite(root, argsFor(file), 600_000)
    if (baseline.suite !== 'pass') {
      throw new Error(`vitest ${argsFor(file).join(' ')} does not pass without a mutant: ${baseline.suite}`)
    }
    slowest = Math.max(slowest, baseline.ms)
  }
  const limitMs = values.timeout ? Number(values.timeout) * 1000 : Math.max(20_000, slowest * 5)
  console.error(`suite ${(slowest / 1000).toFixed(1)}s unmutated, ${mutants.length} mutants, limit ${limitMs / 1000}s a run`)

  const roots = copies(root, Number(values.jobs))
  const originals = new Map<string, string>()
  const restore = () => {
    for (const [file, source] of originals) fs.writeFileSync(file, source)
    if (roots.length > 1) for (const copy of roots) fs.rmSync(copy, { recursive: true, force: true })
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      restore()
      process.exit(130)
    })
  }

  const entries: TruthEntry[] = new Array(mutants.length)
  let next = 0
  let done = 0
  try {
    await Promise.all(
      roots.map(async (dir) => {
        while (next < mutants.length) {
          const index = next++
          const entry = describe(mutants[index])
          const file = path.join(dir, entry.file)
          const source = fs.readFileSync(file, 'utf8')
          originals.set(file, source)
          fs.writeFileSync(file, written(file, source, entry))
          const { suite } = await runSuite(dir, argsFor(entry.file), limitMs)
          fs.writeFileSync(file, source)
          originals.delete(file)
          entries[index] = { ...entry, suite }
          if (++done % 25 === 0) console.error(`${done}/${mutants.length}`)
        }
      }),
    )
  } finally {
    restore()
  }
  return { command, mutants: entries }
}

function check(truth: Truth): boolean {
  const byKey = new Map(report.mutants.map((mutant) => [keyOf(describe(mutant)), mutant]))
  const tally = { agree: 0, explained: 0, 'not judged': 0, 'not in the report': 0 }
  const wrong: string[] = []
  for (const entry of truth.mutants) {
    const mutant = byKey.get(keyOf(entry))
    if (!mutant) {
      tally['not in the report']++
      continue
    }
    // A mutant that only runs while a file loads is reported as such, without a verdict.
    if (mutant.status === 'Static' || mutant.status === 'Pending') {
      tally['not judged']++
      continue
    }
    const detected = mutant.status === 'Killed' || mutant.status === 'Timeout'
    if (detected === (entry.suite !== 'pass')) tally.agree++
    else if (entry.note) tally.explained++
    else wrong.push(`${entry.file}:${entry.start.join(':')} ${entry.mutator} -> ${entry.replacement.slice(0, 60)}: suite ${entry.suite}, reported ${mutant.status}`)
  }
  console.log(
    `${truth.mutants.length} mutants checked against the suite: ` +
      Object.entries({ ...tally, wrong: wrong.length })
        .filter(([, count]) => count > 0)
        .map(([name, count]) => `${count} ${name}`)
        .join(', '),
  )
  for (const line of wrong) console.log(`  ${line}`)
  return wrong.length === 0
}

let truth: Truth
if (mode === 'make') {
  truth = await make()
  if (values.out) {
    fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
    const lines = truth.mutants.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')
    fs.writeFileSync(values.out, `{\n  "command": "${truth.command}",\n  "mutants": [\n${lines}\n  ]\n}\n`)
  }
} else {
  truth = JSON.parse(fs.readFileSync(values.truth!, 'utf8'))
}
process.exit(check(truth) ? 0 : 1)
