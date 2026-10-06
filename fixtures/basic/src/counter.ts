let count = 0

export function increment(by = 1): number {
  count += by
  return count
}

export function reset(): void {
  count = 0
}

export async function later(value: number): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 1))
  return value * 2
}
