let open = 0

/** Runs `work` one level in, as a batch of updates runs its changes. */
export function nested<T>(work: () => T): T {
  open++
  try {
    return work()
  } finally {
    open--
  }
}

/** Whether every level opened has been closed again. */
export function closed(): boolean {
  return open === 0
}
