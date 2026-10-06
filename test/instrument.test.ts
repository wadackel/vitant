import { describe, expect, it } from 'vitest'
import { instrument, RUNTIME_GLOBAL } from '../src/mutate/instrument.ts'
import { createRuntime } from '../src/session.ts'

function mutantsOf(source: string, filename = 'sample.ts') {
  const result = instrument(source, filename, { siteBase: 0, mutantBase: 0 })
  if (!result) throw new Error('parse failed')
  return result
}

const wrap = (body: string) => `function main() { ${body} }`

/** Runs `main` from the given code and returns what it produced, or a marker for a spinning loop. */
function evaluate(code: string, active: number, siteCount: number): unknown {
  const runtime = createRuntime(siteCount, 1000)
  runtime.a = active
  runtime.l = 10_000
  try {
    return new Function(RUNTIME_GLOBAL, `${code}; return main()`)(runtime)
  } catch (error) {
    return runtime.t ? endless : `threw ${(error as Error).constructor.name}`
  }
}

const endless = Symbol('endless loop')

const samples: Record<string, string> = {
  arithmetic: 'const f = (a, b) => a + b * 2 - (a % 3); return [f(1, 2), f(7, 5)]',
  comparison: 'const f = (a, b) => (a < b ? "lt" : a >= b ? "ge" : "?"); return [f(1, 2), f(2, 2), f(3, 2)]',
  logical: 'const f = (a, b) => (a && b) || (a ?? "none"); return [f(0, 1), f(1, 0), f(null, null)]',
  conditions: 'function f(n) { if (n > 2) { return "big" } else if (n === 2) return "two"; return "small" } return [f(1), f(2), f(3)]',
  loops: 'function f(n) { let t = 0; for (let i = 0; i < n; i++) { t += i } let j = n; while (j > 0) j--; do { t++ } while (t < 3); return t } return [f(0), f(4)]',
  strings: 'const f = (s) => `<${s.trim().toUpperCase()}>` + "!" + ""; return f("  ab ")',
  chains: 'const f = (o) => o?.items?.filter((x) => x > 1).slice(1).length ?? -1; return [f(null), f({ items: [1, 2, 3, 4] })]',
  objects: 'const f = (n) => ({ list: [n, -n], flag: !n, count: n++ }); return JSON.stringify([f(0), f(2)])',
  switches: 'function f(k) { let r = ""; switch (k) { case 1: r += "one"; case 2: r += "two"; break; default: r += "other" } return r } return [f(1), f(2), f(3)]',
  assignment: 'let a = 5; a += 2; a -= 1; a *= 3; a ||= 9; let b = null; b ??= a; return [a, b]',
  methodReceiver: 'const f = (a, b) => (a + b).trim().length; return f(" x", "y ")',
  this: 'const o = { v: 2, items: [3, 1, 2], get() { return this.items.sort().reverse()[0] + this.v } }; return o.get()',
  boolean: 'const f = (x) => (x === true ? false : !x); return [f(true), f(false), f(0)]',
  // `Object` handed on as a value: its method call is left in place and must keep its receiver.
  namespaceValue: 'const has = (k) => (Object.hasOwnProperty(k) ? 1 : 0); const o = Object; return [has("keys"), has("nope"), o === Object]',
  hoisted: 'function f(n) { var x; if (n > 1) return n; return typeof x; function x() {} } return [f(1), f(2)]',
}

