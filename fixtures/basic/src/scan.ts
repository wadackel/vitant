export function firstAbove(values: Float64Array, threshold: number, cap: number): number {
  let found = -1
  for (let i = 0; i < values.length && i < cap; i++) {
    if (values[i] > threshold) found = i
  }
  return found
}
