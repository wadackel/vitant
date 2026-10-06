let next = 0

/** Hands out ids from a module-level counter, so results depend on how often it ran. */
export function nextId(prefix = 'id'): string {
  next += 1
  return prefix + next
}
