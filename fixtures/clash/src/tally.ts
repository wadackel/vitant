export function tally(marks: number[]): { passed: number; failed: number } {
  let passed = 0
  let failed = 0
  for (const mark of marks) {
    if (mark >= 50) passed++
    else if (mark >= 0) failed++
  }
  return { passed, failed }
}
