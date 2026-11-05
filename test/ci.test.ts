import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandsFor, expectedChecks, profileFor, validateAddon, validateJobs, validateResults, targets } from '../bench/ci.ts'

import { partitionKeys } from '../bench/truth-shards.ts'

const identity = { sha: 'a'.repeat(40), run: '1234' }
const proofFor = (suite: string) => {
  if (!suite.startsWith('truth-')) return undefined
  const total = suite.startsWith('truth-basic-') ? 4 : 1
  const index = suite.split('-').at(-1)
  const { selected, ...partition } = partitionKeys(['a', 'b', 'c', 'd', 'e'], `${index}/${total}`)
  return { ...partition, checked: selected }
}
const valid = (profile: 'docs' | 'standard' | 'full') => expectedChecks(profile).map((check) => ({
  ...check, ...identity, status: 'success', truth: proofFor(check.suite),
}))

describe('CI profiles', () => {
  it.each([
    ['README.md', 'docs/design.md'],
    ['CONTRIBUTING.md', 'LICENSE'],
  ])('only skips code validation for proven user documentation %j', (...paths) => {
    expect(profileFor({ event: 'pull_request', paths }).profile).toBe('docs')
  })

  it.each([
    ['native/src/lib.rs'], ['src/runtime/runner.ts'], ['src/run.ts'], ['src/mutate/operators.ts'],
    ['fixtures/basic/src/math.ts'], ['.github/workflows/native.yml'], ['pnpm-lock.yaml'],
    ['docs/AGENTS.md'], ['docs/skills/SKILL.md'], ['src/mutate/CLAUDE.md'], ['unexpected-file'],
    [], undefined, null, ['../README.md'], ['docs/../src/run.ts'], ['docs/a.md\nREADME.md'],
  ].map((paths) => [paths]))('keeps the same bounded PR checks for code or unavailable changes %j', (paths) => {
    for (const event of ['pull_request', 'push']) expect(profileFor({ event, paths }).profile).toBe('standard')
  })

  it('reserves full validation for scheduled and manual runs', () => {
    expect(profileFor({ event: 'workflow_dispatch', manual: 'standard' }).profile).toBe('standard')
    expect(profileFor({ event: 'workflow_dispatch' }).profile).toBe('full')
    expect(profileFor({ event: 'schedule', paths: ['README.md'], manual: 'standard' }).profile).toBe('full')
    expect(profileFor({ event: 'unknown', paths: ['README.md'] }).profile).toBe('full')
  })

  it('keeps seven smoke environments and complete Linux truth in every code PR', () => {
    expect(targets).toHaveLength(7)
    const checks = expectedChecks('standard')
    expect(checks.filter((c) => c.suite === 'smoke').map((c) => c.target)).toEqual(targets.map((t) => t.target))
    for (const target of ['darwin-arm64', 'linux-x64-gnu']) {
      expect(checks.filter((c) => c.target === target && !['quick', 'smoke'].includes(c.suite) && !c.suite.startsWith('truth-'))
        .map((c) => c.suite)).toEqual(['e2e-basic', 'e2e-other', 'packed'])
    }
    expect(checks.filter((c) => c.suite.startsWith('truth-')).map((c) => [c.target, c.suite])).toEqual([
      ...['basic-default', 'basic-static'].flatMap((name) => [1, 2, 3, 4].map((shard) => ['linux-x64-gnu', `truth-${name}-${shard}`])),
      ...['stuck', 'clash', 'walk'].map((name) => ['linux-x64-gnu', `truth-${name}-1`]),
    ])
    for (const suite of ['regression', 'truth']) {
      expect(expectedChecks('full').filter((c) => c.suite === suite).map((c) => c.target)).toEqual(targets.map((t) => t.target))
    }
    expect(expectedChecks('docs')).toEqual([])
  })

  it('retains all e2e files, packed, units and typechecking across the PR lanes', () => {
    expect(commandsFor('linux-x64-gnu', 'quick').map((c) => c.name)).toEqual(['typecheck', 'unit'])
    for (const target of ['linux-x64-gnu', 'darwin-arm64']) {
      const commands = ['e2e-basic', 'e2e-other', 'packed'].flatMap((suite) => commandsFor(target, suite))
      expect(commandsFor(target, 'e2e-basic')[0].args.slice(0, 2)).toEqual(['test:e2e', 'test/e2e/basic.test.ts'])
      const files = commands.flatMap((command) => command.args.filter((arg) => arg.startsWith('test/e2e/')))
      const inventory = fs.readdirSync(path.join(import.meta.dirname, 'e2e')).filter((file) => file.endsWith('.test.ts') && file !== 'smoke.test.ts').map((file) => `test/e2e/${file}`)
      expect(files.sort()).toEqual(inventory.sort())
      expect(commands.filter((c) => c.name === 'packed')).toHaveLength(1)
      expect(commands.some((c) => c.name === 'unit')).toBe(target !== 'linux-x64-gnu')
    }
    for (const target of targets) {
      expect(commandsFor(target.target, 'regression').map((c) => c.name)).toEqual(target.target === 'linux-x64-gnu' ? ['e2e', 'packed']
        : target.musl ? ['unit', 'e2e', 'packed'] : ['typecheck', 'unit', 'e2e', 'packed'])
      expect(commandsFor(target.target, 'truth').map((c) => c.name)).toEqual(['truth'])
      expect(commandsFor(target.target, 'smoke').map((c) => c.name)).toEqual(['smoke'])
    }
    expect(() => commandsFor('unknown', 'regression')).toThrow()
    expect(() => commandsFor('win32-x64', 'quick')).toThrow()
  })
})

