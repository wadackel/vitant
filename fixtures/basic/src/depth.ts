let depth = 0
let lost = false
const warnings: string[] = []

export function enter(): void {
  depth++
}

export function leave(): void {
  depth--
  if (depth !== 0) lost = true
}

export function inside(): boolean {
  return lost || depth !== 0
}

export function onLeave(silent = false): void {
  if (inside()) return
  if (!silent) warnings.push('called outside')
}

export function warned(): string[] {
  return warnings.splice(0)
}
