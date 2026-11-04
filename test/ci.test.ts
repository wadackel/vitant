import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandsFor, expectedChecks, profileFor, validateAddon, validateJobs, validateResults, targets } from '../bench/ci.ts'

const identity = { sha: 'a'.repeat(40), run: '1234' }
const valid = (profile: 'docs' | 'standard' | 'full') => expectedChecks(profile).map((check) => ({
  ...check, ...identity, status: 'success',
}))

describe('CI profiles', () => {
  it.each([
    ['docs', ['README.md', 'docs/design.md']],
    ['standard', ['src/mutate/operators.ts', 'test/reads.test.ts', 'docs/limits.md']],
    ['full', ['native/src/lib.rs']],
    ['full', ['src/runtime/runner.ts']],
    ['full', ['src/run.ts']],
    ['full', ['test/turns.test.ts']],
    ['full', ['fixtures/basic/src/math.ts']],
    ['full', ['test/e2e/smoke.test.ts']],
    ['full', ['bench/ci.ts']],
    ['full', ['.github/workflows/native.yml']],
    ['full', ['AGENTS.md']],
    ['full', ['docs/AGENTS.md']],
    ['full', ['docs/skills/SKILL.md']],
    ['full', ['src/mutate/CLAUDE.md']],
    ['full', ['pnpm-lock.yaml']],
    ['full', ['README.md', 'unexpected-file']],
    ['full', ['src/runtime/removed.ts', 'src/mutate/moved.ts']],
    ['full', []],
  ] as const)('selects %s for %j', (profile, paths) => {
    expect(profileFor({ event: 'pull_request', paths: [...paths] }).profile).toBe(profile)
  })

  it.each([undefined, null, 'README.md', [null], ['../README.md'], ['docs/../src/run.ts'], ['docs/a.md\nREADME.md']].map((paths) => [paths]))(
    'keeps full validation for invalid or unavailable changes %j', (paths) => {
      expect(profileFor({ event: 'push', paths }).profile).toBe('full')
    },
  )

  it('only permits a manual standard override on dispatches', () => {
    expect(profileFor({ event: 'workflow_dispatch', manual: 'standard' }).profile).toBe('standard')
    expect(profileFor({ event: 'workflow_dispatch' }).profile).toBe('full')
    expect(profileFor({ event: 'schedule', paths: ['README.md'], manual: 'standard' }).profile).toBe('full')
    expect(profileFor({ event: 'pull_request', paths: ['native/src/lib.rs'], manual: 'standard' }).profile).toBe('full')
    expect(profileFor({ event: 'unknown', paths: ['README.md'] }).profile).toBe('full')
  })

  it('keeps all targets in smoke and all tests in the full profile', () => {
    expect(targets).toHaveLength(7)
    expect(expectedChecks('standard').filter((c) => c.suite === 'smoke').map((c) => c.target)).toEqual(targets.map((t) => t.target))
    expect(expectedChecks('standard').filter((c) => c.suite === 'regression').map((c) => c.target)).toEqual(['darwin-arm64', 'linux-x64-gnu'])
    for (const suite of ['regression', 'truth']) {
      expect(expectedChecks('full').filter((c) => c.suite === suite).map((c) => c.target)).toEqual(targets.map((t) => t.target))
    }
    expect(expectedChecks('docs')).toEqual([])
  })

  it('runs the original units on every detailed platform and preserves typechecking', () => {
    expect(commandsFor('linux-x64-gnu', 'quick').map((c) => c.name)).toEqual(['typecheck', 'unit'])
    for (const target of targets) {
      const commands = commandsFor(target.target, 'regression').map((c) => c.name)
      expect(commands).toEqual(target.target === 'linux-x64-gnu' ? ['e2e', 'packed']
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
    fs.copyFileSync(path.join(import.meta.dirname, '../bench/ci.ts'), path.join(work, 'bench/ci.ts'))
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

  it('reads the actual committed diff and keeps failed diff resolution on full', () => {
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
    expect(fs.readFileSync(output, 'utf8')).toContain('profile=full\n')
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
    const records = expectedChecks('standard').map((check) => ({ ...check, sha: source, run: '1234', status: 'success' }))
    for (const record of records) fs.writeFileSync(path.join(directory, `result-${record.target}-${record.suite}.json`), JSON.stringify(record))
    const env = { CI_PROFILE: 'standard', CI_NEEDS: JSON.stringify({
      plan: { result: 'success' }, quick: { result: 'success' }, build: { result: 'success' }, detail: { result: 'success' },
    }) }
    expect(command(['gate'], env).status).toBe(0)
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
