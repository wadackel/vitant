import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
const [toolArgument, projectArgument, reportArgument] = process.argv.slice(2)
const tool = fs.realpathSync(toolArgument)
const root = fs.realpathSync(projectArgument)
const report = path.resolve(reportArgument)
process.chdir(root)
const { run } = await import(pathToFileURL(path.join(tool, 'src/run.ts')))
const { generate, defaultExclude } = await import(pathToFileURL(path.join(tool, 'src/mutate/generate.ts')))
const files = ['src/parse/lexer.ts', 'tests/cli.ts', 'tests/_setup.ts', 'vitest.config.js', 'package.json']
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
const before = hashes()
const cases = { 712: { start: [577, 20], end: [581, 5] }, 348: { start: [344, 26], end: [348, 9] } }
const selected = cases[Number(process.env.YAML_CASE ?? 712)]
if (!selected) throw new Error('Unknown YAML diagnostic identity')
const lines = Array.from({ length: selected.end[0] - selected.start[0] + 1 }, (_, index) => selected.start[0] + index)
const options = { root, include: ['src/parse/lexer.ts'], exclude: defaultExclude, lines: new Map([[path.join(root, 'src/parse/lexer.ts'), new Set(lines)]]) }
const generated = generate(options).mutants
const exact = mutant => {
  const location = mutant.location ?? mutant.loc
  return mutant.mutator === 'BlockStatement' && mutant.replacement === '{}' && location.start.line === selected.start[0] && location.start.column === selected.start[1] && location.end.line === selected.end[0] && location.end.column === selected.end[1]
}
if (generated.filter(exact).length !== 1) throw new Error('Exact YAML identity missing')
fs.writeFileSync(report + '.generated.json', JSON.stringify(generated, null, 2))
const watchdog = setTimeout(() => { console.error('Diagnostic bound reached'); process.exit(124) }, 180000)
const result = await run({ ...options, filters: ['tests/cli.ts'], projects: [], related: true, timeoutFactor: 4, timeoutMs: 3000, recycleHeapMb: 2048, loopFactor: 50, loopSlack: 1000000, budgetMs: 30000, cheapMs: 20, maxRounds: 200, incremental: false, clone: true, static: false, led: false, strict: false, confirm: Infinity, maxWorkers: 1, log: message => console.log(message) })
clearTimeout(watchdog)
fs.writeFileSync(report, JSON.stringify(result, null, 2))
const after = hashes()
const observation = { tool, root, before, after, restored: JSON.stringify(before) === JSON.stringify(after), exact: result.mutants.filter(exact), counts: result.counts, abandoned: result.abandonedFiles }
fs.writeFileSync(report + '.observation.json', JSON.stringify(observation, null, 2))
fs.cpSync(path.join(root, 'node_modules/.vitant/session/results'), report + '.records', { recursive: true })
console.log(JSON.stringify(observation))
process.exitCode = result.abandonedFiles.length || !observation.restored ? 1 : 0
