import { afterAll, it } from 'vitest'
import { closeAll, leaked, openHandle } from '../src/handles'

// Runs once, after the last test: no test reaches `closeAll` or `leaked`.
afterAll(() => {
  closeAll()
  if (leaked()) throw new Error('a handle is still open')
})

it('opens a handle', () => {
  openHandle(1)
})
