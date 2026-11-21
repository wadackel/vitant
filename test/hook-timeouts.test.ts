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

function fixture(text = source) {
  const events: string[] = []
  let timer: () => void = () => {}
  let clock = 0
  let deadline: () => boolean = () => false
  const observed = observeTimeouts(text)
  expect(observed).toBeDefined()
  const wrap = vm.runInNewContext(observed!, {
    Date: { now: () => clock },
    setTimeout(fn: (...args: unknown[]) => void, ms: number, ...rest: unknown[]) {
      events.push(`timer:${ms}`)
      if (ms === 0) void Promise.resolve().then(() => fn(...rest))
      else timer = fn
      return 1
    },
    clearTimeout() {},
    makeTimeoutMsg: () => 'deadline',
    __vitant_hook: {
      patched: false,
      start(timeout: number) {
        events.push(`scope:${timeout}`)
        return {
          run(fn: () => unknown) { events.push('run'); return fn() },
          start(exceeded: () => boolean) { expect(exceeded()).toBe(false); deadline = exceeded; events.push('start') },
          end() { events.push('end') },
        }
      },
    },
  }) as (fn: (...args: unknown[]) => unknown, timeout: number, hook?: boolean) => (...args: unknown[]) => Promise<unknown>
  return { events, wrap, expire: () => timer(), advance: (ms: number) => { clock += ms }, exceeded: () => deadline() }
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
  expect(observeTimeouts(modern.replace('{ rejectTimeoutError(); return }', '{ reject_(new Error(makeTimeoutMsg(isHook, timeout))); return }'))).toBeUndefined()
})

// Vitest 3.0.4 to 3.0.8 reject a late return from `resolve` itself.
const early = source
  .replace('{ rejectTimeoutError(); return }', '{ reject_(new Error(makeTimeoutMsg(isHook, timeout))); return }')
  .replace("function rejectTimeoutError() { reject_(new Error('deadline')) }", 'function rejectTimeoutError() { reject(new Error(makeTimeoutMsg(isHook, timeout))) }')

it('observes the elapsed check that rejects from resolve, as Vitest 3.0.4 to 3.0.8 have it', async () => {
  const late = fixture(early)
  await expect(late.wrap(() => { late.advance(150); expect(late.exceeded()).toBe(true) }, 100, true)()).rejects.toThrow('deadline')
  expect(late.events).toEqual(['scope:100', 'run', 'timer:100', 'start', 'end'])
  const { events, wrap } = fixture(early)
  expect(await wrap(() => 5, 100, true)()).toBe(5)
  expect(events).toEqual(['scope:100', 'run', 'timer:100', 'start', 'end'])
})

it('refuses an early rejection that is not the timeout or not the only one in resolve', () => {
  expect(observeTimeouts(early.replace('{ reject_(new Error(makeTimeoutMsg(isHook, timeout))); return }', "{ reject_(new Error('late')); return }"))).toBeUndefined()
  expect(observeTimeouts(early.replace('resolve_(value) }', 'reject_(value) }'))).toBeUndefined()
  expect(observeTimeouts(early.replace('resolve_(value) }', 'resolve_(value); reject_(value) }'))).toBeUndefined()
})

// Vitest 3.0.2 and 3.0.3 check the clock only once a thenable result settles.
const thenable = source
  .replace('if (now() - startTime >= timeout) { rejectTimeoutError(); return }; ', '')
  .replace("if (typeof result === 'object' && result !== null && typeof result.then === 'function') result.then(resolve, reject)",
    `if (typeof result === 'object' && result !== null && typeof result.then === 'function') {
          result.then((value) => { if (now() - startTime >= timeout) { reject(new Error(makeTimeoutMsg(isHook, timeout))) } else { resolve(value) } }, reject)
        }`)
  .replace('else resolve(result)', 'else { resolve(result) }')

