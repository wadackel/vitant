import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { assertStrykerRestored, prepareStrykerSandbox } from '../bench/sandbox.ts'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-benchmark-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('preserves original-source backups after an interrupted in-place run', () => {
  const backup = path.join(root, '.stryker-tmp/backup-interrupted/src')
  fs.mkdirSync(backup, { recursive: true })
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(backup, 'value.ts'), 'export const value = 1\n')
  fs.writeFileSync(path.join(root, 'src/value.ts'), 'export const value = activeMutant ? 2 : 1\n')

  expect(() => assertStrykerRestored(root)).toThrow(/Stryker.*backup/)
  expect(() => prepareStrykerSandbox(root)).toThrow(/Stryker.*backup/)
  expect(fs.readFileSync(path.join(backup, 'value.ts'), 'utf8')).toBe('export const value = 1\n')
  expect(fs.readFileSync(path.join(root, 'src/value.ts'), 'utf8')).toContain('activeMutant')
})

it('removes an old sandbox when no original-source backup remains', () => {
  const sandbox = path.join(root, '.stryker-tmp/sandbox-completed')
  fs.mkdirSync(sandbox, { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'value.ts'), 'instrumented')
  fs.writeFileSync(path.join(root, 'value.ts'), 'original')

  prepareStrykerSandbox(root)
  expect(fs.existsSync(path.join(root, '.stryker-tmp'))).toBe(false)
  expect(fs.readFileSync(path.join(root, 'value.ts'), 'utf8')).toBe('original')
  expect(() => prepareStrykerSandbox(root)).not.toThrow()
})

it('marks Stryker timings as incomparable when covered survivors ran no tests', () => {
  const target = `.summary-${process.pid}`
  const directory = path.join(import.meta.dirname, '../bench/results', `${target}-scope`)
  fs.mkdirSync(directory, { recursive: true })
  try {
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({
      machine: { platform: 'test', cores: 1, cpu: 'test', node: process.version },
      timings: { stryker: { seconds: [1], exitCodes: [0] } },
    }))
    const stryker = (testsCompleted: number) => ({
      files: { 'source.ts': { mutants: [
        { status: 'Survived', coveredBy: ['test'], testsCompleted },
        { status: 'NoCoverage', coveredBy: [], testsCompleted: 0 },
      ] } },
    })
    const summary = () => spawnSync(process.execPath, [path.join(import.meta.dirname, '../bench/summary.ts'), target, 'scope'], { encoding: 'utf8' })
    fs.writeFileSync(path.join(directory, 'stryker.json'), JSON.stringify(stryker(0)))
    const skipped = summary()
    expect(skipped.status, skipped.stderr).toBe(0)
    expect(skipped.stdout).toContain('1 covered mutant(s) were reported as survived without running a test')
    expect(skipped.stdout).toContain('not comparable')

    fs.writeFileSync(path.join(directory, 'stryker.json'), JSON.stringify(stryker(1)))
    const completed = summary()
    expect(completed.status, completed.stderr).toBe(0)
    expect(completed.stdout).not.toContain('not comparable')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
