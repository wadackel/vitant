export function unwind(steps: (() => void)[]): Promise<number> {
  let settled = Promise.resolve(0)
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]
    settled = settled.then((count) => {
      try {
        step()
        return count + 1
      } catch {
        return count
      }
    })
  }
  return settled
}
