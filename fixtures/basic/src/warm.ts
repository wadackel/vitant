let early = true
setTimeout(() => {
  early = false
}, 1000).unref()

export function bump(x: number): number {
  if (early) return x + 1
  return x
}
