import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [manifestFile, output, shard = '1/1'] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
const [part, total] = shard.split('/').map(Number)
assert(part >= 1 && part <= total)
const root = fs.realpathSync(manifest.root)
const out = path.resolve(output)
const rows = []
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const timeoutError = (error) => /^(Test|Hook) timed out in \d+ms/.test(error.message ?? '')
const canonicalName = (name) => name.replaceAll(' > ', ' ')

for (const [index, entry] of manifest.cases.entries()) {
  if (index % total !== part - 1) continue
  const dir = path.join(out, String(index).padStart(3, '0'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify(entry, null, 2) + '\n')
  const report = path.join(dir, 'report.json')
  fs.writeFileSync(report, JSON.stringify({ mutants: [entry.mutant] }, null, 2) + '\n')
  const source = path.join(root, entry.mutant.file)
  const selected = path.join(root, entry.file)
  const before = hash(source)
  const testBefore = hash(selected)
  const records = path.join(dir, 'events.jsonl')
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'truth.ts'), 'make',
    '--root', root, '--report', report, '--out', path.join(dir, 'truth.json'), '--timeout=180',
    `--vitest=${entry.file}`, `--vitest=--reporter=${path.join(import.meta.dirname, 'witness-reporter.mjs')}`], {
    env: { ...process.env, VITANT_TRUTH_KEEP: path.join(dir, 'raw'), VITANT_WITNESS_RECORDS: records },
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(dir, 'truth.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  const row = { index, file: entry.file, mutant: entry.mutant.id, expectedKinds: entry.expectedKinds,
    before, after: hash(source), testBefore, testAfter: hash(selected), exitCode: result.status }
  try {
    assert.equal(row.after, before, 'source was not restored')
    assert.equal(row.testAfter, testBefore, 'test source changed')
    assert.equal(result.status, 0, 'source-written truth did not agree')
    const originalSeconds = Number(/suite ([\d.]+)s unmutated/.exec(result.stderr ?? '')?.[1])
    assert(Number.isFinite(originalSeconds) && originalSeconds < 180, 'outer budget does not exceed original duration')
    row.originalSeconds = originalSeconds
    const events = fs.readFileSync(records, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const controls = events.filter((event) => /-0\.json\.errors$/.test(event.run))
    const mutated = events.filter((event) => /-1\.json\.errors$/.test(event.run))
    for (const group of [controls, mutated]) {
      const collected = group.filter((event) => event.event === 'collected')
      assert(collected.length > 0 && collected.every((event) => event.tests > 0 && event.files.every((file) => file === selected)), 'missing or unexpected test file')
    }
    assert(!controls.some((event) => event.event === 'failed'), 'unmutated control failed')
    const original = fs.readdirSync(path.join(dir, 'raw')).find((name) => /-0\.json$/.test(name))
    const control = JSON.parse(fs.readFileSync(path.join(dir, 'raw', original), 'utf8'))
    assert(control.success && control.numPassedTests > 0 && control.numFailedTests === 0, 'unmutated control did not pass')
    const originalTests = control.testResults.flatMap((file) => file.assertionResults)
    for (const name of entry.tests ?? []) {
      const matching = originalTests.filter((test) => canonicalName(test.fullName) === canonicalName(name))
      assert(matching.length === 1 && matching[0].status === 'passed', `missing unmutated witness: ${name}`)
    }
    const failed = mutated.filter((event) => event.event === 'failed' && event.file === selected)
    row.failures = failed.map(({ fullName, errors }) => ({ fullName, errors }))
    row.suite = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8')).mutants[0].suite
    row.ordinary = failed.some((event) => event.errors.some((error) => !timeoutError(error)))
    row.nativeTimeout = failed.some((event) => event.errors.some(timeoutError))
    for (const kind of entry.expectedKinds) {
      assert(kind === 'failed' ? row.ordinary : row.nativeTimeout || row.suite === 'timeout', `missing ${kind} witness`)
    }
    for (const name of entry.tests ?? []) {
      assert(failed.some((event) => canonicalName(event.fullName) === canonicalName(name)
        && event.errors.some((error) => !timeoutError(error))), `missing requested ordinary failure: ${name}`)
    }
    row.verified = true
  } catch (error) {
    row.verified = false
    row.error = error.message
  }
  rows.push(row)
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(rows, null, 2) + '\n')
  console.log(JSON.stringify({ index, mutant: row.mutant, file: row.file, verified: row.verified, suite: row.suite, ordinary: row.ordinary, nativeTimeout: row.nativeTimeout, error: row.error }))
  if (row.after !== before) break
}
assert(rows.length > 0, 'empty shard')
if (rows.some((row) => !row.verified)) process.exitCode = 1
