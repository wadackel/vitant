export function weigh(grams: number): number {
  return Math.round(grams / 50) * 50 + (grams > 1000 ? 200 : 100)
}
