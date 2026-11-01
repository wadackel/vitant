export function settle(mode: string): number {
  const budgetMs = mode === 'quick' ? 5 : 4000
  const kept: object[] = new Array(300_000)
  const start = performance.now()
  let rounds = 0
  while (performance.now() - start < budgetMs) {
    kept[rounds % kept.length] = { rounds, label: `r${rounds}` }
    rounds++
  }
  return rounds
}
