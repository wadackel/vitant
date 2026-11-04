import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const root = path.resolve(import.meta.dirname, '../..')

export function createE2E(name: string) {
  const directory = fs.mkdtempSync(path.join(root, 'fixtures', '.tmp-e2e-'))
  const parent = path.join(root, 'build/test-reports')
  fs.mkdirSync(parent, { recursive: true })
  const reports = fs.mkdtempSync(path.join(parent, `${name}-`))
  let runs = 0

  const fixture = (name: string) => {
    const project = path.join(directory, name)
    if (!fs.existsSync(project)) {
      // Sharing node_modules would also share the session the CLI removes at startup.
      fs.cpSync(path.join(root, 'fixtures', name), project, {
        recursive: true,
        filter: (source) => !['node_modules', '.git'].includes(path.basename(source)),
      })
    }
    return project
  }

  const reportPath = (name: string) => path.join(reports, `${name}.json`)
  const tool = (args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) => {
    // Inheriting Vitest's environment would hide a CLI that failed to set it itself.
    const env = Object.fromEntries(
      Object.entries(options.env ?? process.env).filter(([name]) => name !== 'NODE_ENV' && name !== 'TEST' && !name.startsWith('VITEST')),
    )
    const start = Date.now()
    const cli = childProcess.spawnSync(process.execPath, [path.join(root, 'src/cli.ts'), ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: options.timeout ?? 600_000,
      env,
    })
    const project = args.includes('--root') ? args[args.indexOf('--root') + 1] : undefined
    const name = `run-${++runs}`
    fs.appendFileSync(path.join(reports, 'runs.jsonl'), JSON.stringify({
      start, end: Date.now(), root: project, pid: cli.pid, status: cli.status, signal: cli.signal,
    }) + '\n')
    // Assertions can reject a report even when the CLI exits successfully.
    fs.writeFileSync(path.join(reports, `${name}.log`), `${cli.error ?? ''}\n${cli.stdout}\n${cli.stderr}`)
    const records = project && path.join(project, 'node_modules/.vitant/session/results')
    if (records && fs.existsSync(records)) fs.cpSync(records, path.join(reports, `${name}-records`), { recursive: true })
    const report = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined
    if (report && fs.existsSync(report) && path.dirname(report) !== reports) fs.copyFileSync(report, path.join(reports, `${name}-report.json`))
    return cli
  }

  return {
    directory, reports, fixture, reportPath, tool,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  }
}
