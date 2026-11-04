// Where the time of a run went, round by round, from what its workers wrote
// down (`bench/run.ts --records` keeps it in bench/results/<scope>/vitant-records):
//
//   node bench/spent.ts <records dir>
//
// A round's slots are its workers times how long it took. Of those, the runs
// of whole files and the tries say how long they took themselves; what is
// left is starting and loading, waiting on a lock, and slots left empty while
// a round waits for its last runs.

import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node bench/spent.ts <records dir>')
  process.exit(1)
}

interface Row {
  round: number
  startedAt: number
  at: number
  workers: number
  whole: Map<string, { runs: number; ms: number; stopped: number }>
  tries: number
  triesMs: number
  workersStarted: number
  files: number
  filesMs: number
  loads: number
  loadsMs: number
}

const records = fs
  .readdirSync(dir)
  .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string; at: number })
const rounds: Row[] = records
  .filter((record) => record.type === 'round')
  .map((record) => ({
    round: record.round as number,
    startedAt: record.startedAt as number,
    at: record.at,
    workers: record.workers as number,
    whole: new Map(),
    tries: 0,
    triesMs: 0,
    workersStarted: 0,
    files: 0,
    filesMs: 0,
    loads: 0,
    loadsMs: 0,
  }))
  .sort((a, b) => a.round - b.round)
if (rounds.length === 0) {
  console.error(`${dir}: no round was written down; the run is of a version before rounds were`)
  process.exit(1)
}

for (const record of records) {
  // What the main process writes down of a round, the runs it stopped for one, comes after the round's end.
  const row = rounds.findLast((round) => record.at > round.startedAt)
  if (!row) continue
  if (record.type === 'worker') row.workersStarted++
  if (record.type === 'loaded' && typeof record.ms === 'number') {
    row.loads++
    row.loadsMs += record.ms
  }
  // A worker's time with a file, from taking it on to its end: loading, the tries and the copies it waited for.
  if (record.type === 'file' && typeof record.wallMs === 'number') {
    row.files++
    row.filesMs += record.wallMs
  }
  if (record.type === 'test' && typeof record.ms === 'number') {
    row.tries += (record.attempts as number | undefined) ?? 0
    row.triesMs += record.ms
  }
  if (record.type === 'whole') {
    const kind = `${record.verdict}${record.quiet ? ' quiet' : ''}`
    const entry = row.whole.get(kind) ?? { runs: 0, ms: 0, stopped: 0 }
    entry.runs++
    // A run stopped from outside is written down by the main process, which does not know how long it took: its time is in the rest.
    if (typeof record.ms === 'number') entry.ms += record.ms
    else entry.stopped++
    row.whole.set(kind, entry)
  }
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)
const table = [['round', 'wall s', 'slots s', 'tries', 'tries s', 'whole runs by verdict: runs/s', 'workers started', 'files/s', 'loads/s', 'rest s']]
let total = { wall: 0, slots: 0, tries: 0, whole: 0 }
for (const row of rounds) {
  const wall = row.at - row.startedAt
  const slots = wall * row.workers
  const wholeMs = [...row.whole.values()].reduce((sum, entry) => sum + entry.ms, 0)
  total = { wall: total.wall + wall, slots: total.slots + slots, tries: total.tries + row.triesMs, whole: total.whole + wholeMs }
  table.push([
    String(row.round),
    seconds(wall),
    seconds(slots),
    String(row.tries),
    seconds(row.triesMs),
    [...row.whole].map(([kind, entry]) => `${kind} ${entry.runs}/${seconds(entry.ms)}${entry.stopped ? ` (${entry.stopped} stopped)` : ''}`).join(', '),
    String(row.workersStarted),
    `${row.files}/${seconds(row.filesMs)}`,
    `${row.loads}/${seconds(row.loadsMs)}`,
    seconds(slots - wholeMs - row.triesMs),
  ])
}
table.push(['all', seconds(total.wall), seconds(total.slots), '', seconds(total.tries), seconds(total.whole), '', '', '', seconds(total.slots - total.whole - total.tries)])
const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)))
for (const row of table) console.log(row.map((cell, column) => (column === 5 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  '))
