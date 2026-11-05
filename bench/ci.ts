import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validatePartitions } from './truth-shards.ts'

export const targets = [
  { target: 'darwin-arm64', runner: 'macos-15', musl: false, addon: true, representative: true, label: 'darwin-arm64' },
  { target: 'darwin-x64', runner: 'macos-15-intel', musl: false, addon: true, representative: false, label: 'darwin-x64' },
  { target: 'linux-x64-gnu', runner: 'ubuntu-24.04', musl: false, addon: true, representative: true, label: 'linux-x64-gnu' },
  { target: 'linux-arm64-gnu', runner: 'ubuntu-24.04-arm', musl: false, addon: true, representative: false, label: 'linux-arm64-gnu' },
  { target: 'linux-x64-musl', runner: 'ubuntu-24.04', musl: true, addon: true, representative: false, label: 'linux-x64-musl' },
  { target: 'linux-arm64-musl', runner: 'ubuntu-24.04-arm', musl: true, addon: true, representative: false, label: 'linux-arm64-musl' },
  { target: 'win32-x64', runner: 'windows-2025', musl: false, addon: false, representative: false, label: 'win32-x64, without the addon' },
]

type Profile = 'docs' | 'standard' | 'full'
type Identity = { sha: string; run: string }
type Check = { target: string; suite: string }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const truthCases = [
  { name: 'basic-default', root: 'basic', shards: 4, jobs: 4, tool: [] as string[] },
  { name: 'basic-static', root: 'basic', shards: 4, jobs: 4, tool: ['--tool=--static'] },
  ...['stuck', 'clash', 'walk'].map((name) => ({ name, root: name, shards: 1, jobs: 1, tool: [] as string[] })),
]
const truthLanes = truthCases.flatMap((test) => Array.from({ length: test.shards }, (_, i) => ({
  ...test, suite: `truth-${test.name}-${i + 1}`, shard: `${i + 1}/${test.shards}`,
})))
const docs = (file: string) => ['README.md', 'CONTRIBUTING.md', 'LICENSE'].includes(file) || /^docs\/.+\.md$/.test(file)

export function profileFor(input: { event: string; paths?: unknown; manual?: unknown }): { profile: Profile; reason: string } {
  if (input.event === 'workflow_dispatch') return input.manual === 'standard'
    ? { profile: 'standard', reason: 'Explicit manual representative validation' }
    : { profile: 'full', reason: 'Manual full validation' }
  if (!['pull_request', 'push'].includes(input.event)) return { profile: 'full', reason: 'Scheduled or unrecognized event' }
  if (!Array.isArray(input.paths) || input.paths.length === 0) return { profile: 'standard', reason: 'Complete PR validation; changes are empty or unavailable' }
  const files: unknown[] = input.paths
  if (!files.every((file): file is string => typeof file === 'string' && file.length > 0 && !/[\x00-\x1f\x7f\\]/.test(file)
    && !path.posix.isAbsolute(file) && path.posix.normalize(file) === file && !file.startsWith('../'))) {
    return { profile: 'standard', reason: 'Complete PR validation; changes contain invalid paths' }
  }
  if (files.some((file) => /^(agents|claude|skill)\.md$/i.test(path.posix.basename(file)))) {
    return { profile: 'standard', reason: 'Complete PR validation; agent instructions changed' }
  }
  if (files.every(docs)) return { profile: 'docs', reason: 'Only user documentation changed' }
  return { profile: 'standard', reason: 'Complete PR validation for every code change' }
}

export function expectedChecks(profile: Profile): Check[] {
  if (profile === 'docs') return []
  return [
    { target: 'linux-x64-gnu', suite: 'quick' },
    ...targets.map(({ target }) => ({ target, suite: 'smoke' })),
    ...(profile === 'full'
      ? targets.flatMap(({ target }) => ['regression', 'truth'].map((suite) => ({ target, suite })))
      : [
        ...targets.filter((target) => target.representative).flatMap(({ target }) => ['e2e-basic', 'e2e-other', 'packed'].map((suite) => ({ target, suite }))),
        ...truthLanes.map(({ suite }) => ({ target: 'linux-x64-gnu', suite })),
      ]),
  ]
}

function targetFor(name: string) {
  const target = targets.find((target) => target.target === name)
  if (!target) throw new Error(`Unknown target: ${name}`)
  return target
}

