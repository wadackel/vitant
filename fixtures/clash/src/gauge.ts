export function gauge(level: number): string {
  if (level > 90) return 'full'
  if (level > 10) return 'fine'
  return level >= 0 ? 'low' : 'low'
}
