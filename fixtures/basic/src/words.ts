export function firstWord(text: string): string {
  const end = text.indexOf(' ')
  return end === -1 ? text : text.slice(0, end)
}

export function shout(text: string): string {
  if (text.length > 100) {
    return text
  }
  return text.toUpperCase()
}
