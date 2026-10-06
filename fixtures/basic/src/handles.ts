const open = new Set<number>()

export function openHandle(id: number): void {
  open.add(id)
}

export function closeAll(): void {
  open.clear()
}

export function leaked(): boolean {
  return open.size > 0
}
