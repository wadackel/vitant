import vm from 'node:vm'
import { afterAll, expect, it, vi } from 'vitest'
import { finish } from '../src/hook-vm'

vi.setConfig({ hookTimeout: 100 })

it('loads the cleanup calculation', () => {
  expect(typeof finish).toBe('function')
})

afterAll(() => {
  try {
    vm.runInNewContext('finish()', { finish }, { timeout: 1500 })
  } catch (error) {
    expect((error as { code?: string }).code).toBe('ERR_SCRIPT_EXECUTION_TIMEOUT')
  }
}, 5000)
