import { expect, it } from 'vitest'
import { alive, up } from '../src/alive'

// With a mutant of `alive` on, every run of the file ends with its worker.
it('stays up', () => {
  expect(typeof alive()).not.toBe('symbol')
  if (up !== true) process.kill(process.pid, 'SIGKILL')
})
