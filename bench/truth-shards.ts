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

/**
 * The files whose runs with no mutant a `make` takes the time limit from:
 * with `--related` the mutated files, every one of the report's for a share
 * as for the whole, since from its own files alone a share's limit could be
 * lower and a mutant that only slows its tests would time out in it and not
 * in the whole; otherwise the whole suite, '' standing for no file.
 */
export function calibrated({ related, shard, eligible, mutants }: {
  related: boolean
  shard: boolean
  eligible: { file: string }[]
  mutants: { file: string }[]
}): string[] {
  return related ? [...new Set((shard ? eligible : mutants).map((mutant) => mutant.file))] : ['']
}

export interface PartEntry {
  file: string
  start: [line: number, column: number]
  end: [line: number, column: number]
  mutator: string
  replacement: string
  suite: string
  note?: string
}

export interface Part {
  command: string
  mutants: PartEntry[]
  partition?: Partition
}

export const keyOf = (entry: Pick<PartEntry, 'file' | 'start' | 'end' | 'mutator' | 'replacement'>) =>
  [entry.file, ...entry.start, ...entry.end, entry.mutator, entry.replacement].join('|')

/**
 * The truth one job would have written from the parts `--shard` wrote, its
 * entries in `order`, the keys of the report's eligible mutants as that job
 * takes them; or what keeps the parts from making it. Each key of `order` has
 * to be checked by exactly one part, every part made with the same command
 * and holding the entries its partition says it checked.
 */
export function mergeParts(order: string[], parts: Part[]): { command: string; mutants: PartEntry[] } | { errors: string[] } {
  if (parts.length === 0) return { errors: ['No truth partition'] }
  const total = parts[0].partition?.total ?? 0
  const errors = validatePartitions(parts.map((part) => part.partition), total)
  const commands = new Set(parts.map((part) => part.command))
  if (commands.size !== 1) errors.push(`Truth partitions made with different commands: ${[...commands].join(', ')}`)
  if (errors.length > 0) return { errors }
  const universe = parts[0].partition!.universe
  if (JSON.stringify([...order].sort()) !== JSON.stringify(universe)) errors.push('Truth partitions are not of the mutants of this report')
  const byKey = new Map<string, PartEntry>()
  for (const part of parts) {
    const keys = part.mutants.map(keyOf)
    if (JSON.stringify(keys) !== JSON.stringify(part.partition!.checked)) errors.push(`Entries of truth partition ${part.partition!.index} are not the ones it checked`)
    part.mutants.forEach((entry, at) => byKey.set(keys[at], entry))
  }
  if (errors.length > 0) return { errors }
  return { command: parts[0].command, mutants: order.map((key) => byKey.get(key)!) }
}

/** How the entries of `made` differ from those of `stored`, by what each says the suite does. */
export function compareTruths(made: Part, stored: Part) {
  const storedByKey = new Map(stored.mutants.map((entry) => [keyOf(entry), entry]))
  const madeKeys = new Set(made.mutants.map(keyOf))
  const detected = (suite: string) => suite !== 'pass'
  const same: PartEntry[] = []
  const failOrTimeout: [PartEntry, PartEntry][] = []
  const differ: [PartEntry, PartEntry][] = []
  const onlyMade: PartEntry[] = []
  for (const entry of made.mutants) {
    const was = storedByKey.get(keyOf(entry))
    if (!was) onlyMade.push(entry)
    else if (was.suite === entry.suite) same.push(entry)
    else if (detected(was.suite) === detected(entry.suite)) failOrTimeout.push([entry, was])
    else differ.push([entry, was])
  }
  const onlyStored = stored.mutants.filter((entry) => !madeKeys.has(keyOf(entry)))
  return { commands: [made.command, stored.command], same, failOrTimeout, differ, onlyMade, onlyStored }
}
