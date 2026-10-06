export function rate(kind: string): number {
  return kind === 'express' ? 3 : 1
}

export function surcharge(weight: number): number {
  return weight > 10 ? 2 : 0
}
