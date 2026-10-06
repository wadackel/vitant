// Checks that instrumented code with no mutant on behaves like the code it
// was made from, over the tests of test262: each test is run as it is and
// instrumented, and the two outcomes must match.
//
//   node bench/conformance.ts <path to test262> [filter ...]
//
// With `CONFORMANCE_MUTANTS=<n>`, up to that many mutants per test, taken
// from the code the test runs, are also switched on one at a time and compared
// with the test's text with the mutant written into it.
//
// Tests run in child processes, a few hundred at a time: some of them take
// the engine down, and those are skipped by starting again after them.
//
// Left out: module tests, tests of sloppy mode, tests expected to fail to
// parse, and tests that need the `$262` host object. Code under test here is
// always a module, so everything runs in strict mode.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { types } from 'node:util'
import vm from 'node:vm'
import { instrument, RUNTIME_GLOBAL } from '../src/mutate/instrument.ts'
import { createRuntime } from '../src/session.ts'

const [root, ...filters] = process.argv.slice(2)
if (!root) {
  console.error('usage: node bench/conformance.ts <path to test262> [filter ...]')
  process.exit(1)
}

// Tests leave rejected promises and late errors behind; they are not this runner's to die of.
process.on('unhandledRejection', () => {})
process.on('uncaughtException', () => {})

const harnessDir = path.join(root, 'harness')
const harness = new Map<string, string>()
const include = (name: string): string => {
  let source = harness.get(name)
  if (source === undefined) harness.set(name, (source = fs.readFileSync(path.join(harnessDir, name), 'utf8')))
  return source
}

interface Meta {
  includes: string[]
  flags: string[]
  negative: boolean
}

function metaOf(source: string): Meta {
  const front = /\/\*---([\s\S]*?)---\*\//.exec(source)?.[1] ?? ''
  const list = (key: string): string[] => {
    const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]`, 'm').exec(front)
    if (inline) return inline[1].split(',').map((item) => item.trim()).filter(Boolean)
    const block = new RegExp(`^${key}:\\s*\\n((?:\\s+-.*\\n?)+)`, 'm').exec(front)
    return block ? block[1].split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : []
  }
  return { includes: list('includes'), flags: list('flags'), negative: /^negative:/m.test(front) }
}

type Outcome = string

const perTest = Number(process.env.CONFORMANCE_MUTANTS ?? 0)

/** Runs one script in a realm of its own and says how it ended. */
async function execute(
  code: string,
  meta: Meta,
  sites: number,
  mutants: number,
  active = -1,
  hits?: (hit: Uint8Array) => void,
): Promise<Outcome> {
  const context = vm.createContext({ console: { log() {} } })
  // Made inside the realm, as it is in a worker: the built-ins it remembers
  // have to be the ones the code calls.
  const makeRuntime = vm.runInContext(`(function (types) { return ${createRuntime.toString()} })`, context)(types)
  const runtime = makeRuntime(sites, mutants)
  runtime.a = active
  // A mutant that makes a loop endless ends here on one side and at the time
  // limit on the other; both are left out of the comparison.
  if (active >= 0) runtime.l = 1_000_000
  context[RUNTIME_GLOBAL] = runtime
  let done: (outcome: Outcome) => void = () => {}
  const finished = new Promise<Outcome>((resolve) => (done = resolve))
  context.print = (message: unknown) => {
    const text = String(message)
    if (text === 'Test262:AsyncTestComplete') done('pass')
    else if (text.startsWith('Test262:AsyncTestFailure')) done(`async ${text.split(':')[2] ?? ''}`.trim())
  }
  const prelude = meta.flags.includes('raw')
    ? ''
    : ['assert.js', 'sta.js', ...(meta.flags.includes('async') ? ['doneprintHandle.js'] : []), ...meta.includes]
        .map(include)
        .join('\n')
  try {
    if (prelude) vm.runInContext(prelude, context, { timeout: 2000 })
    vm.runInContext(`"use strict";\n${code}`, context, { timeout: 2000 })
  } catch (error) {
    hits?.(runtime.h)
    const { constructor, message } = (error ?? {}) as { constructor?: { name?: string }; message?: unknown }
    return `throws ${constructor?.name ?? typeof error}: ${String(message).split('\n')[0].slice(0, 120)}`
  }
  hits?.(runtime.h)
  if (!meta.flags.includes('async')) return 'pass'
  return Promise.race([finished, new Promise<Outcome>((resolve) => setTimeout(() => resolve('async timeout'), 1000))])
}

/**
 * What of an outcome the two sides can be held to. The engine words its own
 * errors after the text of the code, which instrumenting changes.
 */
function comparable(outcome: Outcome): string {
  const engine = /^throws (TypeError|ReferenceError|RangeError|SyntaxError)\b/.exec(outcome)
  return engine ? engine[0] : outcome
}

type Result = 'same' | 'skipped' | 'unparsed' | 'uninstrumented' | `different ${string}`

async function compare(file: string): Promise<Result> {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const meta = metaOf(source)
  const unsupported =
    meta.negative ||
    meta.flags.includes('module') ||
    meta.flags.includes('noStrict') ||
    source.includes('$262') ||
    source.includes('$DONOTEVALUATE')
  if (unsupported) return 'skipped'
  let result: ReturnType<typeof instrument>
  try {
    result = instrument(source, 'test.js', { siteBase: 0, mutantBase: 0 })
  } catch (error) {
    return `different instrumenting threw ${(error as Error).message.split('\n')[0]}`
  }
  if (!result) return 'unparsed'
  if (result.mutants.length === 0) return 'uninstrumented'
  // A test this runner cannot run as it is says nothing about the instrumented one.
  if ((await execute(source, meta, 1, 1)) !== 'pass') return 'skipped'
  let hit: Uint8Array = new Uint8Array(0)
  const actual = await execute(result.code, meta, result.siteCount + 1, result.mutants.length + 1, -1, (h) => (hit = h))
  if (actual !== 'pass') return `different ${actual}`
  const reached = result.mutants.filter((mutant) => hit[mutant.site] === 1)
  const step = Math.max(1, Math.floor(reached.length / perTest))
  for (let at = 0, tried = 0; at < reached.length && tried < perTest; at += step, tried++) {
    const mutant = reached[at]
    // Statements, chain links and templates, which may follow a tag, go in
    // as they are; any other expression is parenthesised so that it keeps
    // the operands it had.
    const verbatim =
      ['BlockStatement', 'MethodExpression', 'OptionalChaining'].includes(mutant.mutator) ||
      /^(case|default)\b/.test(mutant.replacement) ||
      mutant.replacement.startsWith('`')
    const written = verbatim ? mutant.replacement : `(${mutant.replacement})`
    const switched = comparable(
      await execute(result.code, meta, result.siteCount + 1, result.mutants.length + 1, mutant.id),
    )
    // Code that leaves semicolons out at line ends reads a parenthesis at
    // the start of a line as a call of the line before; the semicolon that
    // prevents it cannot be put inside an expression. Either may be right.
    const texts = [written, `;${written}`].map((text) => source.slice(0, mutant.start) + text + source.slice(mutant.end))
    const expected: string[] = []
    for (const text of texts) {
      expected.push(comparable(await execute(text, meta, 1, 1)))
      if (expected.at(-1) === switched) break
    }
    const endless = (outcome: string) => /timed out|loop iteration limit|async timeout/.test(outcome)
    if (expected.some(endless) || endless(switched) || expected.includes(switched)) continue
    return `different mutant ${mutant.mutator} ${JSON.stringify(mutant.replacement)} at ${mutant.start}: written ${expected[0]} | switched ${switched}`
  }
  return 'same'
}

