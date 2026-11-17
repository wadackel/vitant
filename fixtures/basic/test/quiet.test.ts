import { expect, it } from 'vitest'
import { quiet } from '../src/quiet.ts'

// As `collect.test.ts`, with a flag a worker thread takes: Node refuses
// `--expose-gc` for one, so a project on `threads` cannot give it.
it('keeps deprecation warnings quiet', () => {
  expect(quiet()).toBe(true)
})
