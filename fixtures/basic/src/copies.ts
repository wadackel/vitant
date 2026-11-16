export function copies(word: string, count: number): string[] {
  return count > 1 ? [word, word] : [word]
}
