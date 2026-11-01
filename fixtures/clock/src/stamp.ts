export function label(n: number): string {
  if (n === 1) return 'one'
  if (n === 2) return 'two'
  if (n > 2 && n < 10) return 'few'
  return 'many'
}
