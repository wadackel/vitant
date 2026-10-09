// Packs the tool as it would be published, installs it next to Vitest into a
// copy of the fixture project outside this repository, and runs it from
// there: every mutant has to come out as it does when run from the sources.
// What only shows once the tool sits under node_modules shows here: sources
// Node will not run there, a file the package leaves out, an addon that is
// not found through its package.
//
//   node bench/packed.ts

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addonTarget } from '../src/platform.ts'
import type { RunResult } from '../src/run.ts'

const root = path.join(import.meta.dirname, '..')
const fixture = path.join(root, 'fixtures/basic')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-packed-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))

// On Windows npm is a script, which only a shell starts.
const npm = (args: string[], cwd: string) =>
  execFileSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'] })
const pack = (dir: string) => path.join(work, npm(['pack', '--pack-destination', work], dir).trim().split('\n').at(-1)!)

const tarballs = [pack(root)]
const target = addonTarget()
const addon = target && path.join(root, 'build', `fork.${target.name}.node`)
if (target && addon && fs.existsSync(addon)) {
  const staged = path.join(work, `addon-${target.name}`)
  fs.cpSync(path.join(root, 'npm', target.name), staged, { recursive: true })
  fs.copyFileSync(addon, path.join(staged, path.basename(addon)))
  tarballs.push(pack(staged))
}

const project = path.join(work, 'project')
fs.cpSync(fixture, project, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' })
const { devDependencies } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
npm(['install', '--no-audit', '--no-fund', `vitest@${devDependencies.vitest}`, ...tarballs], project)

const report = (cwd: string, command: string[]): RunResult => {
  const file = path.join(work, `report-${path.basename(cwd)}.json`)
  execFileSync(command[0], [...command.slice(1), '--report', file], { cwd, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RunResult
}
const installed = report(project, ['npx', 'vitant'])
const sources = report(fixture, [process.execPath, path.join(root, 'src/cli.ts')])

const key = (mutant: RunResult['mutants'][number]) =>
  [mutant.file, mutant.location.start.line, mutant.location.start.column, mutant.mutator, mutant.replacement].join('|')
const expected = new Map(sources.mutants.map((mutant) => [key(mutant), mutant.status]))
// A mutant that fails a test and loops is Killed in one run and Timeout in another.
const detected = (status: string | undefined) => (status === 'Killed' || status === 'Timeout' ? 'detected' : status)
const wrong = installed.mutants.filter((mutant) => detected(expected.get(key(mutant))) !== detected(mutant.status))
const problems = wrong.map((mutant) => `${key(mutant)}: ${expected.get(key(mutant))} from the sources, ${mutant.status} installed`)
if (installed.mutants.length !== sources.mutants.length) problems.push(`${installed.mutants.length} mutants installed, ${sources.mutants.length} from the sources`)
if (installed.abandonedFiles.length > 0) problems.push(`gave up on ${installed.abandonedFiles.join(', ')}`)
const copies = installed.wholeRuns['copied before load'] + installed.wholeRuns['copied after load']
if (tarballs.length > 1 && copies === 0) problems.push('no run was made in a copy: the addon was not found through its package')

console.log(`${installed.mutants.length} mutants from the packed tool, ${copies} of its runs in copies: ${problems.length === 0 ? 'as from the sources' : 'not as from the sources'}`)
for (const problem of problems) console.log(`  ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