it('observes a hook that Vitest 3.0.2 and 3.0.3 check only for a thenable result, and never calls it late while it runs', async () => {
  const late = fixture(thenable)
  await expect(late.wrap(() => { late.advance(150); expect(late.exceeded()).toBe(false); return Promise.resolve(1) }, 100, true)()).rejects.toThrow('deadline')
  expect(late.events).toEqual(['scope:100', 'run', 'timer:100', 'start', 'end'])
  const sync = fixture(thenable)
  expect(await sync.wrap(() => { sync.advance(150); return 2 }, 100, true)()).toBe(2)
  expect(sync.events).toEqual(['scope:100', 'run', 'timer:100', 'start', 'end'])
  expect(observeTimeouts(thenable.replace('>= timeout) { reject(', '>= 0) { reject('))).toBeUndefined()
  expect(observeTimeouts(thenable.replace('} else { resolve(value) }', '} else { resolve_(value) }'))).toBeUndefined()
  expect(observeTimeouts(thenable.replace('reject(new Error(makeTimeoutMsg(isHook, timeout)))', 'resolve(value)'))).toBeUndefined()
  expect(observeTimeouts(thenable.replace('catch (error) { reject(error) }', 'catch (error) { resolve(error) }'))).toBeUndefined()
  expect(observeTimeouts(thenable.replace('else { resolve(result) }', 'else { resolve(result); resolve(result) }'))).toBeUndefined()
})

// Vitest 3.0.0 and 3.0.1 race the call against a timer that is never cleared.
const race = `
const now = Date.now
function withTimeout(fn, timeout, isHook = false) {
  if (timeout <= 0 || timeout === Infinity) return fn
  return function runWithTimeout(...args) {
    return Promise.race([
      new Promise((resolve, reject) => {
        var _a;
        const timer = setTimeout(() => {
          clearTimeout(timer);
          reject(new Error(makeTimeoutMsg(isHook, timeout)));
        }, timeout);
        (_a = timer.unref) == null ? void 0 : _a.call(timer);
      }),
      Promise.resolve(fn(...args)).then((result) => {
        return new Promise((resolve) => setTimeout(resolve, 0, result));
      })
    ]);
  };
}
withTimeout
`

it('observes the timer race of Vitest 3.0.0 and 3.0.1, ending as the result arrives or the timer fires', async () => {
  const { events, wrap, advance, exceeded } = fixture(race)
  expect(await wrap((value) => { advance(150); expect(exceeded()).toBe(false); return value }, 100, true)(3)).toBe(3)
  expect(events).toEqual(['scope:100', 'run', 'timer:100', 'start', 'end', 'timer:0'])
  const pending = fixture(race)
  const promise = pending.wrap(() => new Promise(() => {}), 100, true)()
  pending.expire()
  await expect(promise).rejects.toThrow('deadline')
  expect(pending.events).toEqual(['scope:100', 'run', 'timer:100', 'start', 'end'])
  const rejected = fixture(race)
  const error = new Error('original')
  await expect(rejected.wrap(() => Promise.reject(error), 100, true)()).rejects.toBe(error)
  expect(rejected.events).toEqual(['scope:100', 'run', 'timer:100', 'start', 'end'])
  const body = fixture(race)
  expect(await body.wrap(() => 4, 100, false)()).toBe(4)
  expect(body.events).toEqual(['timer:100', 'timer:0'])
})

it('refuses a timer race with another timer, call or settlement', () => {
  expect(observeTimeouts(race.replace('}, timeout);', '}, 0);'))).toBeUndefined()
  expect(observeTimeouts(race.replace('Promise.resolve(fn(...args))', 'Promise.resolve(fn.apply(null, args))'))).toBeUndefined()
  expect(observeTimeouts(race.replace('(_a = timer.unref)', 'resolve(); (_a = timer.unref)'))).toBeUndefined()
  expect(observeTimeouts(race.replace('setTimeout(resolve, 0, result)', 'setTimeout(resolve, 1, result)'))).toBeUndefined()
  expect(observeTimeouts(race.replace('reject(new Error(makeTimeoutMsg(isHook, timeout)))', 'reject(new Error())'))).toBeUndefined()
  expect(observeTimeouts(race.replace('return Promise.race', 'timeout = 1; return Promise.race'))).toBeUndefined()
  expect(observeTimeouts(race.replace('(_a = timer.unref)', 'throw new Error(); (_a = timer.unref)'))).toBeUndefined()
})
