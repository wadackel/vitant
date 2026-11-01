export function pair(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a]
}
