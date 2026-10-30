export async function settle(mode: string): Promise<string> {
  const waitMs = mode === 'now' ? 0 : 2000
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return mode
}
