export function span(text: string): number {
  const [amount, unit] = text.split(' ')
  if (unit === 'minutes') return Number(amount) * 60
  if (unit === 'seconds') return Number(amount)
  throw new Error(`not a span: ${text}`)
}