describe('required CI results', () => {
  it('requires successful prerequisite jobs even if their result files claim success', () => {
    const jobs = { plan: { result: 'success' }, quick: { result: 'success' }, build: { result: 'success' }, detail: { result: 'success' } }
    expect(validateJobs('standard', jobs)).toEqual([])
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      expect(validateJobs('standard', { ...jobs, build: { result } })).not.toEqual([])
    }
    expect(validateJobs('standard', {})).not.toEqual([])
    expect(validateJobs('docs', { plan: { result: 'success' }, quick: { result: 'skipped' }, build: { result: 'skipped' }, detail: { result: 'skipped' } })).toEqual([])
    expect(validateJobs('docs', { ...jobs, plan: { result: 'failure' } })).not.toEqual([])
  })

  it.each(['docs', 'standard', 'full'] as const)('accepts exactly the successful %s checks for this source and run', (profile) => {
    expect(validateResults(profile, identity, valid(profile))).toEqual([])
  })

  it.each(['failure', 'cancelled', 'skipped', 'neutral', undefined])('rejects a required check with status %s', (status) => {
    const results = valid('standard')
    expect(validateResults('standard', identity, [{ ...results[0], status }, ...results.slice(1)])).not.toEqual([])
  })

  it('rejects missing, duplicate, unexpected and malformed results', () => {
    const results = valid('standard')
    for (const observed of [results.slice(1), [...results, results[0]], [...results, { ...results[0], target: 'other' }], [...results, null]]) {
      expect(validateResults('standard', identity, observed)).not.toEqual([])
    }
    expect(validateResults('docs', identity, results)).not.toEqual([])
  })

  it('rejects successful lanes whose truth partitions omit or repeat mutants', () => {
    const results = valid('standard')
    const at = results.findIndex((row) => row.suite === 'truth-basic-default-1')
    for (const truth of [undefined, { ...results[at].truth, checked: [] },
      { ...results[at].truth, checked: ['a', 'a'] }, { ...results[at].truth, universe: ['different'] }]) {
      const changed = results.map((row, index) => index === at ? { ...row, truth } : row)
      expect(validateResults('standard', identity, changed)).not.toEqual([])
    }
  })

  it('binds proof indices to their lanes and rejects vacuous fixed-fixture checks', () => {
    const results = valid('standard')
    const first = results.find((row) => row.suite === 'truth-basic-default-1')!
    const second = results.find((row) => row.suite === 'truth-basic-default-2')!
    const swapped = results.map((row) => row === first ? { ...row, truth: second.truth } : row === second ? { ...row, truth: first.truth } : row)
    expect(validateResults('standard', identity, swapped)).not.toEqual([])
    const empty = results.map((row) => row.truth ? { ...row, truth: { ...row.truth, universe: [], checked: [] } } : row)
    expect(validateResults('standard', identity, empty)).not.toEqual([])
  })

  it('rejects evidence from another commit, run or suite', () => {
    const results = valid('standard')
    for (const patch of [{ sha: 'b'.repeat(40) }, { run: '1233' }, { suite: 'not-run' }]) {
      expect(validateResults('standard', identity, [{ ...results[0], ...patch }, ...results.slice(1)])).not.toEqual([])
    }
  })
})

