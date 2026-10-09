export function clamp(value: number, max: number): number {
  return value > max ? max : value
}

// Runs while the module loads. With these arguments none of the mutants of
// the comparison in `clamp` changes what comes out: a run of the file may
// begin after loading for them. `ceiling` is one they do change.
export const floor = clamp(1, 10)
export const ceiling = clamp(10, 10)
