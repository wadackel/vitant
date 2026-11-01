const store = new Map<string, { value: number; at: number }>()

export function put(key: string, value: number): void {
  store.set(key, { value, at: Date.now() })
}

export function get(key: string, ttlMs: number): number | undefined {
  const entry = store.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at < ttlMs) return entry.value
  return undefined
}
