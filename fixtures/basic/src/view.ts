export function withView<T extends object, R>(target: T, use: (view: T) => R): R {
  const { proxy, revoke } = Proxy.revocable(target, {})
  try {
    return use(proxy)
  } finally {
    revoke()
  }
}

export function unwrap<T extends object>(value: T, copy = false): T {
  return copy ? { ...value } : value
}

export function keep<T extends object>(value: T, fresh = false): T {
  return fresh ? { ...value } : value
}
