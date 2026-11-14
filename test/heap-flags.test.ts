import { afterEach, describe, expect, it } from 'vitest'
import { heapFlags, yieldingTo } from '../src/run.ts'

const saved = process.env.NODE_OPTIONS
afterEach(() => {
  if (saved === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = saved
})

describe('the V8 settings copied workers get', () => {
  const ours = ['--single-threaded', ...heapFlags]

  it('are all added when the project sets none of them', () => {
    delete process.env.NODE_OPTIONS
    expect(yieldingTo(['--expose-gc'], ours)).toEqual(ours)
  })

  it('give way to the project setting one of them, in either spelling', () => {
    delete process.env.NODE_OPTIONS
    expect(yieldingTo(['--max_semi_space_size=16', '--memory-reducer'], ours)).toEqual(['--single-threaded', '--min-semi-space-size=64'])
  })

  it('give way to NODE_OPTIONS as well', () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096 --min-semi-space-size=8'
    expect(yieldingTo([], ours)).toEqual(['--single-threaded', '--max-semi-space-size=64', '--no-memory-reducer'])
  })

  it("never drop the tool's own arguments", () => {
    delete process.env.NODE_OPTIONS
    expect(yieldingTo(['--single-threaded'], ours)).toContain('--single-threaded')
  })
})
