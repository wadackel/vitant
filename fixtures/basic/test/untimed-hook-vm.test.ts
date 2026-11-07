import vm from 'node:vm'
import { afterAll, expect, it, vi } from 'vitest'
import { finish } from '../src/untimed-hook-vm'

vi.setConfig({ hookTimeout: 0 })

it('loads a calculation whose caller supplies its deadline', () => {
  expect(typeof finish).toBe('function')
})

afterAll(() => {
  try {
    vm.runInNewContext('finish()', { finish }, { timeout: 1500 })
  } catch {}
}, 0)
