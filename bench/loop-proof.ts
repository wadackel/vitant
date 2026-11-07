import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { instrument } from '../src/mutate/instrument.ts'

const { values } = parseArgs({ options: { base: { type: 'string' }, out: { type: 'string' } } })
assert(values.base && values.out, 'usage: node bench/loop-proof.ts --base <checkout> --out <new-directory>')
assert(process.platform !== 'win32', 'the diagnostic requires process groups')
const candidate = path.resolve(import.meta.dirname, '..')
const baseline = path.resolve(values.base)
const output = path.resolve(values.out)
assert(!fs.existsSync(output), 'the evidence directory must be new')
fs.mkdirSync(output, { recursive: true })

function identity(root: string) {
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim()
  const files = ['src/run.ts', 'src/session.ts', 'src/runtime/runner.ts', 'src/mutate/instrument.ts']
  return {
    root, commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
    dirty: git(['status', '--porcelain']) !== '',
    sources: Object.fromEntries(files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
  }
}

const identities = { node: process.version, platform: process.platform, baseline: identity(baseline), candidate: identity(candidate) }
fs.writeFileSync(path.join(output, 'identities.json'), JSON.stringify(identities, null, 2))

function execute(label: string, root: string, args: string[], timeout = 120_000): Promise<{ status: number | null; signal: string | null; timedOut: boolean }> {
  const log = fs.openSync(path.join(output, `${label}.log`), 'wx')
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // Killing only Vitest's parent can leave its looping worker alive.
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }, timeout)
  return new Promise((resolve, reject) => {
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, timedOut }) })
  })
}

const spin = 'export function finish() { while (true) { break } }\n'
interface Variant {
  name: string
  source: string
  vm: boolean
  checkCode: boolean
  detected: boolean
  phase?: 'loading' | 'beforeAll' | 'afterAll'
  catchDirect?: boolean
  testTimeout?: number
}
const variants: Variant[] = [
  { name: 'vm-code', source: spin, vm: true, checkCode: true, detected: false },
  { name: 'vm-any', source: spin, vm: true, checkCode: false, detected: false },
  { name: 'direct', source: spin, vm: false, checkCode: false, detected: true },
  { name: 'zero', source: 'export function finish() { let active = false; while (active) { active = false } }\n', vm: false, checkCode: false, detected: false },
  { name: 'coercion', source: 'export function finish() { let n = 0; const value = { valueOf: () => n++ }; while (value < 3) { break } }\n', vm: false, checkCode: false, detected: false },
  { name: 'getter', source: 'export function finish() { let n = 0; const value = { get active() { return n++ < 3 } }; while (value.active) { break } }\n', vm: false, checkCode: false, detected: false },
  { name: 'proxy', source: 'export function finish() { let n = 0; const value = new Proxy({}, { get: () => n++ < 3 }); while (value.active) { break } }\n', vm: false, checkCode: false, detected: false },
  { name: 'long-finite', source: 'export function finish() { let n = 3000000; while (n-- > 0) { void 0 } }\n', vm: false, checkCode: false, detected: false, testTimeout: 5000 },
  { name: 'loading-vm', source: spin, vm: true, checkCode: true, detected: false, phase: 'loading' },
  { name: 'beforeAll-vm', source: spin, vm: true, checkCode: false, detected: false, phase: 'beforeAll' },
  { name: 'afterAll-vm', source: spin, vm: true, checkCode: false, detected: false, phase: 'afterAll' },
  { name: 'afterAll-catch', source: spin, vm: false, checkCode: false, detected: true, phase: 'afterAll', catchDirect: true },
]

