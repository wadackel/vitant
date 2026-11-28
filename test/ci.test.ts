import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildsFor, commandsFor, expectedChecks, latestArtifacts, profileFor, suitesOf, validateAddon, validateJobs, validateResults, targets } from '../bench/ci.ts'

import { partitionKeys } from '../bench/truth-shards.ts'

const identity = { sha: 'a'.repeat(40), run: '1234' }
const proofFor = (suite: string) => {
  if (!suite.startsWith('truth-')) return undefined
  const total = suite.startsWith('truth-basic-') ? 8 : 1
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
        .map((c) => c.suite)).toEqual(['e2e-1', 'e2e-2', 'e2e-3', 'e2e-4', 'packed'])
    }
    // Five macOS jobs run at once on the account; a sixth would wait for one of them.
    expect(checks.filter((c) => targets.find((t) => t.target === c.target)!.runner.startsWith('macos') && c.suite !== 'smoke')).toHaveLength(5)
    expect(checks.filter((c) => c.suite.startsWith('truth-')).map((c) => [c.target, c.suite])).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) => ['linux-x64-gnu', `truth-basic-${shard}`]),
      ...['stuck', 'clash', 'walk', 'nest'].map((name) => ['linux-x64-gnu', `truth-${name}-1`]),
    ])
    const full = expectedChecks('full')
    expect(full.filter((c) => c.suite === 'regression').map((c) => c.target)).toEqual(targets.map((t) => t.target))
    expect(full.filter((c) => c.suite === 'truth').map((c) => c.target)).toEqual(targets.map((t) => t.target).filter((t) => t !== 'win32-x64'))
    expect(full.filter((c) => c.suite.startsWith('truth-')).map((c) => [c.target, c.suite])).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) => ['win32-x64', `truth-basic-${shard}`]),
      ...['stuck', 'clash', 'walk', 'nest'].map((name) => ['win32-x64', `truth-${name}-1`]),
    ])
    expect(expectedChecks('docs')).toEqual([])
  })

  it('builds every environment once, those of the detail checks apart', () => {
    for (const profile of ['standard', 'full'] as const) {
      const { needed, others } = buildsFor(profile)
      expect([...needed, ...others].map((t) => t.target).sort()).toEqual(targets.map((t) => t.target).sort())
      const detail = new Set(expectedChecks(profile).filter((c) => !['quick', 'smoke'].includes(c.suite)).map((c) => c.target))
      expect(needed.map((t) => t.target).sort()).toEqual([...detail].sort())
    }
    expect(buildsFor('standard').needed.map((t) => t.target)).toEqual(['darwin-arm64', 'linux-x64-gnu'])
    expect(buildsFor('full').others).toEqual([])
  })

  it('smokes an environment with a packed lane at the start of that lane, and every other in its build', () => {
    for (const profile of ['standard', 'full'] as const) {
      const checks = expectedChecks(profile)
      const { needed, others } = buildsFor(profile)
      for (const build of [...needed, ...others]) {
        const lanes = checks.filter((c) => c.target === build.target && c.suite !== 'smoke').flatMap((c) => suitesOf(c.suite))
        // Exactly one job smokes each environment.
        expect(Number(build.smoke) + lanes.filter((suite) => suite === 'smoke').length, `${profile} ${build.target}`).toBe(1)
      }
    }
    expect(buildsFor('standard').needed.map((t) => [t.target, t.smoke])).toEqual([['darwin-arm64', false], ['linux-x64-gnu', false]])
    expect(buildsFor('standard').others.every((t) => t.smoke)).toBe(true)
    expect(buildsFor('full').needed.every((t) => t.smoke)).toBe(true)
    expect(suitesOf('packed')).toEqual(['smoke', 'packed'])
    expect(suitesOf('e2e-1')).toEqual(['e2e-1'])
  })

  it('retains all e2e files, packed, units and typechecking across the PR lanes', () => {
    expect(commandsFor('linux-x64-gnu', 'quick').map((c) => c.name)).toEqual(['typecheck', 'unit'])
    expect(commandsFor('win32-x64', 'quick').map((c) => c.name)).toEqual(['unit'])
    for (const profile of ['standard', 'full'] as const) {
      expect(expectedChecks(profile).filter((c) => c.suite === 'quick').map((c) => c.target)).toEqual(['linux-x64-gnu', 'win32-x64'])
    }
    for (const target of ['linux-x64-gnu', 'darwin-arm64']) {
      const commands = ['e2e-1', 'e2e-2', 'e2e-3', 'e2e-4', 'packed'].flatMap((suite) => commandsFor(target, suite))
      expect(commandsFor(target, 'e2e-1')[0].args.slice(0, 2)).toEqual(['test:e2e', 'test/e2e/basic.test.ts'])
      expect(commandsFor(target, 'packed').map((c) => c.name)).toEqual([...(target === 'linux-x64-gnu' ? [] : ['typecheck', 'unit']), 'e2e', 'packed'])
      const files = commands.flatMap((command) => command.args.filter((arg) => arg.startsWith('test/e2e/')))
      expect(new Set(files).size).toBe(files.length)
      const inventory = fs.readdirSync(path.join(import.meta.dirname, 'e2e')).filter((file) => file.endsWith('.test.ts') && file !== 'smoke.test.ts').map((file) => `test/e2e/${file}`)
      expect(files.sort()).toEqual(inventory.sort())
      expect(commands.filter((c) => c.name === 'packed')).toHaveLength(1)
      expect(commands.some((c) => c.name === 'unit')).toBe(target !== 'linux-x64-gnu')
    }
    for (const target of targets) {
      expect(commandsFor(target.target, 'regression').map((c) => c.name)).toEqual(target.target === 'linux-x64-gnu' ? ['e2e', 'packed']
        : target.musl ? ['unit', 'e2e', 'packed'] : ['typecheck', 'unit', 'e2e', 'packed'])
      expect(commandsFor(target.target, 'truth').map((c) => c.name)).toEqual(['truth'])
      expect(commandsFor(target.target, 'truth-basic-2')[0].args).toEqual(['exec', 'node', 'bench/truth.ts', 'make', '--root', 'fixtures/basic',
        '--jobs', '4', '--shard', '2/8', '--out', 'build/test-reports/truth-basic-2-truth.json', '--also-tool=--static'])
      expect(commandsFor(target.target, 'truth-nest-1')[0].args).toEqual(['exec', 'node', 'bench/truth.ts', 'make', '--root', 'fixtures/nest',
        '--jobs', '1', '--shard', '1/1', '--out', 'build/test-reports/truth-nest-1-truth.json', '--also-tool=--static'])
      expect(commandsFor(target.target, 'smoke').map((c) => c.name)).toEqual(['smoke'])
    }
    expect(() => commandsFor('unknown', 'regression')).toThrow()
    expect(() => commandsFor('darwin-arm64', 'quick')).toThrow()
  })
})

