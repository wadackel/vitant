export const GREETING = 'hello'
export const FAREWELL = 'bye'
export const MOTTO = 'carpe diem'
export const SLOGAN = 'just do it'
export const SECRET = 'hidden'
const PREFIX = '> '
export const BANNER = { text: PREFIX, width: 2 }

export function shout(text: string): string {
  return PREFIX + text.toUpperCase()
}

const WELCOME = 'welcome'
export { WELCOME as default }

export const TAGS = new Set(['red', 'blue'])
