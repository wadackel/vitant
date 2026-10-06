let held = 0

export function acquire(): number {
  held += 1
  return held
}

export function release(): void {
  if (held > 0) held -= 1
}

export function leaked(): boolean {
  return held !== 0
}
