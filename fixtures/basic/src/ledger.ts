const entries: number[] = []

export function record(amount: number): void {
  entries.push(amount)
}

export function total(): number {
  let sum = 0
  for (const amount of entries) sum += amount
  return sum
}

export function clear(): void {
  entries.length = 0
}