if (process.env.CONFORMANCE_LIST) {
  const out = fs.openSync(process.env.CONFORMANCE_OUT!, 'a')
  for (const file of fs.readFileSync(process.env.CONFORMANCE_LIST, 'utf8').split('\n').filter(Boolean)) {
    fs.writeSync(out, `start ${file}\n`)
    fs.writeSync(out, `end ${file}\t${await compare(file)}\n`)
  }
  process.exit(0)
}

const files = fs
  .globSync('test/**/*.js', { cwd: root })
  .filter((file) => !file.includes('_FIXTURE') && !file.startsWith('test/harness/'))
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
  .sort()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-'))
const counts: Record<string, number> = { same: 0, different: 0, skipped: 0, unparsed: 0, uninstrumented: 0, crashed: 0 }
const differences: string[] = []
const BATCH = 400
for (let at = 0; at < files.length; ) {
  const batch = files.slice(at, at + BATCH)
  const list = path.join(tmp, 'list')
  const out = path.join(tmp, 'out')
  fs.writeFileSync(list, batch.join('\n'))
  fs.rmSync(out, { force: true })
  spawnSync(process.execPath, [import.meta.filename, root], {
    env: { ...process.env, CONFORMANCE_LIST: list, CONFORMANCE_OUT: out },
    stdio: 'ignore',
    timeout: 600_000,
  })
  const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean) : []
  let finished = 0
  for (const line of lines) {
    if (!line.startsWith('end ')) continue
    finished++
    const [file, result] = line.slice(4).split('\t')
    if (result.startsWith('different ')) {
      counts.different++
      differences.push(`${file}: ${result.slice(10)}`)
      // As they come: a run over everything takes hours.
      console.log(differences.at(-1))
    } else counts[result]++
  }
  // The process ended inside a test: that one is skipped.
  if (finished < batch.length) {
    counts.crashed++
    differences.push(`${batch[finished]}: took the process down`)
    finished++
  }
  at += finished
  if (Math.floor(at / 5000) !== Math.floor((at - finished) / 5000)) console.error(`${at}/${files.length}`, JSON.stringify(counts))
}
fs.rmSync(tmp, { recursive: true, force: true })

console.log(JSON.stringify(counts))
process.exit(differences.length > 0 ? 1 : 0)
