import type { TestProject } from 'vitest/node'
import { clocks } from './clocks'

// Vitest's main process is plain Node wherever the tests run, so its table
// is what every worker, copied or not, must give.
export default function setup(project: TestProject): void {
  project.provide('clocks', clocks())
}
