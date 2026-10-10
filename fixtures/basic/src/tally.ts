const noted: number[] = []

export function note(value: number): void {
  noted.push(value)
}

export function total(): number {
  let sum = 0
  for (const value of noted) sum += value
  return sum
}

export function count(): number {
  return noted.length
}

export function reset(): void {
  noted.length = 0
}
