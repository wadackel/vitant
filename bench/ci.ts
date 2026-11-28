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
// The suite does with a mutant what it does however the tool ran, so one truth of the basic fixture is checked against
// both its default and its `--static` report: two cases of it made the same truth, each mutant's suite run twice.
const truthCases = [
  { name: 'basic', root: 'basic', shards: 8, jobs: 4, args: ['--also-tool=--static'] },
  ...['stuck', 'clash', 'walk'].map((name) => ({ name, root: name, shards: 1, jobs: 1, args: [] as string[] })),
]
const truthLanes = truthCases.flatMap((test) => Array.from({ length: test.shards }, (_, i) => ({
  ...test, suite: `truth-${test.name}-${i + 1}`, shard: `${i + 1}/${test.shards}`,
})))
// Windows starts processes so slowly that the whole truth command on one runner came within minutes of its 200-minute limit.
const partitionedTruth = (profile: Profile) => profile === 'full' ? ['win32-x64'] : ['linux-x64-gnu']
// About nine minutes each on macOS arm64, the longest setting the PR's time. With the packed lane, which also smokes the
// environment and so is about as long, that is five macOS jobs, as many as an account runs at once; macOS x64's build still
// holds one when they start, and which lane waits for it differs from run to run, the matrix order notwithstanding.
// e2e files no lane names run in the packed lane, so a new file is never left out.
const e2eLanes = [['basic.test.ts', 'hooks.test.ts', 'pool-argv.test.ts'], ['basic-modes.test.ts'], ['basic-options.test.ts'],
  ['boundaries.test.ts', 'cache.test.ts', 'process-listeners.test.ts']]
const e2eSuites = e2eLanes.map((_, i) => `e2e-${i + 1}`)
// Windows runs no other unit tests in a PR. Its quick job needs no addon, so unlike a detail lane it waits for no build.
const quickTargets = ['linux-x64-gnu', 'win32-x64']
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
    ...quickTargets.map((target) => ({ target, suite: 'quick' })),
    ...targets.map(({ target }) => ({ target, suite: 'smoke' })),
    ...(profile === 'full'
      ? targets.flatMap(({ target }) => ['regression', 'truth'].map((suite) => ({ target, suite })))
        .filter((check) => check.suite !== 'truth' || !partitionedTruth(profile).includes(check.target))
      : targets.filter((target) => target.representative).flatMap(({ target }) => [...e2eSuites, 'packed'].map((suite) => ({ target, suite })))),
    ...partitionedTruth(profile).flatMap((target) => truthLanes.map(({ suite }) => ({ target, suite }))),
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
  if (suite === 'quick' && name === 'win32-x64') return [unit]
  if (suite === 'smoke') return [{ name: 'smoke', args: ['test:smoke', '--reporter=json', '--outputFile=build/test-reports/smoke.json'] }]
  if (suite === 'truth') return [{ name: 'truth', args: ['test:truth'] }]
  const e2e = (files: string[]) => ({ name: 'e2e', args: ['test:e2e', ...files.map((file) => `test/e2e/${file}`),
    '--reporter=json', '--outputFile=build/test-reports/e2e.json'] })
  if (e2eSuites.includes(suite)) return [e2e(e2eLanes[e2eSuites.indexOf(suite)])]
  if (suite === 'packed') {
    const rest = fs.readdirSync(path.join(root, 'test/e2e'))
      .filter((file) => file.endsWith('.test.ts') && file !== 'smoke.test.ts' && !e2eLanes.flat().includes(file)).sort()
    return [...(name === 'linux-x64-gnu' ? [] : [typecheck, unit]), ...(rest.length > 0 ? [e2e(rest)] : []), { name: 'packed', args: ['test:packed'] }]
  }
  const truth = truthLanes.find((lane) => lane.suite === suite)
  if (truth) return [{ name: 'truth', args: ['exec', 'node', 'bench/truth.ts', 'make',
    '--root', `fixtures/${truth.root}`, '--jobs', String(truth.jobs), '--shard', truth.shard,
    '--out', `build/test-reports/${suite}-truth.json`, ...truth.args] }]
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
  if (profile !== 'docs') for (const target of partitionedTruth(profile)) for (const test of truthCases) {
    const partitions = truthLanes.filter((lane) => lane.name === test.name).map((lane) => {
      const result = results.find((row) => object(row) && row.target === target && row.suite === lane.suite)
      const proof = object(result) ? result.truth : undefined
      if (object(proof)) {
        if (proof.index !== Number(lane.shard.split('/')[0]) || proof.total !== lane.shards) errors.push(`Wrong truth partition for ${target}/${lane.suite}`)
        if (Array.isArray(proof.universe) && proof.universe.length === 0) errors.push(`Empty truth mutant set for ${target}/${lane.suite}`)
      }
      return proof
    })
    errors.push(...validatePartitions(partitions, test.shards).map((error) => `${target} ${test.name}: ${error}`))
  }
  return errors
}

// An environment with a packed lane smokes at its start, not in the build every detail job of it waits for.
const smokeLane = 'packed'

