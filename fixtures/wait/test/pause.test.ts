import { expect, it } from 'vitest'
import { pause } from '../src/pause'

// With `mode !== 'quick'` each test waits a second under a limit of five, and
// the file takes ten where it took a few milliseconds. The suite passes.
for (let n = 1; n <= 10; n++) {
  it(`pauses ${n}`, async () => {
    expect(await pause('quick')).toBeGreaterThan(0)
  })
}
