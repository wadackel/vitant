import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createE2E, root } from '../helpers/e2e.ts'
import type { RunResult } from '../../src/run.ts'

const owner = createE2E('leftovers')
const stray: number[] = []
afterAll(() => {
  for (const pid of stray) if (alive(pid)) process.kill(pid, 'SIGKILL')
  owner.cleanup()
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function project(name: string, vitestPath: string, files: Record<string, string>): string {
  const directory = path.join(owner.directory, name)
  for (const sub of ['src', 'test', 'node_modules']) fs.mkdirSync(path.join(directory, sub), { recursive: true })
  fs.symlinkSync(vitestPath, path.join(directory, 'node_modules/vitest'), 'junction')
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}')
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), text)
  return directory
}

const versions = ['vitest3', 'vitest', 'vitest51'].map((name) => [name, path.join(root, 'node_modules', name)] as const)
const modes = [['default', []], ['no-clone', ['--no-clone']]] as const
const fixture = (file: string) => fs.readFileSync(path.join(root, 'fixtures/basic', file), 'utf8')

it.each(versions.flatMap(([version, vitestPath]) => modes.map(([name, mode]) => [version, name, vitestPath, mode] as const)))('ends the tries of a test whose mutant left callbacks that never let the event loop turn, with %s in %s mode', (version, name, vitestPath, mode) => {
  const directory = project(`unwind-${version}-${name}`, vitestPath, {
    'src/unwind.ts': fixture('src/unwind.ts'),
    'test/unwind.test.ts': fixture('test/unwind.test.ts'),
  })
  const report = owner.reportPath(`unwind-${version}-${name}`)
  const cli = owner.tool(['--root', directory, '--mutate', 'src/unwind.ts', '--report', report, ...mode, 'test/unwind.test.ts'], { timeout: 100_000 })
  expect(cli.error, 'the run did not end in time').toBeUndefined()
  expect(cli.status, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
  expect(result.counts.Pending).toBe(0)
  // Which of its time or its memory ends a run of the loop first depends on the machine.
  expect(['Killed', 'Timeout']).toContain(result.mutants.find((mutant) => mutant.replacement === 'index++')?.status)
}, 120_000)

// Inline: the main process sets every project to update no snapshot.
it.each(versions)('leaves a snapshot file of an inline project as it was, with %s', (version, vitestPath) => {
  const snap = 'test/__snapshots__/copies.test.ts.snap'
  const directory = project(`snapshot-${version}`, vitestPath, {
    'vitest.config.ts': "import { defineConfig } from 'vitest/config'\n\nexport default defineConfig({ test: { projects: [{ extends: true, test: { name: 'inline' } }] } })\n",
    'src/copies.ts': fixture('src/copies.ts'),
    'test/copies.test.ts': fixture('test/copies.test.ts'),
  })
  fs.mkdirSync(path.join(directory, 'test/__snapshots__'))
  fs.writeFileSync(path.join(directory, snap), fixture(snap))
  const report = owner.reportPath(`snapshot-${version}`)
  const cli = owner.tool(['--root', directory, '--mutate', 'src/copies.ts', '--report', report], { timeout: 100_000 })
  expect(cli.status, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(fs.readFileSync(report, 'utf8')) as RunResult
  expect(result.mutants.find((mutant) => mutant.replacement === 'count <= 1')?.status).toBe('Killed')
  expect(fs.readFileSync(path.join(directory, snap), 'utf8')).toBe(fixture(snap))
}, 120_000)

// The test keeps its worker's event loop from turning for a minute without
// any mutant on; the main process is gone long before that.
it('leaves no worker behind when the main process is killed', async () => {
  const directory = project('orphan', path.join(root, 'node_modules/vitest'), {
    'src/spin.ts': 'export function seconds() { return 60 + 0 }\n',
    'test/spin.test.ts': `import { it } from 'vitest'
import { seconds } from '../src/spin.ts'
it('spins', () => {
  const end = performance.now() + seconds() * 1000
  while (performance.now() < end) {}
}, 120_000)
`,
  })
  const results = path.join(directory, 'node_modules/.vitant/session/results')
  const cli = childProcess.spawn(process.execPath, [path.join(root, 'src/cli.ts'), '--root', directory, '--mutate', 'src/spin.ts'], { cwd: root, stdio: 'ignore' })
  let worker: number | undefined
  for (let waited = 0; worker === undefined && waited < 60_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (const name of fs.existsSync(results) ? fs.readdirSync(results) : []) {
      if (fs.readFileSync(path.join(results, name), 'utf8').includes('"type":"loaded"')) worker = Number.parseInt(name, 10)
    }
  }
  expect(worker, 'no worker loaded the test file').toBeDefined()
  stray.push(worker!)
  // Into the test: before it, the worker still hears that its channel closed.
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const ended = new Promise((resolve) => cli.once('exit', resolve))
  cli.kill('SIGKILL')
  await ended
  for (let waited = 0; alive(worker!) && waited < 5_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100))
  expect(alive(worker!), `worker ${worker} outlived the main process`).toBe(false)
}, 90_000)
