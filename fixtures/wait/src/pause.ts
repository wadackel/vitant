export async function pause(mode: string): Promise<number> {
  const waitMs = mode === 'quick' ? 0 : 1000
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return waitMs + 1
}