const rows: Record<string, unknown>[] = []
const detected = (status: string) => status === 'Killed' || status === 'Timeout'
for (const variant of variants) {
  const root = path.join(output, variant.name)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'test'))
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.symlinkSync(path.join(candidate, 'node_modules/vitest'), path.join(root, 'node_modules/vitest'), 'junction')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  fs.writeFileSync(path.join(root, 'vitest.config.mjs'), `export default { test: { include: ["test/*.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: ${variant.testTimeout ?? 1000}, hookTimeout: ${variant.testTimeout ?? 1000} } }\n`)
  const sourceFile = path.join(root, 'src/spin.ts')
  fs.writeFileSync(sourceFile, variant.source)
  const call = variant.vm
    ? `try { vm.runInNewContext('finish()', { finish }, { timeout: 50 }) } catch (error) { ${variant.checkCode ? "expect(error.code).toBe('ERR_SCRIPT_EXECUTION_TIMEOUT')" : ''} }`
    : variant.catchDirect ? 'try { finish() } catch {}' : 'finish()'
  const hook = variant.phase === 'beforeAll' || variant.phase === 'afterAll' ? `${variant.phase}(() => { ${call} })` : ''
  fs.writeFileSync(path.join(root, 'test/spin.test.ts'), `import vm from 'node:vm'\nimport { it, expect, beforeAll, afterAll } from 'vitest'\nimport { finish } from '../src/spin'\n${variant.phase === 'loading' ? call : ''}\n${hook}\nit('bounds the caller', () => { ${variant.phase ? '' : call}; expect(true).toBe(true) })\n`)
  const result = instrument(variant.source, 'spin.ts', { siteBase: 0, mutantBase: 0 })!
  const body = variant.source.indexOf('{', variant.source.indexOf('while'))
  const mutant = result.mutants.find((m) => m.mutator === 'BlockStatement' && m.start === body)!
  assert(mutant, `no while-body mutant in ${variant.name}`)
  const vitest = path.join(candidate, 'node_modules/vitest/vitest.mjs')
  const original = await execute(`${variant.name}-original`, root, [vitest, 'run'])
  assert.equal(original.status, 0, `${variant.name}: original suite failed`)
  let written
  try {
    fs.writeFileSync(sourceFile, variant.source.slice(0, mutant.start) + mutant.replacement + variant.source.slice(mutant.end))
    written = await execute(`${variant.name}-written`, root, [vitest, 'run'], 8_000)
  } finally {
    fs.writeFileSync(sourceFile, variant.source)
  }
  assert.equal(written.status !== 0, variant.detected, `${variant.name}: unexpected source-written result`)
  if (variant.detected) assert(written.timedOut, `${variant.name}: expected a nonterminating source-written loop, not another failure`)
  const statuses: Record<string, string> = {}
  for (const [name, tool] of [['baseline', baseline], ['prototype', candidate]]) {
    const report = path.join(output, `${variant.name}-${name}.json`)
    const run = await execute(`${variant.name}-${name}`, root, [path.join(tool, 'src/cli.ts'), '--root', root, '--mutate', 'src/spin.ts', '--report', report, '--max-workers', '1', ...(variant.phase === 'loading' ? ['--static'] : [])])
    assert.equal(run.status, 0, `${variant.name}: ${name} CLI failed`)
    const data = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.equal(data.tests, 1, `${variant.name}: ${name} did not collect the expected test`)
    assert.equal(data.testFiles, 1, `${variant.name}: ${name} did not collect the expected file`)
    assert.equal(data.counts.Pending + data.counts.Unconfirmed, 0, `${variant.name}: ${name} left the result open`)
    const entry = data.mutants.find((m: { mutator: string; location: unknown }) => m.mutator === mutant.mutator && JSON.stringify(m.location) === JSON.stringify(mutant.loc))
    assert(entry, `${variant.name}: ${name} report lost the while-body mutant`)
    statuses[name] = entry.status
  }
  assert.equal(detected(statuses.baseline), variant.detected, `${variant.name}: baseline disagrees with source-written suite`)
  if (!variant.detected) assert.equal(statuses.baseline, variant.name === 'zero' ? 'NoCoverage' : 'Survived')
  const row = { name: variant.name, phase: variant.phase ?? 'test', static: variant.phase === 'loading', original, written, statuses, prototypeAgrees: detected(statuses.prototype) === variant.detected }
  rows.push(row)
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(rows, null, 2))
  console.log(JSON.stringify(row))
}
for (const name of ['vm-code', 'vm-any']) assert(rows.find((row) => row.name === name)?.prototypeAgrees === false, `${name}: counterexample not reproduced`)
for (const name of ['direct', 'zero', 'coercion', 'getter', 'proxy', 'long-finite']) assert(rows.find((row) => row.name === name)?.prototypeAgrees === true, `${name}: control changed`)
console.log(`Rejected early-exit prototype: ${JSON.stringify(rows.filter((row) => row.prototypeAgrees === false).map((row) => row.name))}`)
