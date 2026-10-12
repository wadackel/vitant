import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { addonTarget } from '../src/platform.ts'

const target = addonTarget()
const addon = target && path.join(import.meta.dirname, `../build/fork.${target.name}.node`)
const watch = (takes: number, limit: number): string =>
  spawnSync(process.execPath, [path.join(import.meta.dirname, 'supervise.mjs'), addon!, String(takes), String(limit)], { encoding: 'utf8' }).stdout.trim()

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
})