export function commandsFor(name: string, suite: string): { name: string; args: string[] }[] {
  const target = targetFor(name)
  const unit = { name: 'unit', args: ['test:unit', '--reporter=json', '--outputFile=build/test-reports/unit.json'] }
  const typecheck = { name: 'typecheck', args: ['typecheck'] }
  if (suite === 'quick' && name === 'linux-x64-gnu') return [typecheck, unit]
  if (suite === 'smoke') return [{ name: 'smoke', args: ['test:smoke', '--reporter=json', '--outputFile=build/test-reports/smoke.json'] }]
  if (suite === 'truth') return [{ name: 'truth', args: ['test:truth'] }]
  if (suite === 'e2e-basic' || suite === 'e2e-other') {
    const files = suite === 'e2e-basic' ? ['basic.test.ts'] : fs.readdirSync(path.join(root, 'test/e2e'))
      .filter((file) => file.endsWith('.test.ts') && !['basic.test.ts', 'smoke.test.ts'].includes(file)).sort()
    if (files.length === 0) throw new Error('No e2e files assigned to this lane')
    return [{ name: 'e2e', args: ['test:e2e', ...files.map((file) => `test/e2e/${file}`),
      '--reporter=json', '--outputFile=build/test-reports/e2e.json'] }]
  }
  if (suite === 'packed') return [
    ...(name === 'linux-x64-gnu' ? [] : [typecheck, unit]),
    { name: 'packed', args: ['test:packed'] },
  ]
  const truth = truthLanes.find((lane) => lane.suite === suite)
  if (truth && name === 'linux-x64-gnu') return [{ name: 'truth', args: ['exec', 'node', 'bench/truth.ts', 'make',
    '--root', `fixtures/${truth.root}`, '--jobs', String(truth.jobs), '--shard', truth.shard,
    '--out', `build/test-reports/${suite}-truth.json`, ...truth.tool] }]
  if (suite === 'regression') return [
    ...(name === 'linux-x64-gnu' ? [] : [...(target.musl ? [] : [typecheck]), unit]),
    { name: 'e2e', args: ['test:e2e', '--reporter=json', '--outputFile=build/test-reports/e2e.json'] },
    { name: 'packed', args: ['test:packed'] },
  ]
  throw new Error(`Unknown suite ${suite} for ${name}`)
}

export function validateResults(profile: Profile, identity: Identity, results: unknown[]): string[] {
  const expected = new Set(expectedChecks(profile).map(({ target, suite }) => `${target}/${suite}`))
  const seen = new Set<string>()
  const errors: string[] = []
  for (const result of results) {
    if (!object(result) || typeof result.target !== 'string' || typeof result.suite !== 'string') {
      errors.push('Malformed check result')
      continue
    }
    const key = `${result.target}/${result.suite}`
    if (!expected.has(key)) errors.push(`Unexpected result: ${key}`)
    if (seen.has(key)) errors.push(`Duplicate result: ${key}`)
    seen.add(key)
    if (result.status !== 'success') errors.push(`Unsuccessful result: ${key}`)
    if (result.sha !== identity.sha || result.run !== identity.run) errors.push(`Wrong source or workflow run: ${key}`)
  }
  for (const key of expected) if (!seen.has(key)) errors.push(`Missing result: ${key}`)
  if (profile === 'standard') for (const test of truthCases) {
    const partitions = truthLanes.filter((lane) => lane.name === test.name).map((lane) => {
      const result = results.find((row) => object(row) && row.target === 'linux-x64-gnu' && row.suite === lane.suite)
      const proof = object(result) ? result.truth : undefined
      if (object(proof)) {
        if (proof.index !== Number(lane.shard.split('/')[0]) || proof.total !== lane.shards) errors.push(`Wrong truth partition for ${lane.suite}`)
        if (Array.isArray(proof.universe) && proof.universe.length === 0) errors.push(`Empty truth mutant set for ${lane.suite}`)
      }
      return proof
    })
    errors.push(...validatePartitions(partitions, test.shards).map((error) => `${test.name}: ${error}`))
  }
  return errors
}

export function validateJobs(profile: Profile, needs: unknown): string[] {
  if (!object(needs)) return ['Missing prerequisite jobs']
  return ['plan', 'quick', 'build', 'detail'].flatMap((job) => {
    const expected = job === 'plan' || profile !== 'docs' ? 'success' : 'skipped'
    return object(needs[job]) && needs[job].result === expected ? [] : [`Prerequisite ${job} did not ${expected === 'success' ? 'succeed' : 'skip as planned'}`]
  })
}

export function validateAddon(manifest: unknown, expected: Identity & { target: string }, bytes: Uint8Array): string[] {
  if (!object(manifest)) return ['Missing addon identity']
  const errors = ['sha', 'run', 'target'].filter((key) => manifest[key] !== expected[key as keyof typeof expected]).map((key) => `Wrong addon ${key}`)
  if (manifest.digest !== createHash('sha256').update(bytes).digest('hex')) errors.push('Wrong addon digest')
  return errors
}

