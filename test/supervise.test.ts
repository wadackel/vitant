import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { addonTarget } from '../src/platform.ts'

const target = addonTarget()
const addon = target && path.join(import.meta.dirname, `../build/fork.${target.name}.node`)
// A copy has one thread: with the threads V8 gives its garbage collector, it would wait for one it does not have.
const watch = (takes: number, limit: number): string =>
  spawnSync(process.execPath, ['--single-threaded', path.join(import.meta.dirname, 'supervise.mjs'), addon!, String(takes), String(limit)], { encoding: 'utf8' }).stdout.trim()

describe.runIf(addon && fs.existsSync(addon))('watching a copy of a process', () => {
  it('stops a copy that takes memory without end', () => {
    expect(watch(0, 512)).toBe('Blocked')
  }, 90_000)

  it('lets a copy end that stays under what it may hold', () => {
    expect(watch(128, 2048)).toBe('Done')
  }, 90_000)

  it('sets no limit on memory where none is given', () => {
    expect(watch(768, 0)).toBe('Done')
  }, 90_000)

  it('ends a copy whose process is gone, though the copy is in a loop', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vitant-orphan-')), 'pid')
    // Nothing of the copy's is waited for: it would hold a pipe open for as long as it lives.
    spawnSync(process.execPath, ['--single-threaded', path.join(import.meta.dirname, 'orphan.mjs'), addon!, out], { stdio: 'ignore' })
    const pid = Number(fs.readFileSync(out, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      await expect.poll(alive, { timeout: 10_000, interval: 100 }).toBe(false)
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL')
    }
  }, 30_000)
})
