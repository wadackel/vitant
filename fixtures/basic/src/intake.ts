export function grade(size: number): string {
  return size > 10 ? 'large' : 'small'
}

// Runs as the module loads, so its mutants' runs are copies made while the file loads.
export const initial = grade(20)