describe('native artifact identity', () => {
  const bytes = Buffer.from('an addon')
  const expected = { ...identity, target: 'darwin-arm64' }
  const manifest = { ...expected, digest: createHash('sha256').update(bytes).digest('hex') }

  it('accepts only matching source, workflow run, platform and binary content', () => {
    expect(validateAddon(manifest, expected, bytes)).toEqual([])
    for (const changed of [null, {}, { ...manifest, sha: 'b'.repeat(40) }, { ...manifest, run: 'another' }, { ...manifest, target: 'linux-x64-gnu' }]) {
      expect(validateAddon(changed, expected, bytes)).not.toEqual([])
    }
    expect(validateAddon(manifest, expected, Buffer.from('different binary'))).not.toEqual([])
  })
})

describe('CI command boundaries', () => {
  let work: string
  let source: string
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(work, 'empty-hooks')}`, ...args], { cwd: work, encoding: 'utf8' }).trim()

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-ci-'))
    fs.mkdirSync(path.join(work, 'bench'))
    fs.mkdirSync(path.join(work, 'empty-hooks'))
    for (const name of ['ci.ts', 'truth-shards.ts']) fs.copyFileSync(path.join(import.meta.dirname, '../bench', name), path.join(work, 'bench', name))
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ type: 'module', scripts: {
      typecheck: 'node -e "process.exit(0)"', 'test:unit': 'node -e "process.exit(7)" --',
    } }))
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'fixture')
    source = git('rev-parse', 'HEAD')
  })
  afterEach(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))

  const command = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['bench/ci.ts', ...args], {
    cwd: work, encoding: 'utf8', env: { ...process.env, CI_SHA: source, GITHUB_RUN_ID: '1234', ...env },
  })

  it('reads the actual committed diff and keeps unavailable changes on the complete PR profile', () => {
    const before = source
    fs.writeFileSync(path.join(work, 'README.md'), 'documentation')
    git('add', 'README.md')
    git('commit', '-qm', 'docs')
    source = git('rev-parse', 'HEAD')
    const event = path.join(work, 'event.json')
    const output = path.join(work, 'output')
    fs.writeFileSync(event, JSON.stringify({ before, after: source }))
    expect(command(['plan'], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }).status).toBe(0)
    expect(fs.readFileSync(output, 'utf8')).toContain('profile=docs\n')
    expect(fs.readFileSync(output, 'utf8')).toContain(`base=${before}\n`)
    expect(fs.readFileSync(output, 'utf8')).toContain(`head=${source}\n`)
    expect(fs.readFileSync(output, 'utf8')).toContain('comparison=two-dot\n')
    fs.writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: before }, head: { sha: source } } }))
    fs.writeFileSync(output, '')
    expect(command(['plan'], { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }).status).toBe(0)
    expect(fs.readFileSync(output, 'utf8')).toContain(`base=${before}\nhead=${source}\ncomparison=three-dot\n`)
    fs.writeFileSync(event, JSON.stringify({ before: '0'.repeat(40), after: source }))
    fs.writeFileSync(output, '')
    expect(command(['plan'], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }).status).toBe(0)
    expect(fs.readFileSync(output, 'utf8')).toContain('profile=standard\n')
    expect(fs.readFileSync(output, 'utf8')).toContain(`head=${source}\n`)
    expect(fs.readFileSync(output, 'utf8')).toContain('diff=invalid-refs\n')
    fs.writeFileSync(event, JSON.stringify({ before: 'b'.repeat(40), after: source }))
    fs.writeFileSync(output, '')
    expect(command(['plan'], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }).status).toBe(0)
    expect(fs.readFileSync(output, 'utf8')).toContain(`base=${'b'.repeat(40)}\nhead=${source}\n`)
    expect(fs.readFileSync(output, 'utf8')).toContain('diff=unresolved-refs\n')
  })

  it('fails a real lane when its command fails and retains its output and partial record', () => {
    const result = command(['run', 'quick', 'linux-x64-gnu'])
    expect(result.status, result.stdout + result.stderr).toBe(1)
    const record = JSON.parse(fs.readFileSync(path.join(work, 'build/ci/result-linux-x64-gnu-quick.json'), 'utf8'))
    expect(record).toMatchObject({ sha: source, run: '1234', status: 'failure' })
    expect(record.steps.map((step: { name: string; exit: number }) => [step.name, step.exit])).toEqual([['typecheck', 0], ['unit', 7]])
    expect(fs.existsSync(path.join(work, 'build/test-reports/quick-unit.log'))).toBe(true)
  })

  it('only lets the real gate pass with all result files from this checkout and successful jobs', () => {
    const directory = path.join(work, 'build/ci-results/checks')
    fs.mkdirSync(directory, { recursive: true })
    const records = valid('standard').map((record) => ({ ...record, sha: source }))
    for (const record of records) fs.writeFileSync(path.join(directory, `result-${record.target}-${record.suite}.json`), JSON.stringify(record))
    const env = { CI_PROFILE: 'standard', CI_NEEDS: JSON.stringify({
      plan: { result: 'success' }, quick: { result: 'success' }, build: { result: 'success' }, detail: { result: 'success' },
    }) }
    const passing = command(['gate'], env)
    expect(passing.status, passing.stderr).toBe(0)
    expect(passing.stdout).toContain('| darwin-arm64 | truth | not selected (standard) |')
    fs.rmSync(path.join(directory, 'result-linux-x64-gnu-quick.json'))
    const missing = command(['gate'], env)
    expect(missing.status).toBe(1)
    expect(missing.stdout).toContain('Missing result: linux-x64-gnu/quick')
    expect(command(['gate'], { ...env, CI_SHA: 'b'.repeat(40) }).stderr).toContain('Checkout differs from CI_SHA')
  })

  it('stages available truth sessions after failure without following links or deleting the originals', () => {
    const session = path.join(work, 'fixtures/basic/node_modules/.vitant/session')
    fs.mkdirSync(path.join(session, 'results'), { recursive: true })
    fs.writeFileSync(path.join(session, 'config.json'), '{}')
    fs.writeFileSync(path.join(session, 'results/worker.jsonl'), '{"type":"whole"}\n')
    const outside = path.join(work, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'unrelated'), 'not a session record')
    fs.symlinkSync(outside, path.join(session, 'link'), 'junction')
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8'))
    pkg.scripts['test:truth'] = 'node -e "process.exit(9)"'
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify(pkg))
    git('add', 'package.json')
    git('commit', '-qm', 'truth failure')
    source = git('rev-parse', 'HEAD')
    expect(command(['run', 'truth', 'win32-x64']).status).toBe(1)
    expect(command(['sessions']).status).toBe(0)
    const kept = path.join(work, 'build/test-reports/truth-sessions/basic')
    expect(fs.readFileSync(path.join(kept, 'results/worker.jsonl'), 'utf8')).toContain('whole')
    expect(fs.existsSync(path.join(kept, 'config.json'))).toBe(true)
    expect(fs.existsSync(path.join(kept, 'link'))).toBe(false)
    expect(fs.existsSync(path.join(session, 'results/worker.jsonl'))).toBe(true)
  })

  it.each([
    ['fixtures', 'basic/node_modules/.vitant/session'],
    ['fixtures/basic/node_modules', '.vitant/session'],
    ['fixtures/basic/node_modules/.vitant', 'session'],
  ])('does not collect sessions through a linked %s ancestor', (at, suffix) => {
    const outside = path.join(work, 'outside')
    const session = path.join(outside, suffix)
    fs.mkdirSync(session, { recursive: true })
    fs.writeFileSync(path.join(session, 'config.json'), 'external session')
    const link = path.join(work, at)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(outside, link, 'junction')
    const result = command(['sessions'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Kept 0 available truth session(s)')
    expect(fs.existsSync(path.join(work, 'build/test-reports/truth-sessions/basic'))).toBe(false)
  })
})
