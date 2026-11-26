import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { pace } from '../src/crowd'

// Stands for a test that a mutant makes take much of the time Vitest gives
// it, and that runs out of that time when other processes hold the
// processors, as other runs do on a runner with few of them: in a run of the
// tool that sets CLASH_CROWD, the second execution that sees a value does
// its work while processes that never sleep take every processor. The work
// is the same each time, counted on the processor. Without the variable, as
// in a plain run of the suite, nothing else runs.
function crowded(value: string): (() => void) | undefined {
  const run = process.env.CLASH_CROWD
  if (!run) return undefined
  const counter = path.join(os.tmpdir(), `vitant-clash-crowd-${run}-${value}`)
  fs.appendFileSync(counter, '.')
  if (fs.statSync(counter).size !== 2) return undefined
  // In this process's session: Linux shares the processors out between
  // sessions first, so that the crowd would take half of them, not nearly
  // all. It ends itself in 20 s should this process be stopped first.
  const crowd = os.availableParallelism() * 10
  const script = [
    `trap 'kill $pids $guard 2>/dev/null; exit' TERM`,
    'pids=',
    `for i in $(seq ${crowd}); do (while :; do :; done) & pids="$pids $!"; done`,
    '(sleep 20; kill $pids 2>/dev/null) &',
    'guard=$!',
    'wait',
  ].join('\n')
  const hogs = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' })
  return () => hogs.kill('SIGTERM')
}

function work(ms: number): void {
  const start = process.cpuUsage()
  for (;;) {
    const used = process.cpuUsage(start)
    if ((used.user + used.system) / 1000 >= ms) return
  }
}

// A copy of a worker made once the file has loaded is withdrawn when its
// tests start a process, and the execution that crowds the processors would
// be one of those. A process started in every run makes each run of the file
// a copy made before it loads, which is never withdrawn.
beforeAll(async () => {
  if (!process.env.CLASH_CROWD) return
  await new Promise((resolve) => spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }).once('exit', resolve))
})

it('seats the crowd', () => {
  const at = pace()
  if (at !== 'brisk') {
    const leave = crowded(String(at))
    try {
      work(500)
    } finally {
      leave?.()
    }
  }
  expect(typeof at === 'symbol').toBe(false)
}, 3000)
