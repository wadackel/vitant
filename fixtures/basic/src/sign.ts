export function sign(value: number): string {
  if (value < 0) return 'negative'
  return value > 0 ? 'positive' : 'zero'
}
