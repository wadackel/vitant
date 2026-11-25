import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { assertStrykerRestored, prepareStrykerSandbox } from '../bench/sandbox.ts'
import { type Target, targetEnv, targets, toolWorkers, vitestArgs } from '../bench/targets.ts'

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

it('lists a tool left out of a scope with its reason, unless a run of it was recorded', () => {
  const target = `.notrun-${process.pid}`
  const directory = path.join(import.meta.dirname, '../bench/results', `${target}-scope`)
  fs.mkdirSync(directory, { recursive: true })
  const write = (timings: object) =>
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({
      machine: { platform: 'test', cores: 1, cpu: 'test', node: process.version },
      timings,
      notRun: { stryker: 'it does not end within a job' },
    }))
  const summary = () => spawnSync(process.execPath, [path.join(import.meta.dirname, '../bench/summary.ts'), target, 'scope'], { encoding: 'utf8' })
  try {
    write({ vitant: { seconds: [1], exitCodes: [0] } })
    const left = summary()
    expect(left.status, left.stderr).toBe(0)
    expect(left.stdout).toContain('| stryker | not run: it does not end within a job |')
    write({ stryker: { seconds: [2], exitCodes: [0] } })
    expect(summary().stdout).not.toContain('not run')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it('gives a target its config, projects and filters on the command line', () => {
  const target: Target = { ...targets.ufo, config: 'config/unit.config.ts', projects: ['unit'], filters: ['sqlite.test.ts'] }
  expect(vitestArgs(target)).toEqual(['--config', 'config/unit.config.ts', '--project', 'unit', 'sqlite.test.ts'])
  expect(vitestArgs(targets.ufo)).toEqual([])
})

it("gives this tool the target's workers for the machine's processors, its default otherwise, unless told", () => {
  expect(toolWorkers(targets.headlamp, 3)).toBe(2)
  expect(toolWorkers(targets.headlamp, 4)).toBeUndefined()
  expect(toolWorkers(targets.shopify, 3)).toBeUndefined()
  expect(toolWorkers(targets.headlamp, 3, '3')).toBe(3)
  expect(toolWorkers(targets.shopify, 4, '1')).toBe(1)
  expect(Object.entries(targets).filter(([, target]) => target.workers).map(([name]) => name)).toEqual(['headlamp'])
})

it("sets and removes a target's variables over the environment it is given", () => {
  expect(targetEnv({ env: { TZ: 'UTC', CI: null } }, { dir: '/p', base: { CI: 'true', PATH: '/bin', TZ: 'Asia/Tokyo' } })).toEqual({ PATH: '/bin', TZ: 'UTC' })
  const base = { CI: 'true', PATH: '/bin' }
  expect(targetEnv(targets.ufo, { dir: '/p', base })).toEqual(base)
  expect(targetEnv(targets.ufo, { dir: '/p', base })).not.toBe(base)
})

// Under build/, so that the project resolves this repository's Vitest; the copies go next to it.
function truthProject(files: Record<string, string>, unused = false): string {
  fs.mkdirSync(path.join(import.meta.dirname, '../build'), { recursive: true })
  const project = fs.mkdtempSync(path.join(import.meta.dirname, '../build/truth-copies-'))
  for (const [file, text] of Object.entries({ 'package.json': '{ "type": "module" }\n', 'vitest.config.mjs': 'export default {}\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true })
    // Inside a string of JavaScript, a Windows path's backslashes would read as escapes.
    fs.writeFileSync(path.join(project, file), text.replaceAll('<project>', project.split(path.sep).join('/')))
  }
  // `export const value = 1`, its `1` made `2`.
  const mutant = (file: string, status: string) =>
    ({ file, location: { start: { line: 1, column: 21 }, end: { line: 1, column: 22 } }, mutator: 'NumericLiteral', replacement: '2', status })
  const report = { mutants: [mutant('src/value.ts', 'Killed'), ...(unused ? [mutant('src/unused.ts', 'Survived')] : [])] }
  fs.writeFileSync(path.join(project, 'report.json'), JSON.stringify(report))
  return project
}

function makeTruth(project: string, ...args: string[]) {
  const truth = path.join(import.meta.dirname, '../bench/truth.ts')
  const copies = () => fs.readdirSync(path.dirname(project)).filter((name) => name.startsWith('.tmp-truth-'))
  const before = new Set(copies())
  const run = spawnSync(process.execPath, [truth, 'make', '--root', project, '--report', path.join(project, 'report.json'), '--jobs', '2', ...args], { encoding: 'utf8' })
  const left = copies().filter((name) => !before.has(name))
  return { ...run, source: fs.readFileSync(path.join(project, 'src/value.ts'), 'utf8'), left }
}

it('makes ground truth from copies whose tests run their own sources', { timeout: 60_000 }, () => {
  // `unused.ts` no test loads: a throw in it passes in the checkout as in the copy.
  const project = truthProject({
    'vitest.config.mjs': 'export default { test: { passWithNoTests: true } }\n',
    'src/value.ts': 'export const value = 1\n',
    'src/unused.ts': 'export const value = 1\n',
    'test/value.test.ts': "import { expect, it } from 'vitest'\nimport { value } from '../src/value.ts'\nit('is one', () => expect(value).toBe(1))\n",
  }, true)
  try {
    const made = makeTruth(project, '--related')
    expect(made.status, made.stderr).toBe(0)
    expect(made.stdout).toContain('2 mutants checked against the suite: 2 agree')
    expect(made.source).toBe('export const value = 1\n')
    expect(made.left).toEqual([])
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

it('refuses copies whose tests fail there with no mutant', { timeout: 60_000 }, () => {
  // As lint-staged's tests do, these need the `.git` that a copy is made without.
  const project = truthProject({
    '.git/HEAD': 'ref: refs/heads/main\n',
    'src/value.ts': 'export const value = 1\n',
    'test/value.test.ts':
      "import fs from 'node:fs'\nimport { expect, it } from 'vitest'\nimport { value } from '../src/value.ts'\n" +
      "it('is one in a checkout', () => expect([value, fs.existsSync(new URL('../.git', import.meta.url))]).toEqual([1, true]))\n",
  })
  try {
    const made = makeTruth(project, '--related')
    expect(made.status).not.toBe(0)
    expect(made.stderr).toMatch(/the probe with no mutant failed in the copy \S*\.tmp-truth-\d+-[01]: `vitest related --run src\/value\.ts` for src\/value\.ts fails there/)
    expect(made.stderr).toContain('make ground truth with --jobs 1')
    expect(made.source).toBe('export const value = 1\n')
    expect(made.left).toEqual([])
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

it("refuses copies whose tests load the original's sources", { timeout: 60_000 }, () => {
  // As lobehub's config does, this aliases the sources by a path that leaves a copy for the original.
  const project = truthProject({
    'vitest.config.mjs': "export default { resolve: { alias: { '@src': '<project>/src' } } }\n",
    'src/value.ts': 'export const value = 1\n',
    'test/value.test.ts': "import { expect, it } from 'vitest'\nimport { value } from '@src/value.ts'\nit('is one', () => expect(value).toBe(1))\n",
  })
  try {
    const made = makeTruth(project)
    expect(made.status).not.toBe(0)
    expect(made.stderr).toMatch(/the probe with a throw failed in the copy \S*\.tmp-truth-\d+-[01]: with a throw at the top of the checkout's src\/value\.ts, `vitest run` fails test\/value\.test\.ts there: the copy's tests load the checkout's file/)
    expect(made.source).toBe('export const value = 1\n')
    expect(made.left).toEqual([])
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

// As element-plus's components import its hooks by their package's name, which a copy's node_modules, the checkout's, links to the checkout's sources.
function linkedProject(files: Record<string, string>): string {
  const project = truthProject({ 'src/value.ts': 'export const value = 1\n', ...files })
  fs.mkdirSync(path.join(project, 'node_modules/@app'), { recursive: true })
  fs.symlinkSync('../../src', path.join(project, 'node_modules/@app/value'), 'junction')
  return project
}
const relativeTest = "import { expect, it } from 'vitest'\nimport { value } from '../src/value.ts'\nit('is one', () => expect(value).toBe(1))\n"

it("refuses copies where some of the related test files reach the checkout's sources through a package link", { timeout: 60_000 }, () => {
  const project = linkedProject({
    'test/value.test.ts': relativeTest,
    'test/named.test.ts': "import { expect, it } from 'vitest'\nimport { value } from '@app/value/value.ts'\nit('is one', () => expect(value).toBe(1))\n",
  })
  try {
    const made = makeTruth(project, '--related')
    expect(made.status).not.toBe(0)
    expect(made.stderr).toMatch(/the probe with a throw failed in the copy \S*\.tmp-truth-\d+-[01]: with a throw at the top of its src\/value\.ts, `vitest related --run src\/value\.ts` fails test\/named\.test\.ts in the checkout and not there/)
    expect(made.source).toBe('export const value = 1\n')
    expect(made.left).toEqual([])
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

it("refuses copies where a test file loads both the copy's sources and the checkout's", { timeout: 60_000 }, () => {
  const project = linkedProject({
    'test/value.test.ts':
      "import { expect, it } from 'vitest'\nimport { value } from '../src/value.ts'\nimport { value as named } from '@app/value/value.ts'\n" +
      "it('is one', () => expect([value, named]).toEqual([1, 1]))\n",
  })
  try {
    const made = makeTruth(project, '--related')
    expect(made.status).not.toBe(0)
    expect(made.stderr).toMatch(/the probe with a throw failed in the copy \S*\.tmp-truth-\d+-[01]: with a throw at the top of the checkout's src\/value\.ts, `vitest related --run src\/value\.ts` fails test\/value\.test\.ts there: the copy's tests load the checkout's file/)
    expect(made.source).toBe('export const value = 1\n')
    expect(made.left).toEqual([])
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

it('probes the copies for every mutated file without running a mutant, and names each file it refuses', { timeout: 60_000 }, () => {
  const project = linkedProject({
    'src/other.ts': 'export const value = 1\n',
    'test/value.test.ts': relativeTest,
    'test/named.test.ts': "import { expect, it } from 'vitest'\nimport { value } from '@app/value/value.ts'\nit('is one', () => expect(value).toBe(1))\n",
    'test/other.test.ts': "import { expect, it } from 'vitest'\nimport { value } from '../src/other.ts'\nit('is one', () => expect(value).toBe(1))\n",
    // A file more than there are copies.
    'src/third.ts': 'export const value = 1\n',
    'test/third.test.ts': "import { expect, it } from 'vitest'\nimport { value } from '../src/third.ts'\nit('is one', () => expect(value).toBe(1))\n",
  })
  const report = JSON.parse(fs.readFileSync(path.join(project, 'report.json'), 'utf8'))
  report.mutants.push({ ...report.mutants[0], file: 'src/other.ts', status: 'Survived' }, { ...report.mutants[0], file: 'src/third.ts', status: 'Survived' })
  fs.writeFileSync(path.join(project, 'report.json'), JSON.stringify(report))
  try {
    const truth = path.join(import.meta.dirname, '../bench/truth.ts')
    // Without `--related` too, where `make` probes one file a copy.
    for (const args of [['--related'], []]) {
      const run = spawnSync(process.execPath, [truth, 'probe', '--root', project, '--report', path.join(project, 'report.json'), '--jobs', '2', ...args], { encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(1)
      expect(run.stdout).toContain('accepted: src/other.ts')
      expect(run.stdout).toContain('accepted: src/third.ts')
      // In a whole suite, the copy's run of `named.test.ts` fails with the throw in the checkout's file.
      expect(run.stdout).toMatch(/refused: src\/value\.ts: the probe with a throw failed in the copy \S+: with a throw at the top of (its|the checkout's) src\/value\.ts/)
      expect(run.stdout).not.toContain('mutants checked against the suite')
    }
    expect(fs.readdirSync(path.dirname(project)).filter((name) => name.startsWith('.tmp-truth-'))).toEqual([])
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

it("puts the project's node_modules/.bin first on PATH only for a target that asks for it", () => {
  const base = { PATH: ['/usr/bin', '/bin'].join(path.delimiter) }
  const bin = path.join('/p', 'node_modules', '.bin')
  expect(targetEnv({ binOnPath: true }, { dir: '/p', base })).toEqual({ PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter) })
  expect(targetEnv({ binOnPath: true }, { dir: '/p', base: {} })).toEqual({ PATH: bin })
  expect(base).toEqual({ PATH: ['/usr/bin', '/bin'].join(path.delimiter) })
  for (const [name, target] of Object.entries(targets)) {
    if (!target.binOnPath) expect(targetEnv(target, { dir: '/p', base }).PATH, name).toBe(base.PATH)
  }
})
