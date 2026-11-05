export interface Partition {
  index: number
  total: number
  universe: string[]
  checked: string[]
}

export function partitionKeys(keys: string[], shard: string) {
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error('Shard must be INDEX/TOTAL')
  const [index, total] = shard.split('/').map(Number)
  if (index > total || total > 256) throw new Error('Shard must satisfy 1 <= INDEX <= TOTAL <= 256')
  const universe = [...keys].sort()
  if (new Set(universe).size !== universe.length) throw new Error('Duplicate mutant identity')
  return { index, total, universe, selected: universe.filter((_, at) => at % total === index - 1) }
}

export function validatePartitions(partitions: unknown[], total: number): string[] {
  const errors: string[] = []
  const seen = new Set<number>()
  let universe: string[] | undefined
  for (const value of partitions) {
    if (!value || typeof value !== 'object') {
      errors.push('Missing truth partition')
      continue
    }
    const part = value as Partial<Partition>
    if (!Number.isInteger(part.index) || part.index! < 1 || part.index! > total || part.total !== total
      || !Array.isArray(part.universe) || !part.universe.every((key) => typeof key === 'string')
      || !Array.isArray(part.checked) || !part.checked.every((key) => typeof key === 'string')) {
      errors.push('Malformed truth partition')
      continue
    }
    if (seen.has(part.index!)) errors.push(`Duplicate truth partition: ${part.index}`)
    seen.add(part.index!)
    if (universe && JSON.stringify(universe) !== JSON.stringify(part.universe)) errors.push('Truth partitions disagree on the mutant set')
    universe ??= part.universe
    try {
      const expected = partitionKeys(part.universe, `${part.index}/${total}`)
      if (JSON.stringify(expected.universe) !== JSON.stringify(part.universe)
        || JSON.stringify(expected.selected) !== JSON.stringify([...part.checked].sort())) {
        errors.push(`Incomplete or unexpected mutants in truth partition: ${part.index}`)
      }
    } catch {
      errors.push('Invalid truth mutant set')
    }
  }
  for (let index = 1; index <= total; index++) if (!seen.has(index)) errors.push(`Missing truth partition: ${index}`)
  return errors
}