const root = path.resolve(import.meta.dirname, '..')
const ciDir = path.join(root, 'build/ci')
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const validSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) && !/^0+$/.test(value)

function identity(): Identity {
  const sha = process.env.CI_SHA
  const run = process.env.GITHUB_RUN_ID
  if (!validSha(sha) || !run || !/^\d+$/.test(run)) throw new Error('CI_SHA and GITHUB_RUN_ID must identify this workflow run')
  if (git('rev-parse', 'HEAD').trim() !== sha) throw new Error('Checkout differs from CI_SHA')
  return { sha, run }
}

function changes(event: string) {
  const found: { paths?: string[]; base: string; head: string; comparison: string; diff: string } = {
    base: '', head: '', comparison: event === 'pull_request' ? 'three-dot' : event === 'push' ? 'two-dot' : 'none', diff: 'not-requested',
  }
  if (found.comparison === 'none') return found
  found.diff = 'unavailable-event'
  try {
    const payload = readJson(process.env.GITHUB_EVENT_PATH!)
    if (!object(payload)) return found
    const pr = payload.pull_request
    const base = event === 'pull_request' && object(pr) && object(pr.base) ? pr.base.sha : payload.before
    const head = event === 'pull_request' && object(pr) && object(pr.head) ? pr.head.sha : payload.after
    found.base = validSha(base) ? base : ''
    found.head = validSha(head) ? head : ''
    if (!validSha(base) || !validSha(head)) return { ...found, diff: 'invalid-refs' }
    found.paths = git('diff', '--no-renames', '--name-only', '-z', event === 'pull_request' ? `${base}...${head}` : base,
      ...(event === 'pull_request' ? [] : [head]), '--').split('\0').filter(Boolean)
    found.diff = 'resolved'
  } catch {
    found.diff = found.base && found.head ? 'unresolved-refs' : 'unavailable-event'
  }
  return found
}

function plan() {
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  const changed = changes(event)
  const selection = profileFor({ event, paths: changed.paths, manual: process.env.CI_PROFILE })
  const sha = git('rev-parse', 'HEAD').trim()
  const detail = expectedChecks(selection.profile).filter((check) => !['quick', 'smoke'].includes(check.suite))
    .map((check) => ({ ...targetFor(check.target), suite: check.suite }))
  // Queuing Windows truth after the shorter jobs would add their time to its long critical path.
  detail.sort((a, b) => Number(b.target === 'win32-x64' && b.suite === 'truth') - Number(a.target === 'win32-x64' && a.suite === 'truth')
    || Number(b.suite === 'truth') - Number(a.suite === 'truth'))
  const output = { ...selection, sha, base: changed.base, head: changed.head, comparison: changed.comparison, diff: changed.diff,
    platforms: JSON.stringify({ include: targets }), detail: JSON.stringify({ include: detail }) }
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''))
  console.log(`${selection.profile}: ${selection.reason}\nSource: ${sha}\nComparison: ${changed.comparison} ${changed.base || 'unavailable'} -> ${changed.head || 'unavailable'} (${changed.diff})`)
}

function collectSessions() {
  const fixtures = path.join(root, 'fixtures')
  const directory = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false })?.isDirectory() === true
  let kept = 0
  if (directory(fixtures)) for (const entry of fs.readdirSync(fixtures, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const modules = path.join(fixtures, entry.name, 'node_modules')
    const state = path.join(modules, '.vitant')
    const session = path.join(state, 'session')
    if (![modules, state, session].every(directory)) continue
    // Uploading .vitant directly would omit hidden folders by default.
    fs.cpSync(session, path.join(root, 'build/test-reports/truth-sessions', entry.name), {
      recursive: true,
      filter: (source) => !fs.lstatSync(source).isSymbolicLink(),
    })
    kept++
  }
  console.log(`Kept ${kept} available truth session(s)`)
}

function addon(target: string, stamp: boolean) {
  if (!targetFor(target).addon) throw new Error(`No addon is built for ${target}`)
  const expected = { ...identity(), target }
  const binary = path.join(root, 'build', `fork.${target}.node`)
  const manifest = path.join(root, 'build', `addon.${target}.json`)
  const bytes = fs.readFileSync(binary)
  if (stamp) fs.writeFileSync(manifest, JSON.stringify({ ...expected, digest: createHash('sha256').update(bytes).digest('hex') }) + '\n')
  else {
    const errors = validateAddon(readJson(manifest), expected, bytes)
    if (errors.length) throw new Error(errors.join('\n'))
  }
}

