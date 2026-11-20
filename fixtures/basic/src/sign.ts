export function sign(value: number): string {
  if (Number.isNaN(value)) return 'none'
  if (value < 0) return 'negative'
  return value > 0 ? 'positive' : 'zero'
}
