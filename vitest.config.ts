import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/*.test.ts'], exclude: ['test/supervise.test.ts'], sequence: { groupOrder: 0 } } },
      { test: { name: 'smoke', include: ['test/e2e/smoke.test.ts', 'test/supervise.test.ts'], fileParallelism: false, sequence: { groupOrder: 1 } } },
      { test: { name: 'e2e', include: ['test/e2e/*.test.ts'], exclude: ['test/e2e/smoke.test.ts'], fileParallelism: false, sequence: { groupOrder: 2 } } },
    ],
  },
})
