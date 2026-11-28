import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { calibrated, compareTruths, keyOf, mergeParts, type Part, type PartEntry, partitionKeys, validatePartitions } from '../bench/truth-shards.ts'

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

const entry = (line: number, suite = 'pass'): PartEntry => ({ file: 'src/a.ts', start: [line, 0], end: [line, 1], mutator: 'm', replacement: 'r', suite })
// The report's order, which is not the sorted order the shares are dealt in.
const reported = [12, 3, 7, 1, 10].map((line) => entry(line, line % 2 ? 'fail' : 'pass'))
const order = reported.map(keyOf)
const part = (shard: string, command = 'related'): Part => {
  const { selected, ...partition } = partitionKeys(order, shard)
  const mutants = selected.map((key) => reported.find((mutant) => keyOf(mutant) === key)!)
  return { command, mutants, partition: { ...partition, checked: mutants.map(keyOf) } }
}

describe('merging truth partitions', () => {
  it('gives the entries one make would have written, in the order of the report', () => {
    const merged = mergeParts(order, [part('2/3'), part('3/3'), part('1/3')])
    expect(merged).toEqual({ command: 'related', mutants: reported })
  })

  it('refuses a missing, repeated or foreign share, another command, or entries other than those checked', () => {
    const other = [...order.slice(1), keyOf(entry(99))]
    const cases: Part[][] = [
      [],
      [part('1/3'), part('2/3')],
      [part('1/3'), part('2/3'), part('2/3')],
      [part('1/3'), part('2/3'), part('3/3', 'run')],
      [part('1/3'), part('2/3'), { ...part('3/3'), mutants: part('3/3').mutants.slice(1) }],
      [{ ...part('1/3'), mutants: [...part('1/3').mutants].reverse() }, part('2/3'), part('3/3')],
    ]
    for (const parts of cases) expect('errors' in mergeParts(order, parts), JSON.stringify(parts)).toBe(true)
    expect('errors' in mergeParts(other, [part('1/1')])).toBe(true)
  })
})

describe('comparing two ground truths', () => {
  it('tells a mutant one detects and the other does not from one detected by failing in one and by the limit in the other', () => {
    const stored: Part = { command: 'related', mutants: [entry(1, 'fail'), entry(2, 'pass'), entry(3, 'timeout'), entry(4, 'pass')] }
    const made: Part = { command: 'related', mutants: [entry(1, 'fail'), entry(2, 'fail'), entry(3, 'fail'), entry(5, 'pass')] }
    const { same, failOrTimeout, differ, onlyMade, onlyStored } = compareTruths(made, stored)
    expect(same.map((e) => e.start[0])).toEqual([1])
    expect(failOrTimeout.map(([e]) => e.start[0])).toEqual([3])
    expect(differ.map(([e]) => e.start[0])).toEqual([2])
    expect(onlyMade.map((e) => e.start[0])).toEqual([5])
    expect(onlyStored.map((e) => e.start[0])).toEqual([4])
  })
})

describe('calibrating a share', () => {
  it('takes the limit from every file of the report with --related, as the whole does', () => {
    const eligible = [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'a.ts' }, { file: 'c.ts' }]
    const share = [eligible[1]]
    expect(calibrated({ related: true, shard: true, eligible, mutants: share })).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(calibrated({ related: true, shard: false, eligible, mutants: share })).toEqual(['b.ts'])
    expect(calibrated({ related: false, shard: true, eligible, mutants: share })).toEqual([''])
  })
})

describe('truth shard command boundary', () => {
  it.each([
    ['--shard', '0/4'],
    ['--shard', '1/4', '--sample', '1'],
    ['--shard', '1/4', '--vitest=one.test.ts'],
    ['--shard', '1/4', '--statuses', 'Killed'],
    ['--shard', '1/4', '--target', 'ufo', '--sample', '1'],
  ])('rejects invalid or partial-suite options before running the tool: %j', (...args) => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '../bench/truth.ts'), 'make',
      '--root', 'nonexistent-truth-fixture', '--out', 'unused-truth-output.json', ...args], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Shard must|--shard requires/)
    expect(result.stderr).not.toContain('the tool exited')
  })

  it.each([
    ['--target', 'ufo'],
    ['--target', 'ufo', '--related'],
    ['--root', 'nonexistent-truth-fixture', '--related'],
  ])('lets a share run with a target or --related: %j', (...args) => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '../bench/truth.ts'), 'make', '--shard', '1/4',
      '--report', 'nonexistent-truth-report.json', '--out', 'unused-truth-output.json', ...args], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).not.toMatch(/Shard must|--shard requires/)
    expect(result.stderr).toContain('nonexistent-truth-report.json')
  })

  it('rejects a target bench/targets.ts does not have before running the tool', () => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '../bench/truth.ts'), 'make', '--target', 'nonexistent-target'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('no target nonexistent-target in bench/targets.ts')
  })
})