/** The checks `ci.ts run <suite>` makes in one job: smoke goes with the packed lane. */
export const suitesOf = (suite: string) => suite === smokeLane ? ['smoke', suite] : [suite]

/**
 * The environments whose build the detail jobs wait for, those with a detail
 * check, and the others, which build and smoke beside the detail jobs; each
 * with whether its build job smokes.
 */
export function buildsFor(profile: Profile) {
  const checks = expectedChecks(profile)
  const detail = new Set(checks.filter((check) => !['quick', 'smoke'].includes(check.suite)).map((check) => check.target))
  const withSmoke = (target: typeof targets[number]) => ({ ...target, smoke: !checks.some((check) => check.target === target.target && check.suite === smokeLane) })
  return { needed: targets.filter((target) => detail.has(target.target)).map(withSmoke), others: targets.filter((target) => !detail.has(target.target)).map(withSmoke) }
}

// Every attempt names its artifacts with its number, and the latest attempt's of each name is taken. A job rerun
// leaves its earlier attempts' artifacts listed, some of them refused with a 404 when downloaded; a download by
// pattern would take those too, and one by name picks the highest ID, which does not follow upload order.
export function latestArtifacts(rows: { id: number; name: string }[], pattern: string): number[] {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const base = pattern.endsWith('*') ? `${escape(pattern.slice(0, -1))}.+` : escape(pattern)
  const named = new RegExp(`^(${base})-(\\d+)$`)
  const latest = new Map<string, { id: number; attempt: number }>()
  for (const row of rows) {
    const match = named.exec(row.name)
    if (!match) continue
    const attempt = Number(match[2])
    const seen = latest.get(match[1])
    if (!seen || attempt > seen.attempt) latest.set(match[1], { id: row.id, attempt })
  }
  return [...latest.values()].map(({ id }) => id)
}

export function validateJobs(profile: Profile, needs: unknown): string[] {
  if (!object(needs)) return ['Missing prerequisite jobs']
  return ['plan', 'quick', 'build', 'build-others', 'detail'].flatMap((job) => {
    const expected = job === 'plan' || (profile !== 'docs' && (job !== 'build-others' || buildsFor(profile).others.length > 0)) ? 'success' : 'skipped'
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

function artifacts(pattern: string) {
  const run = process.env.GITHUB_RUN_ID
  if (!run || !/^\d+$/.test(run) || !process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_RUN_ID and GITHUB_REPOSITORY must name this workflow run')
  const listing = execFileSync('gh', ['api', '--paginate', `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run}/artifacts?per_page=100`,
    '--jq', '.artifacts[] | select(.expired | not) | "\\(.id) \\(.name)"'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const rows = listing.split('\n').filter(Boolean).map((line) => {
    const [id, name] = line.split(' ')
    return { id: Number(id), name }
  })
  const ids = latestArtifacts(rows, pattern)
  if (ids.length === 0) throw new Error(`No artifact of this run is named ${pattern}-<attempt>`)
  for (const row of rows) if (ids.includes(row.id)) console.log(`${row.name} (ID: ${row.id})`)
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `ids=${ids.join(',')}\n`)
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
  const checks = expectedChecks(selection.profile)
  const quick = checks.filter((check) => check.suite === 'quick').map((check) => targetFor(check.target))
  const detail = checks.filter((check) => !['quick', 'smoke'].includes(check.suite))
    .map((check) => ({ ...targetFor(check.target), suite: check.suite }))
  // Queuing Windows truth after the shorter jobs would add their time to its long critical path.
  const truth = (check: Check) => check.suite.startsWith('truth')
  detail.sort((a, b) => Number(b.target === 'win32-x64' && truth(b)) - Number(a.target === 'win32-x64' && truth(a))
    || Number(b.suite === 'truth') - Number(a.suite === 'truth'))
  const output = { ...selection, sha, base: changed.base, head: changed.head, comparison: changed.comparison, diff: changed.diff,
    quick: JSON.stringify({ include: quick }), detail: JSON.stringify({ include: detail }),
    platforms: JSON.stringify({ include: buildsFor(selection.profile).needed }), others: JSON.stringify({ include: buildsFor(selection.profile).others }) }
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
    const suites = expectedChecks(profile).filter((check) => check.target === target.target).map((check) => check.suite)
    if (suites.some((suite) => ['regression', 'packed'].includes(suite))) continue
    rows.push(`| ${target.target} | ${suites.includes('quick') ? 'e2e/packed' : 'unit/e2e/packed'} | not selected (${profile}) | |`)
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
    else if (command === 'run') {
      // The packed check runs after a failed smoke, so that the gate gets both results.
      for (const suite of suitesOf(first)) {
        try {
          await run(suite, second)
        } catch (error) {
          console.error(error instanceof Error ? error.message : error)
          process.exitCode = 1
        }
      }
    }
    else if (command === 'stamp-addon') addon(first, true)
    else if (command === 'artifacts') artifacts(first)
    else if (command === 'sessions') collectSessions()
    else if (command === 'gate') gate()
    else throw new Error('usage: node bench/ci.ts plan | run <suite> <target> | stamp-addon <target> | artifacts <pattern> | sessions | gate')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
