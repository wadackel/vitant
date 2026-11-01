import { parseSync } from 'oxc-parser'
import { describe, expect, it } from 'vitest'
import { watchedBindings } from '../src/mutate/bindings.ts'
import { instrument, RUNTIME_GLOBAL } from '../src/mutate/instrument.ts'
import { placeReads, reexports, type WatchedModule } from '../src/mutate/reads.ts'
import { createRuntime } from '../src/session.ts'

const watched = (source: string) => [...watchedBindings(parseSync('m.ts', source).program).keys()]

describe('watched bindings', () => {
  it('takes initializers that can neither run code, throw nor do anything else', () => {
    const source = [
      `export const a = 'a'`,
      'const b = { x: a, y: [1, -2], f() { return run() }, g: () => run(), [`k${a}`]: a ?? null }',
      'export const c = typeof a === "string" ? `${a}!` : process.env.HOME',
      'const d = { ...b, e: /re/ }',
    ].join('\n')
    expect(watched(source)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('takes a property an earlier such object literal has as its own, checked as the module loads', () => {
    const source = 'const roles = { admin: "admin", user: "user" } as const\nconst rank = { [roles.admin]: 1, [roles["user"]]: 0 }\nconst list = [roles.admin]'
    expect(watched(source)).toEqual(['roles', 'rank', 'list'])
    expect(watchedBindings(parseSync('m.ts', source).program).get('rank')!.builtins).toBe(true)
    const prefix = 'const roles = { admin: "admin", nested: { a: 1 } }\n'
    // Not an own key, one `Object.prototype` has, a level further, or a value that is no primitive under a conversion.
    for (const other of ['roles.missing', 'roles.toString', 'roles.nested.a', '{ [roles.nested]: 1 }', 'roles?.admin']) {
      expect(watched(`${prefix}const a = ${other}`).includes('a'), other).toBe(false)
    }
  })

  it('takes a call of a function of the module that only returns an expression of its parameters', () => {
    const source = 'function f(type: string, opts?: object) { return { type, ...opts } }\nconst base = { kind: "x" }\nexport const schema = { id: f("id"), ref: f("id", { ref: "a" }) }'
    expect(watched(source)).toEqual(['base', 'schema'])
    // A parameter named after the argument it is given.
    expect(watched('const size = 10\nfunction double(size) { return size * 2 }\nconst a = double(size)')).toEqual(['size', 'a'])
    for (const other of [
      'function f(x) { return x + 1 }\nconst a = f({})',
      'function f(x) { run(); return x }\nconst a = f(1)',
      'function f(x) { return f(x) }\nconst a = f(1)',
      'function f(x) { return x }\nf = () => run()\nconst a = f(1)',
      'async function f(x) { return x }\nconst a = f(1)',
      'function f(...x) { return x }\nconst a = f(1)',
      // The second function's `b` is the module's, which has none.
      'function g() { return `${b}` }\nfunction f(b) { return g() }\nconst a = false ? f(1) : ""',
      // The argument is read where the call is: `big` there is the BigInt, not the parameter.
      'const big = 1n\nfunction f(big, b) { return +b }\nconst a = f(0, false ? big : 0)',
      'function f(x) { return x }\nfor (f of [() => run()]) {}\nconst a = f(1)',
      'function f(x) { return x }\nfunction f(x) { run(); return x }\nconst a = f(1)',
      'function f(x) { return x }\nvar f = () => run()\nconst a = f(1)',
    ]) {
      expect(watched(other).includes('a'), other).toBe(false)
    }
  })

  it('takes a value a function reads besides its parameters for one the binding is made from', () => {
    const source = 'const base = { kind: "x" }\nfunction f(type) { return { type, base } }\nconst schema = { id: f("id") }'
    expect(watchedBindings(parseSync('m.ts', source).program).get('schema')!.reads).toContain('base')
  })

  it('takes a Set, a Map or a frozen object of such values, which the module checks are the built-ins as it loads', () => {
    const source = ['const a = new Set(["x", "y"])', 'const b = new Map([["k", 1]])', 'const c = Object.freeze({ x: [1] })', 'const d = new Set()'].join('\n')
    expect(watched(source)).toEqual(['a', 'b', 'c', 'd'])
    expect(watchedBindings(parseSync('m.ts', source).program).get('a')!.builtins).toBe(true)
    // An empty list of pairs becomes `["Stryker was here"]`, which is no pair.
    for (const other of ['const a = new Map([])', 'import { Set } from "./s"; const a = new Set([1])', 'const a = new Set(list)', 'const a = new Map([pair])', 'const a = new Set([, 1])', 'const a = Object.freeze(x)']) {
      expect(watched(other).includes('a'), other).toBe(false)
    }
  })

  it('leaves out what may run code, throw or depend on more than the module', () => {
    const cases = [
      'const a = make()',
      'const a = other.value',
      'const a = "k" in {}',
      'const a = [...[1]]',
      // An object under an operator has its `valueOf` called.
      'const a = { valueOf() { return run() } } + 1',
      'const a = `${{}}`',
      // A spread of an object runs its getters.
      'const g = { get x() { return run() } }; const a = { ...g }',
      // Declared later: in its temporal dead zone.
      'const a = b; const b = 1',
      'let a = 1',
      'const a = class {}',
      'const a = imported',
      // A mutant can put a BigInt under an operator that throws on it: `+1n`.
      'const a = -1n',
    ]
    for (const source of cases) expect(watched(source).includes('a'), source).toBe(false)
  })
})

describe('placing reads', () => {
  const modules = new Map<string, WatchedModule>([['/p/m.ts', { exports: new Map([['A', [1]], ['B', [2]], ['default', [3]]]), all: [1, 2, 3] }]])
  const options = (own?: Map<string, number>) => ({
    own,
    resolve: async (specifier: string) => (specifier === './m' ? '/p/m.ts' : undefined),
    watched: async (file: string) => modules.get(file),
    everything: [1, 2, 9],
  })
  const place = (code: string, own?: Map<string, number>) => placeReads(code, '/p/x.ts', options(own))

  it('marks a read at the start of the function it is in, and at the top of the module outside one', async () => {
    expect(await place(`import { A } from './m'\nexport function f() { return A }\nexport const g = () => A`)).toBe(
      `import { A } from './m'\nexport function f() {__vitant__.h[1]=1; return A }\nexport const g = () => (__vitant__.h[1]=1,(A))`,
    )
    expect(await place(`import { B as b } from './m'\nconsole.log(b)`)).toBe(`__vitant__.h[2]=1;import { B as b } from './m'\nconsole.log(b)`)
    expect(await place(`import d from './m'\nconsole.log(d)`)).toBe(`__vitant__.h[3]=1;import d from './m'\nconsole.log(d)`)
  })

  it('marks a read in the parameters where they are evaluated, before the body', async () => {
    // Not at the top of the module: a function declared there can be called through an import cycle before that runs.
    expect(await place(`import { A } from './m'\nfunction f(x = A, { [A]: y } = {}) { return x }`)).toBe(
      `import { A } from './m'\nfunction f(x = (__vitant__.h[1]=1,(A)), { [(__vitant__.h[1]=1,(A))]: y } = {}) { return x }`,
    )
  })

  it('marks every binding of a module read other than by name', async () => {
    const all = /^__vitant__\.h\[1\]=__vitant__\.h\[2\]=__vitant__\.h\[3\]=1;/
    expect(await place(`import * as m from './m'\nconst copy = { ...m }`)).toMatch(all)
    expect(await place(`export * from './m'`)).toMatch(all)
    expect(await place(`vi.mock('./m', async (original) => ({ ...(await original()) }))`)).toMatch(all)
    expect(await place(`import * as m from './m'\nexport function f() { return m.B }`)).toContain('{__vitant__.h[2]=1; return m.B }')
  })

  it('marks every binding there is where what is loaded cannot be told', async () => {
    expect(await place('export const load = (name) => import(name)')).toContain('(__vitant__.h[1]=__vitant__.h[2]=__vitant__.h[9]=1,(')
    expect(await place('eval("A")')).toMatch(/^__vitant__\.h\[1\]=__vitant__\.h\[2\]=__vitant__\.h\[9\]=1;/)
    expect(await place('const at = "./m"\nconst real = await vi.importActual(at)')).toMatch(/^__vitant__\.h\[1\]=__vitant__\.h\[2\]=__vitant__\.h\[9\]=1;/)
  })

  it('takes reads inside the initializer of another watched binding for the value they make', async () => {
    const own = new Map([['A', 1], ['B', 2]])
    const code = `const A = 'a'\nexport const B = [A]\nexport { A }\nexport function f() { return B }`
    expect(await place(code, own)).toBe(`const A = 'a'\nexport const B = [A]\nexport { A }\nexport function f() {__vitant__.h[2]=1; return B }`)
  })

  it('follows a module that Vitest imports in place of the imports of a file that mocks one', async () => {
    const hoisted = 'const __vi_import_0__ = await import("./m");\nexport function f() { return __vi_import_0__.A }'
    expect(await place(hoisted)).toBe('const __vi_import_0__ = await import("./m");\nexport function f() {__vitant__.h[1]=1; return __vi_import_0__.A }')
    const wrapped = 'const __vi_import_0__ = await globalThis["__vitest_mocker__"].wrapDynamicImport(() => import("./m"));\nconsole.log(__vi_import_0__["B"])'
    expect(await place(wrapped)).toMatch(/^__vitant__\.h\[2\]=1;const __vi_import_0__/)
  })

  it('takes what a destructured import reads by the names it takes', async () => {
    const code = 'vi.mock("./x", async () => {\n  const { B, A: a } = await import("./m")\n  return { B }\n})'
    expect(await place(code)).toBe('vi.mock("./x", async () => {__vitant__.h[2]=__vitant__.h[1]=1;\n  const { B, A: a } = await import("./m")\n  return { B }\n})')
    expect(await place('const { ...rest } = await import("./m")')).toMatch(/^__vitant__\.h\[1\]=__vitant__\.h\[2\]=__vitant__\.h\[3\]=1;/)
  })

  it('checks that the built-ins a watched initializer calls are still those before it is evaluated', async () => {
    const code = 'export const A = 1\nexport const B = new Set([A])'
    expect(await placeReads(code, '/p/m.ts', { ...options(new Map([['A', 1], ['B', 2]])), checked: new Set(['B']) })).toBe(
      'export const A = 1\nif(!__vitant__.k())__vitant__.h[2]=1;export const B = new Set([A])',
    )
  })

  it('leaves a name a parameter binds alone', async () => {
    const code = `const label = 'x'\nexport const greeting = label\nexport function show(label, { label: other } = {}) { return label }`
    const placed = await place(code, new Map([['label', 1]]))
    expect(placed).toContain('export function show(label, { label: other } = {}) {__vitant__.h[1]=1; return label }')
  })

  it('takes a name bound to two modules in two scopes for both', async () => {
    const code = 'it("a", async () => { const mod = await import("./m"); mod.A })\nit("b", async () => { const mod = await import("./n"); mod.A })'
    const options2 = { ...options(), resolve: async (specifier: string) => ({ './m': '/p/m.ts', './n': '/p/n.ts' })[specifier], watched: async (file: string) => (file === '/p/n.ts' ? { exports: new Map([['A', [7]]]), all: [7] } : modules.get(file)) }
    const placed = await placeReads(code, '/p/x.ts', options2)
    expect(placed).toContain('async () => {__vitant__.h[1]=__vitant__.h[7]=1; const mod = await import("./m")')
  })

  it('keeps the directives of a function first', async () => {
    expect(await place(`import { A } from './m'\nfunction f() { 'use strict'; return A }`)).toContain(`{ 'use strict';__vitant__.h[1]=1; return A }`)
  })
})

describe('following what a module passes on', () => {
  const m: WatchedModule = { exports: new Map([['A', [1]], ['B', [2]]]), all: [1, 2] }
  const resolve = async (specifier: string) => ({ './m': '/p/m.ts', './n': '/p/n.ts' })[specifier]
  const watched = async (file: string) => (file === '/p/m.ts' ? m : undefined)

  it('maps a name passed on to the bindings it stands for', async () => {
    const barrel = await reexports("export { A as X } from './m'\nexport * from './m'\nimport { B } from './m'\nexport { B as Y }\nexport type { T } from './m'", 'b.ts', undefined, resolve, watched)
    expect([...barrel!.exports]).toEqual([['X', [1]], ['A', [1]], ['B', [2]], ['Y', [2]]])
    expect(barrel!.aliased).toEqual(new Set(['X', 'A', 'B', 'Y']))
    expect(await reexports("export { helper } from './n'", 'b.ts', undefined, resolve, watched)).toBeUndefined()
  })

  it('takes every name of a module whose names are not known to stand for every binding', async () => {
    const opaque = async () => ({ exports: new Map(), all: [1, 2, 9], opaque: true })
    const barrel = await reexports("export * from './m'", 'b.ts', undefined, resolve, opaque)
    expect(barrel!.opaque).toBe(true)
    const options = { resolve: async () => '/p/b.ts', watched: async () => barrel, everything: [1, 2, 9] }
    expect(await placeReads("import { Anything } from './b'\nexport const f = () => Anything", '/p/x.ts', options)).toContain('(__vitant__.h[1]=__vitant__.h[2]=__vitant__.h[9]=1,(Anything))')
  })

  it('takes the name a module exports under for no reference, as esbuild writes a re-export', async () => {
    const options = { resolve, watched, everything: [1, 2], aliased: new Set(['A']) }
    const code = "import { A } from './m'\nimport { A as A2 } from './m'\nexport function f() { return A }\nexport { A2 as A }"
    expect(await placeReads(code, '/p/b.ts', options)).toBe("import { A } from './m'\nimport { A as A2 } from './m'\nexport function f() {__vitant__.h[1]=1; return A }\nexport { A2 as A }")
  })

  it('leaves unmarked in the module itself only what importers follow', async () => {
    const options = { resolve, watched, everything: [1, 2], aliased: new Set(['X']) }
    expect(await placeReads("export { A as X, B } from './m'", '/p/b.ts', options)).toBe("__vitant__.h[2]=1;export { A as X, B } from './m'")
  })
})

describe('making a binding again once the module has loaded', () => {
  it('gives it the value the module makes with the mutant on from the start', () => {
    const source = [
      'const A = "a"',
      'function f(type, opts) { return { type, ...opts } }',
      'const B = { a: A, n: 1 + 2, list: [A, "b"], made: f("id", { ref: true }) }',
      'const C = new Set(["x", A])',
      'function main() { return JSON.stringify([A, B, [...C]]) }',
    ].join('\n')
    const result = instrument(source, 'm.js', { siteBase: 0, mutantBase: 0 })!
    const sites = result.siteCount + result.readSites
    const load = (active: number) => {
      const runtime = createRuntime(sites, 1000)
      runtime.a = active
      const main = new Function(RUNTIME_GLOBAL, `${result.code}; return main`)(runtime) as () => string
      return { runtime, main }
    }
    const remade = result.mutants.filter((mutant) => mutant.again)
    expect(remade.length).toBeGreaterThan(5)
    for (const mutant of remade) {
      const later = load(-1)
      later.runtime.a = mutant.id
      for (const site of mutant.again!) for (const remake of later.runtime.e[site]) remake()
      expect(later.main(), `${mutant.mutator} -> ${mutant.replacement}`).toBe(load(mutant.id).main())
    }
  })

  it('makes it again in every copy of the module loaded, as vi.resetModules can make two', () => {
    const result = instrument('const A = "a"\nfunction main() { return A }', 'm.js', { siteBase: 0, mutantBase: 0 })!
    const runtime = createRuntime(result.siteCount + result.readSites, 1000)
    const mains = [0, 1].map(() => new Function(RUNTIME_GLOBAL, `${result.code}; return main`)(runtime) as () => string)
    runtime.a = result.mutants[0].id
    for (const remake of runtime.e[result.mutants[0].again![0]]) remake()
    expect(mains.map((main) => main())).toEqual(['', ''])
  })

  it('is not offered for a binding the module assigns, or one made from process.env', () => {
    const offered = (source: string) => instrument(source, 'm.js', { siteBase: 0, mutantBase: 0 })!.mutants.some((mutant) => mutant.again)
    expect(offered('const A = "a"\nexport function f() { return A }')).toBe(true)
    expect(offered('const A = "a"\nexport function f() { A = "b" }')).toBe(false)
    expect(offered('const A = process.env.X ?? "a"\nexport function f() { return A }')).toBe(false)
    expect(offered('const A = "a", B = "b"\nexport function f() { return A + B }')).toBe(false)
    // An object a test or the module can change after it loaded: made again, the value would be made from what it holds then.
    const offeredOn = (source: string, line: number) => instrument(source, 'm.js', { siteBase: 0, mutantBase: 0 })!.mutants.some((mutant) => mutant.loc.start.line === line && mutant.again)
    expect(offeredOn('export const A = { n: 1 }\nexport const B = { m: A.n + 1 }\nexport function f() { return B }', 2)).toBe(false)
    expect(offeredOn('const A = { n: 1 }\nexport const B = { ...A, m: 2 }\nexport function f() { return B }', 2)).toBe(false)
    // One in `A` makes both again, from the start.
    expect(offeredOn('export const A = { n: 1 }\nexport const B = { m: A.n + 1 }\nexport function f() { return B }', 1)).toBe(true)
    expect(offered('const A = "a"\nexport const B = { m: A }\nexport function f() { return B }')).toBe(true)
  })
})
