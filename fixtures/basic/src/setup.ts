export function warm(): number {
  let n = 0
  while (n < 1500000) n++
  return n
}

export function next(value: number): number {
  return value + 1
}
