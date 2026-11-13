const CAP = 4_000_000

/** Fills `out` up to `n` zeros, at most `CAP`; an array that cannot grow any further is emptied. */
export function fill(out: number[], n: number): boolean {
  const target = n > CAP ? Infinity : n
  try {
    while (out.length < target) out.push(0)
  } catch {
    out.length = 0
  }
  return true
}
