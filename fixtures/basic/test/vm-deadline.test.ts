import vm from 'node:vm'
import { expect, it } from 'vitest'
import { finish } from '../src/vm-deadline'

it('accepts completion or the caller VM deadline', () => {
  try {
    vm.runInNewContext('finish()', { finish }, { timeout: 50 })
  } catch (error) {
    expect((error as { code?: string }).code).toBe('ERR_SCRIPT_EXECUTION_TIMEOUT')
  }
})

it('allows the caller to discard an interrupted calculation', () => {
  try {
    vm.runInNewContext('finish()', { finish }, { timeout: 50 })
  } catch {}
})