describe('required CI results', () => {
  it('requires successful prerequisite jobs even if their result files claim success', () => {
    const jobs = { plan: { result: 'success' }, quick: { result: 'success' }, build: { result: 'success' }, 'build-others': { result: 'success' }, detail: { result: 'success' } }
    expect(validateJobs('standard', jobs)).toEqual([])
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      expect(validateJobs('standard', { ...jobs, build: { result } })).not.toEqual([])
      expect(validateJobs('standard', { ...jobs, 'build-others': { result } })).not.toEqual([])
    }
    expect(validateJobs('standard', {})).not.toEqual([])
    // A full run's detail jobs need every environment, so no build is left for build-others.
    expect(validateJobs('full', { ...jobs, 'build-others': { result: 'skipped' } })).toEqual([])
    expect(validateJobs('full', jobs)).not.toEqual([])
    expect(validateJobs('docs', { plan: { result: 'success' }, quick: { result: 'skipped' }, build: { result: 'skipped' }, 'build-others': { result: 'skipped' }, detail: { result: 'skipped' } })).toEqual([])
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

  it.each(['standard', 'full'] as const)('rejects successful %s lanes whose truth partitions omit or repeat mutants', (profile) => {
    const results = valid(profile)
    const at = results.findIndex((row) => row.suite === 'truth-basic-1')
    for (const truth of [undefined, { ...results[at].truth, checked: [] },
      { ...results[at].truth, checked: ['a', 'a'] }, { ...results[at].truth, universe: ['different'] }]) {
      const changed = results.map((row, index) => index === at ? { ...row, truth } : row)
      expect(validateResults(profile, identity, changed)).not.toEqual([])
    }
    expect(validateResults(profile, identity, results.filter((_, index) => index !== at))).not.toEqual([])
  })

  it('binds proof indices to their lanes and rejects vacuous fixed-fixture checks', () => {
    const results = valid('standard')
    const first = results.find((row) => row.suite === 'truth-basic-1')!
    const second = results.find((row) => row.suite === 'truth-basic-2')!
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

describe('artifacts of the latest attempt', () => {
  const rows = [
    ['check-linux-x64-gnu-e2e-1-1', 1], ['check-linux-x64-gnu-e2e-1-30', 2], ['check-linux-x64-gnu-e2e-1-5', 3],
    ['check-darwin-arm64-smoke-2', 4], ['check-darwin-arm64-smoke', 5],
    ['fork.linux-x64-gnu-1', 7], ['fork.linux-x64-gnu-10', 8], ['fork.linux-x64-gnu-9', 9], ['fork.linux-x64-musl-11', 10],
    ['fork.linux-x64-gnux-12', 11],
  ].map(([name, id]) => ({ name: name as string, id: id as number }))

  it('takes the highest attempt of each name, by number and not by ID or order', () => {
    expect(latestArtifacts(rows, 'check-*').sort()).toEqual([2, 4])
    expect(latestArtifacts([...rows].reverse(), 'check-*').sort()).toEqual([2, 4])
    expect(latestArtifacts(rows, 'fork.linux-x64-gnu')).toEqual([8])
    expect(latestArtifacts(rows, 'fork.linux-x64-gnu-1')).toEqual([])
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

// Each test starts node and git several times, which on a darwin-x64 runner took
// longer than Vitest's 5 s for a test.
describe('CI command boundaries', { timeout: 30_000 }, () => {
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
    const quick = JSON.parse(fs.readFileSync(output, 'utf8').match(/^quick=(.*)$/m)![1]).include
    expect(quick.map((entry: { target: string; runner: string }) => [entry.target, entry.runner]))
      .toEqual([['linux-x64-gnu', 'ubuntu-24.04'], ['win32-x64', 'windows-2025']])
    const matrix = (name: string) => JSON.parse(fs.readFileSync(output, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))![1]).include
      .map((entry: { target: string }) => entry.target)
    expect(matrix('platforms')).toEqual(['darwin-arm64', 'linux-x64-gnu'])
    expect(matrix('others')).toEqual(['darwin-x64', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl', 'win32-x64'])
    fs.writeFileSync(output, '')
    expect(command(['plan'], { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output }).status).toBe(0)
    expect(matrix('platforms')).toEqual(targets.map((t) => t.target))
    // native.yml skips build-others on exactly this value, since an empty matrix would fail the job.
    expect(fs.readFileSync(output, 'utf8')).toContain('others={"include":[]}\n')
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

  it('makes a packed lane\'s check after its smoke has failed, and records both', () => {
    fs.mkdirSync(path.join(work, 'test/e2e'), { recursive: true })
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8'))
    Object.assign(pkg.scripts, { 'test:smoke': 'node -e "process.exit(3)" --', 'test:unit': 'node -e "process.exit(0)" --', 'test:packed': 'node -e "process.exit(0)"' })
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify(pkg))
    git('add', 'package.json')
    git('commit', '-qm', 'smoke failure')
    source = git('rev-parse', 'HEAD')
    const result = command(['run', 'packed', 'win32-x64'])
    expect(result.status, result.stdout + result.stderr).toBe(1)
    const record = (suite: string) => JSON.parse(fs.readFileSync(path.join(work, `build/ci/result-win32-x64-${suite}.json`), 'utf8'))
    expect(record('smoke')).toMatchObject({ sha: source, suite: 'smoke', status: 'failure', steps: [{ name: 'smoke', exit: 3 }] })
    expect(record('packed')).toMatchObject({ sha: source, suite: 'packed', status: 'success' })
    expect(record('packed').steps.map((step: { name: string }) => step.name)).toEqual(['typecheck', 'unit', 'packed'])
  })

  it('only lets the real gate pass with all result files from this checkout and successful jobs', () => {
    const directory = path.join(work, 'build/ci-results/checks')
    fs.mkdirSync(directory, { recursive: true })
    const records = valid('standard').map((record) => ({ ...record, sha: source }))
    for (const record of records) fs.writeFileSync(path.join(directory, `result-${record.target}-${record.suite}.json`), JSON.stringify(record))
    const env = { CI_PROFILE: 'standard', CI_NEEDS: JSON.stringify({
      plan: { result: 'success' }, quick: { result: 'success' }, build: { result: 'success' }, 'build-others': { result: 'success' }, detail: { result: 'success' },
    }) }
    const passing = command(['gate'], env)
    expect(passing.status, passing.stderr).toBe(0)
    expect(passing.stdout).toContain('| darwin-arm64 | truth | not selected (standard) |')
    expect(passing.stdout).toContain('| win32-x64 | e2e/packed | not selected (standard) |')
    expect(passing.stdout).toContain('| darwin-x64 | unit/e2e/packed | not selected (standard) |')
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
