// The tests read `total` alone: every mutant of the other fields passes
// them, and has a run of each test file to make.
export function weigh(items: number[]): { total: number; unit: string; note: string; label: string } {
  let total = 0
  for (const item of items) total += item
  return { total, unit: 'kg', note: 'summed', label: 'items' }
}
