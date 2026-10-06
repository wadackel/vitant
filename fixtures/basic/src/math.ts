export const LIMITS = { min: 0, max: 10 }

export function clamp(value: number, min = LIMITS.min, max = LIMITS.max): number {
  if (value < min) {
    return min
  }
  return value > max ? max : value
}

export function sum(values: number[]): number {
  let total = 0
  for (let i = 0; i < values.length; i++) {
    total += values[i]
  }
  return total
}

export function isEven(value: number): boolean {
  return value % 2 === 0
}

export function untested(value: string): string {
  return value.trim().toLowerCase()
}