async function run(suite: string, target: string) {
  const commands = commandsFor(target, suite)
  const source = identity()
  if (suite !== 'quick' && targetFor(target).addon) addon(target, false)
  fs.mkdirSync(ciDir, { recursive: true })
  const logs = path.join(root, 'build/test-reports')
  fs.mkdirSync(logs, { recursive: true })
  const result = { ...source, target, suite, status: 'failure', truth: undefined as unknown, steps: [] as { name: string; seconds: number; exit: number }[] }
  const save = () => fs.writeFileSync(path.join(ciDir, `result-${target}-${suite}.json`), JSON.stringify(result, null, 2) + '\n')
  save()
  for (const command of commands) {
    const start = performance.now()
    const file = path.join(logs, `${suite}-${command.name}.log`)
    const descriptor = fs.openSync(file, 'w')
    console.log(`Running ${target}/${suite}: pnpm ${command.args.join(' ')}`)
    let code: number
    try {
      code = await new Promise<number>((resolve, reject) => {
        const child = spawn('pnpm', command.args, { cwd: root, stdio: ['ignore', descriptor, descriptor], shell: process.platform === 'win32' })
        child.once('error', reject)
        child.once('close', (code) => resolve(code ?? 1))
      })
    } finally {
      fs.closeSync(descriptor)
    }
    result.steps.push({ name: command.name, seconds: (performance.now() - start) / 1000, exit: code })
    save()
    console.log(fs.readFileSync(file, 'utf8').split('\n').slice(-35).join('\n'))
    if (code !== 0) throw new Error(`${target}/${suite}: ${command.name} exited ${code}`)
  }
  if (truthLanes.some((lane) => lane.suite === suite)) {
    const truth = readJson(path.join(logs, `${suite}-truth.json`))
    if (!object(truth) || truth.command !== 'run' || !object(truth.partition)) throw new Error('Missing full-suite truth partition')
    result.truth = truth.partition
  }
  result.status = 'success'
  save()
}

function gate() {
  const source = identity()
  const profile = process.env.CI_PROFILE
  if (profile !== 'docs' && profile !== 'standard' && profile !== 'full') throw new Error('Missing or invalid profile')
  const results: unknown[] = []
  const directory = path.join(root, 'build/ci-results')
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /^result-.+\.json$/.test(entry.name)) results.push(readJson(path.join(entry.parentPath, entry.name)))
    }
  }
  const errors = [...validateJobs(profile, JSON.parse(process.env.CI_NEEDS ?? 'null')), ...validateResults(profile, source, results)]
  const rows = ['## Validation', '', `Profile: ${profile}. Source: ${source.sha}. Workflow run: ${source.run}.`, process.env.CI_REASON ?? '',
    `Comparison: ${process.env.CI_COMPARISON || 'none'} ${process.env.CI_BASE || 'unavailable'} -> ${process.env.CI_HEAD || 'unavailable'} (${process.env.CI_DIFF || 'not-requested'}).`, '',
    '| Target | Suite | Result | Command seconds |', '|---|---|---|---|']
  for (const { target, suite } of expectedChecks(profile)) {
    const result = results.find((row) => object(row) && row.target === target && row.suite === suite)
    const steps = object(result) && Array.isArray(result.steps) ? result.steps : []
    const times = steps.filter(object).map((step) => `${String(step.name)}: ${typeof step.seconds === 'number' ? step.seconds.toFixed(1) : '?'}`).join(', ')
    rows.push(`| ${target} | ${suite} | ${object(result) ? String(result.status) : 'missing'} | ${times} |`)
  }
  for (const target of targets) {
    if (!expectedChecks(profile).some((check) => check.target === target.target && ['regression', 'e2e-basic'].includes(check.suite))) {
      rows.push(`| ${target.target} | unit/e2e/packed | not selected (${profile}) | |`)
    }
  }
  for (const target of targets) {
    if (!expectedChecks(profile).some((check) => check.target === target.target && check.suite.startsWith('truth'))) {
      rows.push(`| ${target.target} | truth | not selected (${profile}) | |`)
    }
  }
  rows.push('', ...errors.map((error) => `- ${error}`))
  const summary = rows.join('\n') + '\n'
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  if (errors.length) throw new Error('Required validation did not succeed')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, first, second] = process.argv.slice(2)
    if (command === 'plan') plan()
    else if (command === 'run') await run(first, second)
    else if (command === 'stamp-addon') addon(first, true)
    else if (command === 'sessions') collectSessions()
    else if (command === 'gate') gate()
    else throw new Error('usage: node bench/ci.ts plan | run <suite> <target> | stamp-addon <target> | sessions | gate')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
