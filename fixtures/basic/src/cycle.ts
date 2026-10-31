import { cached } from './cycle-cache'

export function base(): number {
  return 2
}

export const doubled = cached * 2
