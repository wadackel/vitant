export function memoize(make) {
  const made = new Map()
  return (key) => {
    if (!made.has(key)) made.set(key, make(key))
    return made.get(key)
  }
}
