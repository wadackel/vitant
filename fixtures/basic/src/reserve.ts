export function reserve(stock: number, wanted: number): number {
  if (wanted > stock) return 0
  return wanted
}
