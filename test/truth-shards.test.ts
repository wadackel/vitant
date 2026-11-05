import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { partitionKeys, validatePartitions } from '../bench/truth-shards.ts'

const keys = ['mutant-z', 'mutant-a', 'mutant-b', 'mutant-c', 'mutant-d']
const proof = (shard: string, universe = keys) => {
  const { selected, ...partition } = partitionKeys(universe, shard)
  return { ...partition, checked: selected }
}

describe('truth partitions', () => {
  it('assigns every mutant exactly once, independently of report order', () => {
    const partitions = ['1/3', '2/3', '3/3'].map((shard) => proof(shard))
    expect(partitions.flatMap((p) => p.checked).sort()).toEqual([...keys].sort())
    expect(proof('2/3', [...keys].reverse())).toEqual(proof('2/3'))
    expect(validatePartitions(partitions, 3)).toEqual([])
  })

  it('retains empty partitions when there are fewer mutants than shards', () => {
    const partitions = ['1/3', '2/3', '3/3'].map((shard) => proof(shard, ['one']))
    expect(partitions.map((p) => p.checked.length)).toEqual([1, 0, 0])
    expect(validatePartitions(partitions, 3)).toEqual([])
  })

  it.each(['0/4', '5/4', '1/0', '1/-1', '1/2.5', '1', '1/4/2', '01/4', '1/257', 'NaN/4'])(
    'rejects invalid shard %s before running the suite', (shard) => {
      expect(() => partitionKeys(keys, shard)).toThrow()
    },
  )

  it('rejects duplicate mutant identities', () => {
    expect(() => partitionKeys(['one', 'one'], '1/2')).toThrow()
  })

  it('rejects missing, repeated, mismatched and malformed partitions', () => {
    const a = proof('1/2')
    const b = proof('2/2')
    for (const parts of [[], [a], [a, a], [a, b, b], [a, null], [a, { ...b, total: 3 }],
      [a, proof('2/2', [...keys, 'extra'])], [a, { ...b, checked: [] }],
      [a, { ...b, checked: [...b.checked, b.checked[0]] }], [a, { ...b, checked: a.checked }]]) {
      expect(validatePartitions(parts, 2), JSON.stringify(parts)).not.toEqual([])
    }
  })
})


describe('truth shard command boundary', () => {
  it.each([
    ['--shard', '0/4'],
    ['--shard', '1/4', '--sample', '1'],
    ['--shard', '1/4', '--related'],
    ['--shard', '1/4', '--vitest=one.test.ts'],
  ])('rejects invalid or partial-suite options before running the tool: %j', (...args) => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '../bench/truth.ts'), 'make',
      '--root', 'nonexistent-truth-fixture', '--out', 'unused-truth-output.json', ...args], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Shard must|--shard requires/)
    expect(result.stderr).not.toContain('the tool exited')
  })
})
