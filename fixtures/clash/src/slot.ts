export function describeSlot(taken: number, free: number): string {
  if (taken < 0 || free < 0) return 'invalid'
  if (taken === 0) return 'empty'
  if (free === 0) return 'full'
  return taken > free ? 'mostly taken' : 'mostly free'
}
