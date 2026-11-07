export function echo(value: number): number {
  if (value < 0) console.error('negative')
  return value
}
