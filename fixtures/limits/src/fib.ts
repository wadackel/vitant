const memo = new Map<number, number>()

export function fib(n: number): number {
  if (n < 2) return n
  const known = memo.get(n)
  if (known !== undefined) return known
  const value = fib(n - 1) + fib(n - 2)
  memo.set(n, value)
  return value
}
