export function checked(n: number): number {
  const label = `checked ${n}`
  if (n < 0) throw new RangeError(label)
  return n
}
