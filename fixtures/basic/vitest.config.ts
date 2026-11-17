import { defineConfig } from 'vitest/config'

// `collect.test.ts` and `quiet.test.ts` need the flags.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], execArgv: ['--expose-gc', '--no-deprecation'] } })
