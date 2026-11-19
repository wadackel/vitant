import { describe, expect, it } from 'vitest'
import { divergence, importedModules } from '../src/transformed.ts'

describe('importedModules', () => {
  it('reads declarations, re-exports and literal dynamic imports', () => {
    const code = [
      "import a from './a.js'",
      "import './side.js'",
      "export { b } from './b.js'",
      "export * from './c.js'",
      "const d = await import('./d.js')",
      'const e = await import(name)',
      'export const f = 1',
    ].join('\n')
    expect([...importedModules(code, 'x.ts')!].sort()).toEqual(['./a.js', './b.js', './c.js', './d.js', './side.js'])
  })

  it("reads the calls Vite's SSR transform puts in place of imports", () => {
    const code = [
      'const __vite_ssr_import_0__ = await __vite_ssr_import__("/src/a.ts", {importedNames:["a"]});',
      'const m = await __vite_ssr_dynamic_import__("/src/b.ts");',
      'Object.defineProperty(__vite_ssr_exports__, "f", { get(){ return f }});',
    ].join('\n')
    expect([...importedModules(code, 'x.ts')!].sort()).toEqual(['/src/a.ts', '/src/b.ts'])
  })

  it('reads nothing from code that does not parse', () => {
    expect(importedModules('import {', 'x.ts')).toBeUndefined()
  })
})

describe('divergence', () => {
  const source = "import { c as _c } from 'react/compiler-runtime'\nimport { useState } from 'react'\nexport function useX() {}"
  it('is none where both import the same modules, in any order and however often', () => {
    expect(divergence(source, "import { useState } from 'react'\nimport { c } from 'react/compiler-runtime'\nimport 'react'\nexport function useX() {}", 'x.ts')).toBeUndefined()
  })

  it('names the modules only one of them imports', () => {
    expect(divergence(source, "import { useState } from 'react'\nimport './extra.js'\nexport function useX() {}", 'x.ts')).toBe(
      "the project's plugins do not compile its instrumented code as they compile its source (only its source imports react/compiler-runtime; only its instrumented code imports ./extra.js), so its tests would not run the code the suite runs",
    )
  })

  it('names the first line of an error the plugins raise on the instrumented code', () => {
    expect(divergence(source, new Error('cannot compile\n  at somewhere'), 'x.ts')).toBe(
      "the project's plugins fail on its instrumented code and not on its source (cannot compile), so its tests would not run the code the suite runs",
    )
  })

  it('is none where either output does not parse', () => {
    expect(divergence(source, 'import {', 'x.ts')).toBeUndefined()
  })
})
