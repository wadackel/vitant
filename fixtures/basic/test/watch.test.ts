import { expect, it } from 'vitest'
import { watch } from '../src/watch.ts'

// Vitest's command sets NODE_ENV to `test` before it starts, and code that
// skips a watcher in tests, as a VS Code extension's does, relies on that.
// Without it the rejection nothing handles fails every run of the file,
// outside any test, while the suite passes.
it('watches the file it is given', () => {
  expect(watch(' settings.json ')).toBe('settings.json')
})
