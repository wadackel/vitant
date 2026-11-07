import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { value } from '../src/hook-context'

let spy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  spy = vi.spyOn(AsyncLocalStorage.prototype, 'run')
})

describe('application context', () => {
  beforeEach(() => {})
  afterEach(() => spy.mockRestore())
  it('does not enter an application context', () => {
    value()
    expect(spy).not.toHaveBeenCalled()
  })
})
