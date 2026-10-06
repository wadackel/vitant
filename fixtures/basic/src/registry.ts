const registry = new Map<string, { max: number }>()

export function double(value: number): number {
  return value * 2
}

export function setup(): void {
  if (!registry.has('limits')) registry.set('limits', { max: 10 + 10 })
}

export function max(): number {
  return registry.get('limits')!.max
}
