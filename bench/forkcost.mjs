// How much slower work is in a copy of a process than in the process itself,
// on this machine: node bench/forkcost.mjs <addon> [megabytes held]
// A worker that has loaded a large application holds hundreds of megabytes,
// and a copy pays for every page of them it writes to, which the collector
// does across the whole heap. Prints the time of a loop that only computes
// and of one that makes the collector go through the heap, in the process
// and in five copies made one after another.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const [addonPath, megabytes = '500'] = process.argv.slice(2)
const addon = createRequire(import.meta.url)(path.resolve(addonPath))
const held = []
for (let i = 0; i < Number(megabytes) * 1024; i++) held.push({ index: i, text: `entry ${i}`, data: new Array(100).fill(i) })

function compute() {
  const start = performance.now()
  let sum = 0
  for (let i = 0; i < 2e8; i++) sum = (sum + i * 7) % 1000003
  return [performance.now() - start, sum]
}
function collect() {
  const start = performance.now()
  for (let i = 0; i < held.length; i += 7) held[i].index++
  let kept = []
  for (let i = 0; i < 3e6; i++) {
    kept.push({ i })
    if (kept.length > 1e5) kept = []
  }
  return [performance.now() - start, kept.length]
}

// Written at once: a copy ends right after, before a pipe on macOS would have been written to.
const report = (where, [computeMs], [collectMs]) => fs.writeSync(1, `${where}: compute ${computeMs.toFixed(0)} ms, collect ${collectMs.toFixed(0)} ms\n`)
report('process', compute(), collect())
const lock = fs.openSync(addonPath, 'r')
for (let copy = 1; copy <= 5; copy++) {
  const pid = addon.fork(lock)
  if (pid === 0) {
    report(`copy ${copy}`, compute(), collect())
    addon.done()
    addon.exit(0)
  }
  addon.supervise(pid, 600_000, 0)
}
