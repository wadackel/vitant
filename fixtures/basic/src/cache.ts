let cached: number | undefined

export function answer(): number {
  cached ??= 40 + 2
  return cached
}