describe('instrument', () => {
  for (const [name, body] of Object.entries(samples)) {
    const source = wrap(body)

    it(`keeps the original behaviour with no mutant active: ${name}`, () => {
      const result = mutantsOf(source, 'sample.js')
      expect(result.mutants.length).toBeGreaterThan(0)
      expect(evaluate(result.code, -1, result.siteCount)).toEqual(evaluate(source, -1, 0))
    })

    it(`switches to exactly the mutated source: ${name}`, () => {
      const result = mutantsOf(source, 'sample.js')
      for (const mutant of result.mutants) {
        const actual = evaluate(result.code, mutant.id, result.siteCount)
        // The plain mutated source has no loop guard and would never return.
        if (actual === endless) continue
        // Parentheses would cut an optional chain short, so chain mutations
        // and statements go in verbatim.
        const verbatim =
          ['BlockStatement', 'MethodExpression', 'OptionalChaining'].includes(mutant.mutator) ||
          /^(case|default)\b/.test(mutant.replacement)
        const replacement = verbatim ? mutant.replacement : `(${mutant.replacement})`
        const mutated = source.slice(0, mutant.start) + replacement + source.slice(mutant.end)
        expect(actual, `${mutant.mutator} -> ${mutant.replacement}`).toEqual(evaluate(mutated, -1, 0))
      }
    })
  }

  it('records which sites the original code evaluated', () => {
    const result = mutantsOf(wrap('const f = (a) => (a > 0 ? a + 1 : a - 1); return f(-1)'), 'sample.js')
    const runtime = createRuntime(result.siteCount, result.mutants.length)
    new Function(RUNTIME_GLOBAL, `${result.code}; return main()`)(runtime)
    const hit = new Set(result.mutants.filter((m) => runtime.h[m.site] === 1).map((m) => m.replacement))
    expect(hit).toContain('a + 1')
    expect(hit).not.toContain('a - 1')
  })

  it('keeps the name of an arrow function assigned to a variable', () => {
    const result = mutantsOf(wrap('const double = (n) => n * 2; return double.name'), 'sample.js')
    expect(evaluate(result.code, -1, result.siteCount)).toBe('double')
  })

  it('runs where a test has put an accessor on an index of Array.prototype', () => {
    const result = mutantsOf(wrap('const f = (a) => (Math.abs(a - 1) > 2 ? "far" : "near"); return f(1) + f(9)'), 'sample.js')
    Object.defineProperty(Array.prototype, '0', {
      set() {
        throw new Error('index setter')
      },
      configurable: true,
    })
    let value: unknown
    try {
      value = evaluate(result.code, -1, result.siteCount)
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)[0]
    }
    expect(value).toBe('nearfar')
  })

  it('records which mutants would have changed a value', () => {
    const body = 'const f = (a, b) => { if (a < b) { return a + b } return 0 }; return [f(1, 2), f(2, 9)]'
    const result = mutantsOf(wrap(body), 'sample.js')
    const runtime = createRuntime(result.siteCount, result.mutants.length)
    new Function(RUNTIME_GLOBAL, `${result.code}; return main()`)(runtime)
    const changed = (replacement: string) => {
      const mutant = result.mutants.find((m) => m.replacement === replacement)!
      expect(mutant.tracked, replacement).toBe(true)
      return runtime.i[mutant.id] === 1
    }
    // `a < b` held on every call and the operands never met.
    expect(changed('a <= b')).toBe(false)
    expect(changed('a >= b')).toBe(true)
    expect(changed('true')).toBe(false)
    expect(changed('false')).toBe(true)
    expect(changed('a - b')).toBe(true)
  })

  /** Runs `main` unmutated and tells, per replacement, whether its mutant was seen to change anything. */
  function probe(body: string) {
    const result = mutantsOf(wrap(body), 'sample.js')
    const runtime = createRuntime(result.siteCount, result.mutants.length)
    const value = new Function(RUNTIME_GLOBAL, `${result.code}; return main()`)(runtime)
    const changed = (replacement: string) => {
      const mutant = result.mutants.find((m) => m.replacement === replacement)!
      expect(mutant.tracked, replacement).toBe(true)
      return runtime.i[mutant.id] === 1
    }
    return { value, changed }
  }

  it('follows a changed value through enclosing arithmetic and Math calls', () => {
    const body =
      'const round = (v, p) => { const m = Math.pow(10, p); return Math.round((v + Number.EPSILON) * m) / m }; return round(1.23456, 2)'
    const { value, changed } = probe(body)
    expect(value).toBe(1.23)
    // The rounding hides which way the epsilon went.
    expect(changed('v - Number.EPSILON')).toBe(false)
    expect(changed('(v + Number.EPSILON) / m')).toBe(true)
    expect(changed('Math.round((v + Number.EPSILON) * m) * m')).toBe(true)
  })

  it('follows a replaced literal into the comparison that reads it', () => {
    const body = 'const f = (x) => (typeof x === "object" ? 1 : 2); return f(ARG)'
    expect(probe(body.replace('ARG', '3')).changed('""')).toBe(false)
    expect(probe(body.replace('ARG', '{}')).changed('""')).toBe(true)
  })

  it('only compares truthiness where a condition reads the value', () => {
    const { changed } = probe('const f = (a, b) => { if (a + b) return 1; return 0 }; return f(5, 2)')
    expect(changed('a - b')).toBe(false)
    expect(probe('const f = (a, b) => { if (a + b) return 1; return 0 }; return f(2, 2)').changed('a - b')).toBe(true)
  })

  it('tells negative zero from zero', () => {
    expect(probe('const f = (a, b) => a + b; return f(-0, 0)').changed('a - b')).toBe(true)
  })

  it('does not convert an object a second time', () => {
    const { value, changed } = probe(
      'let n = 0; const o = { valueOf() { n++; return 1 } }; const f = (a, b) => a + b; f(o, 1); return n',
    )
    expect(value).toBe(1)
    expect(changed('a - b')).toBe(true)
  })

  it('counts a mutant where the original throws', () => {
    const { changed } = probe('const f = (a, b) => { try { return a / b } catch { return 0n } }; return f(1n, 0n)')
    expect(changed('a * b')).toBe(true)
  })

  it('does not call a replaced Math function a second time', () => {
    const { value, changed } = probe(
      'const real = Math.round; let calls = 0; Math.round = (x) => { calls++; return real(x) }; ' +
        'try { const f = (a, b) => Math.round(a + b); f(1, 2) } finally { Math.round = real } return calls',
    )
    expect(value).toBe(1)
    expect(changed('a - b')).toBe(true)
  })

  it('does not clear a constant that drops an evaluation with effects', () => {
    const dropped = [
      'let n = 0; if (++n > 0) {} return n',
      'let n = 0; const f = () => n++; if (f() === 0) {} return n',
      'const o = { get x() { o.n = 1; return 1 }, n: 0 }; if (o.x === 1) {} return o.n',
      'const o = { n: 0, valueOf() { this.n++; return 1 } }; if (o > 0 && true) {} return o.n',
      'const o = { n: 0, valueOf() { this.n++; return 1 } }; if (o + 1 > 0 && true) {} return o.n',
      'class C { n = 0; get x() { this.n++; return true } } const o = new C(); if (o.x) {} return o.n',
      'class C { n = 0; get x() { this.n++; return { y: 1 } } } const o = new C(); if (o.x.y === 1) {} return o.n',
      'let n = 0; const o = new Proxy({ x: 1 }, { get(t, k) { n++; return t[k] } }); if (o.x === 1 && true) {} return n',
      'let n = 0; const k = { toString() { n++; return "x" } }; const o = { x: 1 }; if (o[k] === 1) {} return n',
      'let n = 0; const o = Object.create(new Proxy({}, { get() { n++; return 1 } })); if (o.x === 1) {} return n',
      'let n = 0; const f = (x) => { n++; return x }; const g = (a, b) => { if (a && f(b)) {} }; g(1, 1); return n',
      'let n = 0; const f = (x) => { n++; return x }; if (f(1 > 0 && true)) {} if (((c) => c)(n > 0 || f(0))) {} return n',
      'let n = 0; const o = { f() { n++; return true } }; if (o.f()) {} if (new Boolean(n++)) {} if (n++ > 0) {} if ((n += 1)) {} return n',
      'let n = 0; const real = Number.isFinite; Number.isFinite = (x) => { n++; return real(x) }; try { if (Number.isFinite(1) && true) {} } finally { Number.isFinite = real } return n',
      'let n = 0; const o = { valueOf() { n++; return 1 } }; if (Math.abs(o) > 0 && true) {} if (isNaN(o) || true) {} if (-o < 0 && true) {} return n',
      'let n = 0; const p = new Proxy({}, { has() { n++; return true } }); if ("x" in p) {} return n',
      'let n = 0; Object.defineProperty(globalThis, "vitantFlag", { configurable: true, get() { n++; return true } }); try { if (vitantFlag) {} } finally { delete globalThis.vitantFlag } return n',
      'let n = 0; Object.defineProperty(globalThis, "vitantFlag", { configurable: true, get() { n++; return 1 } }); try { if (vitantFlag === 1 && true) {} if (typeof vitantFlag === "number") {} } finally { delete globalThis.vitantFlag } return n',
    ]
    for (const body of dropped) {
      const result = mutantsOf(wrap(body), 'sample.js')
      const constants = result.mutants.filter((m) => m.mutator === 'ConditionalExpression')
      expect(constants.length, body).toBeGreaterThan(0)
      const runtime = createRuntime(result.siteCount, result.mutants.length)
      const original = new Function(RUNTIME_GLOBAL, `${result.code}; return main()`)(runtime)
      for (const mutant of constants) {
        if (evaluate(result.code, mutant.id, result.siteCount) === original) continue
        const cleared = mutant.tracked && runtime.i[mutant.id] === 0 && runtime.b[mutant.site] === 0
        expect(cleared, `${body}: ${mutant.replacement}`).toBe(false)
      }
    }
    const template = mutantsOf(wrap('let n = 0; const same = `${++n}` === "x"; return [n, same]'), 'sample.js')
    expect(template.mutants.find((m) => m.replacement === '``')!.tracked).toBe(false)
  })

  it('clears a constant over plain property reads and numeric operators when nothing changes', () => {
    const body =
      'const f = (p, o) => { if (p.length > 1 && p[0] + p[1] < o.limit.max) return 1; return 0 }; return f([1, 2], { limit: { max: 9 } })'
    const result = mutantsOf(wrap(body), 'sample.js')
    const runtime = createRuntime(result.siteCount, result.mutants.length)
    expect(new Function(RUNTIME_GLOBAL, `${result.code}; return main()`)(runtime)).toBe(1)
    const constants = result.mutants.filter((m) => m.replacement === 'true')
    expect(constants.length).toBeGreaterThan(1)
    for (const mutant of constants) {
      expect(mutant.tracked, `${mutant.start}`).toBe(true)
      expect(runtime.i[mutant.id], `${mutant.start}`).toBe(0)
      expect(runtime.b[mutant.site]).toBe(0)
    }
  })

  it('clears a constant over a call that did not run, and over built-ins that only compute', () => {
    const body =
      'let n = 0; const f = () => { n++; return true }; ' +
      'const g = (a, v) => { if (a && f()) return 1; if (typeof v === "number" && Number.isFinite(v) && Array.isArray([v]) && Math.abs(v) >= 0) return 2; return 0 }; return g(0, 3)'
    const result = mutantsOf(wrap(body), 'sample.js')
    const runtime = createRuntime(result.siteCount, result.mutants.length)
    expect(new Function(RUNTIME_GLOBAL, `${result.code}; return main()`)(runtime)).toBe(2)
    const cleared = result.mutants.filter(
      (m) => m.mutator === 'ConditionalExpression' && m.tracked && runtime.i[m.id] === 0 && runtime.b[m.site] === 0,
    )
    // `a && f()` with `false`, and the whole second condition and each of its parts with `true`.
    expect(cleared.map((m) => m.replacement)).toContain('false')
    expect(cleared.filter((m) => m.replacement === 'true').length).toBeGreaterThanOrEqual(4)
    for (const mutant of cleared) {
      expect(evaluate(result.code, mutant.id, result.siteCount), `${mutant.start} ${mutant.replacement}`).toBe(2)
    }
  })

  it('notices an evaluation that a constant would have kept from throwing', () => {
    const result = mutantsOf(wrap('let n = 0; try { if (missing) n = 1 } catch {} return n'), 'sample.js')
    const mutant = result.mutants.find((m) => m.replacement === 'true')!
    expect(mutant.tracked).toBe(true)
    const runtime = createRuntime(result.siteCount, result.mutants.length)
    expect(new Function(RUNTIME_GLOBAL, `${result.code}; return main()`)(runtime)).toBe(0)
    expect(runtime.i[mutant.id]).toBe(0)
    expect(runtime.b[mutant.site]).not.toBe(0)
    expect(evaluate(result.code, mutant.id, result.siteCount)).toBe(1)
  })

  it('does not rely on methods a test can replace', () => {
    for (const body of ['const f = (a, b) => a + b; return f(1, 1)', 'const f = (a, b) => Math.round(a + b); return f(1, 1)']) {
      const result = mutantsOf(wrap(body), 'sample.js')
      const mutant = result.mutants.find((m) => m.replacement === 'a - b')!
      const runtime = createRuntime(result.siteCount, result.mutants.length)
      const main = new Function(RUNTIME_GLOBAL, `${result.code}; return main`)(runtime)
      const push = Array.prototype.push
      const call = Math.round.call
      try {
        Array.prototype.push = () => 0
        ;(Math.round as { call: unknown }).call = () => 2
        main()
      } finally {
        Array.prototype.push = push
        Math.round.call = call
      }
      expect(runtime.i[mutant.id], body).toBe(1)
    }
  })

  it('never clears a mutant that changes the result', () => {
    const functions = [
      '(a, b, c) => Math.round((a + b) * c) / c',
      '(a, b, c) => (a - b > c ? a * b : a / c) + Math.max(a - b, c)',
      '(a, b, c) => Math.floor(a / b) * b === a - (a % b)',
      '(a, b, c) => (typeof a === "number") === (b + c >= 0)',
      '(a, b, c) => { let t = 0; for (let i = 0; i < a + b; i++) { if (i * c > b - 1) t += i } return t }',
      '(a, b, c) => Math.min(a + b, c) + "" === "1" ? a : -b * c',
      '(a, b, c) => Math.abs(a * b) - Math.sign(c - a) + (a < b === b < c ? 1 : 0)',
    ]
    const values = [0, -0, 1, -1, 2, 0.5, 2.5, 7, NaN, Infinity, 1e-17]
    for (const [index, fn] of functions.entries()) {
      const result = mutantsOf(`const f = ${fn}`, 'sample.js')
      const run = (active: number, args: number[]) => {
        const runtime = createRuntime(result.siteCount, result.mutants.length)
        runtime.a = active
        runtime.l = 10_000
        let value: unknown
        try {
          value = new Function(RUNTIME_GLOBAL, 'args', `${result.code}; return f(...args)`)(runtime, args)
        } catch (error) {
          value = `threw ${String(error)}`
        }
        return { value, runtime }
      }
      for (let seed = 0; seed < 150; seed++) {
        const args = [0, 1, 2].map((at) => values[(seed * (at * 7 + 3) + index + at) % values.length])
        const { value, runtime } = run(-1, args)
        for (const mutant of result.mutants) {
          if (!mutant.tracked || runtime.i[mutant.id] === 1) continue
          expect(run(mutant.id, args).value, `${fn} with ${args}, ${mutant.replacement}`).toStrictEqual(value)
        }
      }
    }
  })

  it('keeps statements apart in code written without semicolons', () => {
    const source = [
      'function main() {',
      '  const calls = []',
      '  const log = (value) => { calls.push(value) }',
      '  let n = 1',
      '  n > 0 && log("a")',
      '  const pair = [n, n + 1]',
      '  pair[0] < pair[1] ? log("b") : log("c")',
      '  switch (n) {',
      '    case 1:',
      '      n = 2',
      '      n > 1 && log("d")',
      '  }',
      '  return calls.join("")',
      '}',
    ].join('\n')
    const result = mutantsOf(source, 'sample.js')
    expect(evaluate(result.code, -1, result.siteCount)).toBe('abd')
  })

  it('does not take an object key inside a replaced condition for a name that is read', () => {
    const source = wrap(
      'const has = (input, options) => options.loose || input.length > 2; ' +
        'const loose = true; ' +
        'const f = (input) => { if (!has(input, { loose: false, strict: loose })) { return "no" } return "yes" }; ' +
        'return [f("a"), f("abc")]',
    )
    const result = mutantsOf(source)
    expect(evaluate(result.code, -1, result.siteCount)).toEqual(['no', 'yes'])
  })

  it('keeps a replaced logical operator apart from a nullish one next to it', () => {
    const source = wrap('const f = (a, b, c) => a ?? b ?? c; const g = (a, b, c) => (a || b) ?? c; return [f(null, 0, 1), g(0, null, 2)]')
    const result = mutantsOf(source)
    expect(evaluate(result.code, -1, result.siteCount)).toEqual([0, 2])
    const replacements = result.mutants.filter((m) => m.mutator === 'LogicalOperator').map((m) => m.replacement)
    expect(replacements).toContain('(a ?? b) && c')
    for (const mutant of result.mutants) {
      expect(evaluate(result.code, mutant.id, result.siteCount)).not.toBe('threw SyntaxError')
    }
  })

  it('leaves type positions, imports and directives alone', () => {
    const source = [
      '"use strict"',
      'import type { A } from "./a"',
      'type B = "x" | "y"',
      'declare const c: string',
      'enum E { One = 1 << 1 }',
      'export const d: Record<"k", boolean> = { k: true }',
    ].join('\n')
    const result = mutantsOf(source)
    expect(result.mutants.map((m) => m.mutator).sort()).toEqual(['BooleanLiteral', 'ObjectLiteral'])
  })

  it('does not empty a block that declares a var read after it', () => {
    const body = 'function f(n) { if (n) { var x = 1 } try { let y = n; x = y } catch {} return x } return f(2)'
    const blocks = mutantsOf(wrap(body), 'sample.js').mutants.filter((m) => m.mutator === 'BlockStatement')
    // The body of `main`, the body of `f`, and the `try` block, which declares nothing that outlives it.
    expect(blocks.map((m) => m.loc.start.column).length).toBe(3)
  })

  it('restricts mutants to the requested lines', () => {
    const source = 'export const a = 1 + 2\nexport const b = [\n  3 + 4,\n]\n'
    const result = instrument(source, 'sample.ts', { siteBase: 0, mutantBase: 0, lines: new Set([3]) })
    // The array literal starts on an unchanged line, so only what is inside line 3 counts.
    expect(result?.mutants.map((m) => m.replacement)).toEqual(['3 - 4'])
  })

  it('stops a loop that a mutant made endless', () => {
    const result = mutantsOf(wrap('let n = 0; for (let i = 0; i < 3; i++) { n++ } return n'), 'sample.js')
    const endless = result.mutants.find((m) => m.replacement === 'i--')!
    const runtime = createRuntime(result.siteCount, result.mutants.length)
    runtime.a = endless.id
    runtime.l = 1000
    expect(() => new Function(RUNTIME_GLOBAL, `${result.code}; return main()`)(runtime)).toThrow(/loop iteration limit/)
    expect(runtime.t).toBe(true)
  })
})
