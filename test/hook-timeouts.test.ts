import vm from 'node:vm'
import { expect, it } from 'vitest'
import { observeTimeouts } from '../src/hooks.ts'

const source = `
const now = Date.now
function withTimeout(fn, timeout, isHook = false) {
  if (timeout <= 0 || timeout === Infinity) return fn
  return function runWithTimeout(...args) {
    const startTime = now()
    return new Promise((resolve_, reject_) => {
      const timer = setTimeout(() => rejectTimeoutError(), timeout)
      function rejectTimeoutError() { reject_(new Error('deadline')) }
      function resolve(value) { clearTimeout(timer); if (now() - startTime >= timeout) { rejectTimeoutError(); return }; resolve_(value) }
      function reject(error) { clearTimeout(timer); reject_(error) }
      try {
        const result = fn(...args)
        if (typeof result === 'object' && result !== null && typeof result.then === 'function') result.then(resolve, reject)
        else resolve(result)
      } catch (error) { reject(error) }
    })
  }
}
withTimeout
`

function fixture() {
  const events: string[] = []
  let timer: () => void = () => {}
  const wrap = vm.runInNewContext(observeTimeouts(source)!, {
    Date: { now: () => 0 },
    setTimeout(fn: () => void, ms: number) { events.push(`timer:${ms}`); timer = fn; return 1 },
    clearTimeout() {},
    __vitant_hookStart(timeout: number) {
      events.push(`scope:${timeout}`)
      return {
        run(fn: () => unknown) { events.push('run'); return fn() },
        start(exceeded: () => boolean) { expect(exceeded()).toBe(false); events.push('start') },
        end() { events.push('end') },
      }
    },
  }) as (fn: (...args: unknown[]) => unknown, timeout: number, hook?: boolean) => (...args: unknown[]) => Promise<unknown>
  return { events, wrap, expire: () => timer() }
}

it('starts observation after the hook deadline and preserves arguments and result', async () => {
  const { events, wrap } = fixture()
  const value = { result: 3 }
  expect(await wrap((arg) => { events.push('body'); expect(arg).toBe(value); return value }, 1200, true)(value)).toBe(value)
  expect(events).toEqual(['scope:1200', 'run', 'timer:1200', 'start', 'body', 'end'])
})

it('calls a custom thenable once and ends observation when Vitest settles', async () => {
  const { events, wrap } = fixture()
  let calls = 0
  expect(await wrap(() => ({ then(resolve: (value: number) => void) { calls++; resolve(42) } }), 100, true)()).toBe(42)
  expect(calls).toBe(1)
  expect(events.filter((event) => event === 'end')).toHaveLength(1)
})

it('retains the original rejection object and closes its observation', async () => {
  const { events, wrap } = fixture()
  const error = new Error('original')
  await expect(wrap(() => { throw error }, 100, true)()).rejects.toBe(error)
  expect(events.at(-1)).toBe('end')
})

it('closes a timed-out invocation without waiting for its pending body', async () => {
  const { events, wrap, expire } = fixture()
  const promise = wrap(() => new Promise(() => {}), 100, true)()
  expire()
  await expect(promise).rejects.toThrow('deadline')
  expect(events.at(-1)).toBe('end')
})

it('does not observe test bodies or disabled hook deadlines', async () => {
  const { events, wrap } = fixture()
  expect(await wrap(() => 7, 100, false)()).toBe(7)
  expect(events).toEqual(['timer:100'])
  events.length = 0
  const fn = () => 8
  expect(wrap(fn, 0, true)).toBe(fn)
  expect(wrap(fn, Infinity, true)).toBe(fn)
  expect(events).toEqual([])
})

it('preserves behavior when the observer is absent', async () => {
  const wrap = vm.runInNewContext(observeTimeouts(source)!, { Date: { now: () => 0 }, setTimeout, clearTimeout })
  expect(await wrap(() => 9, 100, true)()).toBe(9)
})

it('refuses unknown or ambiguous timeout implementations', () => {
  expect(observeTimeouts('function other() {}')).toBeUndefined()
  expect(observeTimeouts(source.replace('fn(...args)', 'fn.apply(null, args)'))).toBeUndefined()
  expect(observeTimeouts(`${source}\n${source}`)).toBeUndefined()
})

it('requires deadline installation and a matching elapsed check before resolution', () => {
  expect(observeTimeouts(source.replace('if (now() - startTime >= timeout) { rejectTimeoutError(); return };', ''))).toBeUndefined()
  expect(observeTimeouts(source.replace('>= timeout', '>= 0'))).toBeUndefined()
  expect(observeTimeouts(source.replace('setTimeout(() => rejectTimeoutError(), timeout)', 'undefined'))).toBeUndefined()
  expect(observeTimeouts(source.replace('const result = fn(...args)', 'const fn = () => 42; const result = fn(...args)'))).toBeUndefined()
  expect(observeTimeouts(source.replace('const result = fn(...args)', 'const { fn } = {}; const result = fn(...args)'))).toBeUndefined()
  expect(observeTimeouts(source.replace('function resolve(value)', 'function resolve(startTime)'))).toBeUndefined()
  expect(observeTimeouts(source.replace('result.then(resolve, reject)', 'result.then(resolve_, reject_)'))).toBeUndefined()
})

it('verifies the deadline-object form and refuses altered deadline arithmetic', () => {
  const modern = source.replace('function withTimeout', `class TaskDeadline {
    startTime = now()
    endTime
    timer
    constructor(timeout, onTimeout) { this.endTime = this.startTime + timeout; this.timer = setTimeout(onTimeout, timeout) }
    exceeded() { return now() >= this.endTime }
    clear() { clearTimeout(this.timer) }
  }
  function withTimeout`).replace('const startTime = now()', '')
    .replace('const timer = setTimeout(() => rejectTimeoutError(), timeout)', 'const deadline = new TaskDeadline(timeout, () => rejectTimeoutError())')
    .replaceAll('clearTimeout(timer)', 'deadline.clear()')
    .replace('now() - startTime >= timeout', 'deadline.exceeded()')
  expect(observeTimeouts(modern)).toBeDefined()
  expect(observeTimeouts(modern.replace('this.startTime + timeout', 'this.startTime - timeout'))).toBeUndefined()
  expect(observeTimeouts(modern.replace('now() >= this.endTime', 'false'))).toBeUndefined()
})
